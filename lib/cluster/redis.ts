// A small Redis client (RESP2 over TCP or TLS) for cluster mode: commands,
// Lua scripts and pub/sub – what lib/cluster needs, no more. Written here
// rather than added as a dependency, as lib/storage.ts signs its own S3
// requests: a few hundred lines we can read, nothing to bundle.
//
//   const redis = new RedisClient("redis://:secret@redis:6379/0");
//   await redis.command("SET", "k", "v", "PX", "5000");
//   const sub = new RedisClient(url, { subscriber: true });
//   sub.subscribe("channel", (message) => …);
//
// A connection that drops is opened again with a growing pause (up to 5 s);
// commands sent meanwhile wait for it until their timeout, commands in flight
// when it dropped fail. A subscriber subscribes again after reconnecting.
import net from "node:net";
import tls from "node:tls";

export type RedisValue = string | number | null | RedisValue[];
export class RedisError extends Error {}

type Pending = { resolve: (value: RedisValue) => void; reject: (error: Error) => void; timer?: ReturnType<typeof setTimeout> };
type Options = {
  subscriber?: boolean;
  // Per command, ms (default 5 s).
  timeout?: number;
  // Name in CLIENT LIST.
  name?: string;
  onError?: (error: Error) => void;
};

export type RedisTarget = { host: string; port: number; tls: boolean; username?: string; password?: string; db: number };
export function parseRedisUrl(url: string): RedisTarget {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("REDIS_URL is not a URL (redis://[user:password@]host:port/db or rediss://…)");
  }
  if (parsed.protocol !== "redis:" && parsed.protocol !== "rediss:")
    throw new Error("REDIS_URL must start with redis:// or rediss:// (TLS)");
  const db = Number(parsed.pathname.replace(/^\//, "") || 0);
  if (!Number.isInteger(db) || db < 0) throw new Error("REDIS_URL: the database (path) must be a number");
  return {
    host: parsed.hostname.replace(/^\[|\]$/g, "") || "localhost",
    port: Number(parsed.port) || 6379,
    tls: parsed.protocol === "rediss:",
    username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    db,
  };
}

// Incremental RESP2 parser: returns the value and where it ended, or null
// while the buffer does not hold a whole reply yet.
export function parseReply(buffer: Buffer, start = 0): { value: RedisValue | RedisError; end: number } | null {
  if (start >= buffer.length) return null;
  const line = buffer.indexOf("\r\n", start);
  if (line < 0) return null;
  const type = String.fromCharCode(buffer[start]);
  const text = buffer.toString("utf8", start + 1, line);
  const next = line + 2;
  switch (type) {
    case "+":
      return { value: text, end: next };
    case "-":
      return { value: new RedisError(text), end: next };
    case ":":
      return { value: Number(text), end: next };
    case "$": {
      const length = Number(text);
      if (length < 0) return { value: null, end: next };
      if (buffer.length < next + length + 2) return null;
      return { value: buffer.toString("utf8", next, next + length), end: next + length + 2 };
    }
    case "*": {
      const count = Number(text);
      if (count < 0) return { value: null, end: next };
      const items: RedisValue[] = [];
      let at = next;
      for (let i = 0; i < count; i++) {
        const item = parseReply(buffer, at);
        if (!item) return null;
        // An error inside an array (EXEC, scripts) stays a value there.
        items.push(item.value instanceof RedisError ? item.value.message : item.value);
        at = item.end;
      }
      return { value: items, end: at };
    }
    default:
      throw new RedisError(`Unexpected reply from Redis (type ${JSON.stringify(type)})`);
  }
}

export function encodeCommand(args: (string | number)[]): Buffer {
  const parts: Buffer[] = [Buffer.from(`*${args.length}\r\n`)];
  for (const arg of args) {
    const value = Buffer.from(String(arg));
    parts.push(Buffer.from(`$${value.length}\r\n`), value, Buffer.from("\r\n"));
  }
  return Buffer.concat(parts);
}

export class RedisClient {
  readonly target: RedisTarget;
  private socket: net.Socket | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private pending: Pending[] = [];
  private waiting: (() => void)[] = [];
  private ready = false;
  private closed = false;
  private attempt = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private channels = new Map<string, Set<(message: string) => void>>();
  private connecting: Promise<void> | null = null;
  lastError: string | null = null;

  constructor(
    url: string,
    private options: Options = {},
  ) {
    this.target = parseRedisUrl(url);
  }

  get connected() {
    return this.ready;
  }

  // Opens the connection (also done by the first command).
  connect(): Promise<void> {
    if (this.ready) return Promise.resolve();
    if (this.closed) return Promise.reject(new RedisError("Redis client closed"));
    return (this.connecting ??= new Promise<void>((resolve, reject) => {
      const timeout = this.options.timeout ?? 5000;
      const timer = setTimeout(() => {
        this.connecting = null;
        reject(new RedisError(`Redis: no connection to ${this.target.host}:${this.target.port} within ${timeout} ms`));
      }, timeout);
      timer.unref?.();
      this.waiting.push(() => {
        clearTimeout(timer);
        resolve();
      });
      if (!this.socket) this.open();
    }));
  }

  private open() {
    const { host, port } = this.target;
    const socket = this.target.tls ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
    this.socket = socket;
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 30_000);
    // Neither a subscriber nor an idle client keeps the process alive.
    socket.unref();
    this.buffer = Buffer.alloc(0);
    socket.once(this.target.tls ? "secureConnect" : "connect", () => void this.handshake(socket));
    socket.on("data", (chunk: Buffer) => this.receive(chunk));
    socket.on("error", (error) => {
      this.lastError = error.message;
      this.options.onError?.(error);
    });
    socket.on("close", () => this.dropped(socket));
  }

  private async handshake(socket: net.Socket) {
    try {
      const { username, password, db } = this.target;
      if (password) await this.send(username ? ["AUTH", username, password] : ["AUTH", password], true);
      if (db) await this.send(["SELECT", db], true);
      if (this.options.name) await this.send(["CLIENT", "SETNAME", this.options.name], true).catch(() => {});
      for (const channel of this.channels.keys()) socket.write(encodeCommand(["SUBSCRIBE", channel]));
      this.ready = true;
      this.attempt = 0;
      this.lastError = null;
      this.connecting = null;
      for (const resolve of this.waiting.splice(0)) resolve();
    } catch (error) {
      this.lastError = (error as Error).message;
      this.options.onError?.(error as Error);
      socket.destroy();
    }
  }

  private dropped(socket: net.Socket) {
    if (this.socket !== socket) return;
    this.socket = null;
    this.ready = false;
    for (const job of this.pending.splice(0)) {
      if (job.timer) clearTimeout(job.timer);
      job.reject(new RedisError(`Redis connection lost${this.lastError ? `: ${this.lastError}` : ""}`));
    }
    if (this.closed) return;
    const pause = Math.min(5000, 100 * 2 ** this.attempt++);
    this.reconnectTimer = setTimeout(() => {
      if (!this.closed && !this.socket) this.open();
    }, pause);
    this.reconnectTimer.unref?.();
  }

  private receive(chunk: Buffer) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    let at = 0;
    for (;;) {
      let reply;
      try {
        reply = parseReply(this.buffer, at);
      } catch (error) {
        this.lastError = (error as Error).message;
        this.socket?.destroy();
        return;
      }
      if (!reply) break;
      at = reply.end;
      this.dispatch(reply.value);
    }
    this.buffer = at >= this.buffer.length ? Buffer.alloc(0) : this.buffer.subarray(at);
  }

  private dispatch(value: RedisValue | RedisError) {
    // Pushed messages of a subscriber; the confirmations need no answer.
    if (this.options.subscriber && Array.isArray(value)) {
      const [kind, channel, message] = value as string[];
      if (kind === "message") {
        for (const handler of this.channels.get(channel) ?? [])
          try {
            handler(message);
          } catch (error) {
            console.error("Redis: subscriber failed", error);
          }
        return;
      }
      if (kind === "subscribe" || kind === "unsubscribe" || kind === "pong") {
        if (kind === "pong") this.pending.shift()?.resolve("PONG");
        return;
      }
    }
    const job = this.pending.shift();
    if (!job) return;
    if (job.timer) clearTimeout(job.timer);
    if (value instanceof RedisError) job.reject(value);
    else job.resolve(value);
  }

  // Writes a command; `early` is for the handshake (before ready).
  private send(args: (string | number)[], early = false): Promise<RedisValue> {
    return new Promise<RedisValue>((resolve, reject) => {
      if (!this.socket || (!early && !this.ready)) return reject(new RedisError("Redis not connected"));
      const job: Pending = { resolve, reject };
      const timeout = this.options.timeout ?? 5000;
      job.timer = setTimeout(() => {
        // The reply may still come: the connection starts afresh so later
        // replies are not handed to the wrong command.
        reject(new RedisError(`Redis: no answer to ${String(args[0])} within ${timeout} ms`));
        this.socket?.destroy();
      }, timeout);
      job.timer.unref?.();
      this.pending.push(job);
      this.socket.write(encodeCommand(args));
    });
  }

  // One command; waits for the connection if it is being (re)opened.
  async command(...args: (string | number)[]): Promise<RedisValue> {
    if (this.options.subscriber && !/^(PING)$/i.test(String(args[0]))) throw new RedisError("A subscriber connection only subscribes");
    if (!this.ready) await this.connect();
    return this.send(args);
  }

  // A Lua script (EVAL; scripts here are short and few, no SHA cache).
  eval(script: string, keys: string[], args: (string | number)[]) {
    return this.command("EVAL", script, keys.length, ...keys, ...args);
  }

  async subscribe(channel: string, handler: (message: string) => void) {
    if (!this.options.subscriber) throw new RedisError("Subscribe on a client made with { subscriber: true }");
    let handlers = this.channels.get(channel);
    if (!handlers) {
      handlers = new Set();
      this.channels.set(channel, handlers);
      if (this.ready) this.socket?.write(encodeCommand(["SUBSCRIBE", channel]));
    }
    handlers.add(handler);
    await this.connect();
    return () => {
      handlers.delete(handler);
      if (!handlers.size) {
        this.channels.delete(channel);
        if (this.ready) this.socket?.write(encodeCommand(["UNSUBSCRIBE", channel]));
      }
    };
  }

  async close() {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const socket = this.socket;
    this.ready = false;
    if (!socket) return;
    await new Promise<void>((resolve) => {
      socket.once("close", () => resolve());
      try {
        socket.end(encodeCommand(["QUIT"]));
      } catch {}
      setTimeout(() => socket.destroy(), 500).unref?.();
    });
  }
}
