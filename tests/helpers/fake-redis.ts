// A minimal in-process Redis double for tests/cluster.test.ts when no real
// Redis is given (FLOWPLAN_TEST_REDIS_URL): the RESP protocol over TCP with
// the commands lib/cluster uses – PING, AUTH, SELECT, CLIENT, QUIT, INFO,
// PUBLISH/SUBSCRIBE/UNSUBSCRIBE, HSET/HGETALL/HDEL, ZREM/ZCARD, and EVAL of
// the rate limit's sliding window and the AI slots' scripts (recognised by
// their text, run in JavaScript). Not a
// Redis: the real one is tested with FLOWPLAN_TEST_REDIS_URL (CI's postgres job).
import net from "node:net";
import { encodeCommand, parseReply } from "../../lib/cluster/redis";

type Reply = string | number | null | Reply[] | { error: string } | { simple: string };
function encode(value: Reply): string {
  if (value === null) return "$-1\r\n";
  if (typeof value === "number") return `:${value}\r\n`;
  if (typeof value === "string") return `$${Buffer.byteLength(value)}\r\n${value}\r\n`;
  if (Array.isArray(value)) return `*${value.length}\r\n${value.map(encode).join("")}`;
  if ("error" in value) return `-${value.error}\r\n`;
  return `+${value.simple}\r\n`;
}

export async function startFakeRedis(port = 0) {
  const hashes = new Map<string, Map<string, string>>();
  const zsets = new Map<string, { score: number; member: string }[]>();
  const subscribers = new Map<string, Set<net.Socket>>();
  const sockets = new Set<net.Socket>();
  const OK = { simple: "OK" };

  function run(socket: net.Socket, args: string[]): Reply | undefined {
    const name = args[0].toUpperCase();
    switch (name) {
      case "PING":
        return { simple: "PONG" };
      case "AUTH":
      case "SELECT":
      case "CLIENT":
        return OK;
      case "QUIT":
        socket.end(encode(OK));
        return undefined;
      case "INFO":
        return "# Server\r\nredis_version:0.0.0-fake\r\n";
      case "PUBLISH": {
        const listeners = subscribers.get(args[1]) ?? new Set();
        for (const s of listeners) s.write(encode(["message", args[1], args[2]]));
        return listeners.size;
      }
      case "SUBSCRIBE":
      case "UNSUBSCRIBE": {
        for (const channel of args.slice(1)) {
          let set = subscribers.get(channel);
          if (!set) subscribers.set(channel, (set = new Set()));
          if (name === "SUBSCRIBE") set.add(socket);
          else set.delete(socket);
          socket.write(encode([name.toLowerCase(), channel, 1]));
        }
        return undefined;
      }
      case "HSET": {
        let hash = hashes.get(args[1]);
        if (!hash) hashes.set(args[1], (hash = new Map()));
        let added = 0;
        for (let i = 2; i < args.length; i += 2) {
          if (!hash.has(args[i])) added++;
          hash.set(args[i], args[i + 1]);
        }
        return added;
      }
      case "HGETALL":
        return [...(hashes.get(args[1]) ?? new Map())].flat();
      case "HDEL": {
        const hash = hashes.get(args[1]);
        let removed = 0;
        for (const field of args.slice(2)) if (hash?.delete(field)) removed++;
        return removed;
      }
      case "ZREM": {
        const list = zsets.get(args[1]) ?? [];
        const left = list.filter((e) => !args.slice(2).includes(e.member));
        zsets.set(args[1], left);
        return list.length - left.length;
      }
      case "ZCARD":
        return (zsets.get(args[1]) ?? []).length;
      case "EVAL": {
        const [, script, , key, now, window, max, member] = args;
        // The parallel AI answers (lib/ai/concurrency.ts): entries scored by
        // the time they lapse.
        if (script.startsWith("-- ai-slot take")) {
          const list = (zsets.get(key) ?? []).filter((e) => e.score > Number(now));
          zsets.set(key, list);
          if (list.length >= Number(max)) return 0;
          list.push({ score: Number(now) + Number(window), member });
          return 1;
        }
        if (script.startsWith("-- ai-slot renew")) {
          const entry = (zsets.get(key) ?? []).find((e) => e.member === window);
          if (entry) entry.score = Number(now);
          return 1;
        }
        if (!script.includes("ZREMRANGEBYSCORE")) return { error: "ERR fake Redis knows only the rate limit script" };
        const list = (zsets.get(key) ?? []).filter((e) => e.score > Number(now) - Number(window));
        list.push({ score: Number(now), member });
        list.sort((a, b) => a.score - b.score);
        zsets.set(key, list);
        if (list.length < Number(max)) return 0;
        return list[list.length - Number(max)].score + Number(window);
      }
      default:
        return { error: `ERR unknown command '${name}'` };
    }
  }

  const server = net.createServer((socket) => {
    sockets.add(socket);
    let buffer: Buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      let at = 0;
      for (;;) {
        const parsed = parseReply(buffer, at);
        if (!parsed) break;
        at = parsed.end;
        const reply = run(socket, (parsed.value as string[]).map(String));
        if (reply !== undefined) socket.write(encode(reply));
      }
      buffer = buffer.subarray(at);
    });
    socket.on("close", () => {
      sockets.delete(socket);
      for (const set of subscribers.values()) set.delete(socket);
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const bound = (server.address() as net.AddressInfo).port;
  return {
    url: `redis://127.0.0.1:${bound}/0`,
    port: bound,
    // Drops every connection (clients reconnect), as a Redis restart would.
    dropConnections() {
      for (const socket of sockets) socket.destroy();
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
// (Re-exported for symmetry with the client; tests may build raw commands.)
export { encodeCommand };
