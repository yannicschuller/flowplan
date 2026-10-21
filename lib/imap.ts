// A minimal IMAP4rev1 client for the inbound mailbox (lib/inbound-mail.ts):
// LOGIN, SELECT, UID SEARCH UNSEEN, UID FETCH BODY.PEEK[], UID STORE \Seen
// and LOGOUT over TLS (or plain TCP for tests and local servers). No IDLE,
// no extensions; the worker polls every two minutes.
import { connect as tlsConnect } from "node:tls";
import { connect as netConnect, type Socket } from "node:net";

export type ImapOptions = {
  host: string;
  port: number;
  user: string;
  password: string;
  tls?: boolean;
  timeoutMs?: number;
};
// One response line from the server with its literals ({n} blocks).
type Response = { text: string; literals: Buffer[] };

// IMAP quoted string: backslash and quote escaped, no line breaks.
export const quote = (value: string) => `"${value.replace(/[\r\n]/g, "").replace(/(["\\])/g, "\\$1")}"`;

export class ImapClient {
  private socket: Socket | null = null;
  private buffer = Buffer.alloc(0);
  private pending: Response = { text: "", literals: [] };
  private literal = -1;
  private waiting: ((r: Response | Error) => void) | null = null;
  private queue: (Response | Error)[] = [];
  private tag = 0;

  constructor(private options: ImapOptions) {}

  async connect() {
    const { host, port, tls = true, timeoutMs = 30_000 } = this.options;
    const socket = await new Promise<Socket>((resolve, reject) => {
      const s: Socket = tls
        ? tlsConnect({ host, port, servername: host }, () => resolve(s))
        : netConnect({ host, port }, () => resolve(s));
      s.once("error", reject);
    });
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error("IMAP timeout")));
    socket.on("data", (chunk: Buffer) => this.receive(chunk));
    socket.on("error", (error) => this.push(error));
    socket.on("close", () => this.push(new Error("IMAP connection closed")));
    this.socket = socket;
    const greeting = await this.next();
    if (!/^\* (OK|PREAUTH)/i.test(greeting.text)) throw new Error(`IMAP greeting: ${greeting.text.slice(0, 200)}`);
  }

  private push(item: Response | Error) {
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w(item);
    } else this.queue.push(item);
  }
  private next(): Promise<Response> {
    const item = this.queue.shift();
    if (item) return item instanceof Error ? Promise.reject(item) : Promise.resolve(item);
    return new Promise((resolve, reject) => {
      this.waiting = (r) => (r instanceof Error ? reject(r) : resolve(r));
    });
  }

  // Splits the stream into lines, reading {n} literals as raw bytes.
  private receive(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.literal >= 0) {
        if (this.buffer.length < this.literal) return;
        this.pending.literals.push(this.buffer.subarray(0, this.literal));
        this.pending.text += `{${this.pending.literals.length - 1}}`;
        this.buffer = this.buffer.subarray(this.literal);
        this.literal = -1;
        continue;
      }
      const end = this.buffer.indexOf("\r\n");
      if (end === -1) return;
      const line = this.buffer.subarray(0, end).toString("utf8");
      this.buffer = this.buffer.subarray(end + 2);
      const m = line.match(/\{(\d+)\}$/);
      if (m) {
        this.pending.text += line.slice(0, -m[0].length);
        this.literal = Number(m[1]);
        continue;
      }
      this.pending.text += line;
      const done = this.pending;
      this.pending = { text: "", literals: [] };
      this.push(done);
    }
  }

  // Sends a command; resolves with the untagged answers once tagged OK.
  async command(text: string) {
    if (!this.socket) throw new Error("IMAP not connected");
    const tag = `F${++this.tag}`;
    this.socket.write(`${tag} ${text}\r\n`);
    const untagged: Response[] = [];
    for (;;) {
      const r = await this.next();
      if (r.text.startsWith(`${tag} `)) {
        if (!/^\S+ OK/i.test(r.text)) throw new Error(`IMAP ${text.split(" ")[0]}: ${r.text.slice(tag.length + 1, 300)}`);
        return untagged;
      }
      if (r.text.startsWith("+")) continue;
      untagged.push(r);
    }
  }

  async login() {
    await this.command(`LOGIN ${quote(this.options.user)} ${quote(this.options.password)}`);
  }
  async select(folder = "INBOX") {
    await this.command(`SELECT ${quote(folder)}`);
  }
  async searchUnseen(): Promise<number[]> {
    const answers = await this.command("UID SEARCH UNSEEN");
    return answers
      .filter((r) => /^\* SEARCH/i.test(r.text))
      .flatMap((r) => r.text.replace(/^\* SEARCH/i, "").trim().split(/\s+/))
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0);
  }
  // The whole message without setting \Seen.
  async fetchMessage(uid: number): Promise<Buffer | null> {
    const answers = await this.command(`UID FETCH ${uid} (BODY.PEEK[])`);
    const hit = answers.find((r) => /FETCH/i.test(r.text) && r.literals.length);
    return hit ? hit.literals[0] : null;
  }
  async markSeen(uid: number) {
    await this.command(`UID STORE ${uid} +FLAGS.SILENT (\\Seen)`);
  }
  async logout() {
    try {
      await this.command("LOGOUT");
    } catch {
      // The server may close before answering.
    }
    this.socket?.destroy();
    this.socket = null;
  }
}
