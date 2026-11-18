// The server log on disk, for the restart history (Administration →
// Überwachung → Neustarts, lib/restarts/tracker.ts): what Flowplan wrote to
// stdout and stderr – its start lines, warnings and errors – also lands,
// redacted (lib/restarts/redact.ts), in <data>/logs/app-<key>.log. The
// container's own log stays exactly as it was: the original write runs
// first, the copy after it, and a copy that fails never reaches the app.
//
// Bounded: a file is rotated to .1 at LOG_LIMITS.lines lines or
// LOG_LIMITS.bytes bytes, so at most two files (about 2,000 lines, 2 MB)
// per key. Litestream's lines come from docker/entrypoint.sh into
// litestream.log(.1) the same way.
//
// One line: "<ISO time> <run> <stream> <text>" – run is a random id per
// process (a restarted container may get the same pid), stream "out" or
// "err"; Litestream's lines have run "-" and stream "litestream".
//
// FLOWPLAN_LOG_FILE=off: no log file (the restart history then keeps no
// lines; heartbeat and exit reasons stay).
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { logSecrets, redactLogLine } from "./redact";

export const LOG_LIMITS = { lines: 1000, bytes: 1024 * 1024, lineChars: 2000 } as const;

export const dataDir = () => resolve(/* turbopackIgnore: true */ process.env.FLOWPLAN_DATA_DIR || "./data");
export const logsDir = () => resolve(dataDir(), "logs");
export const logFileEnabled = (env: Record<string, string | undefined> = process.env) => env.FLOWPLAN_LOG_FILE?.trim().toLowerCase() !== "off";

// The name the files of this container or pod carry: FLOWPLAN_INSTANCE_ID
// when set, else the host name – the same after a restart of the process
// in its container, another one for every other container or pod sharing
// the data folder (cluster mode on one volume).
export function fileKey(env: Record<string, string | undefined> = process.env) {
  return ((env.FLOWPLAN_INSTANCE_ID?.trim() || hostname()).slice(0, 60) || "flowplan").replace(/[^A-Za-z0-9_.-]/g, "_");
}

const holder = globalThis as unknown as { flowplanRunId?: string };
// This process's id in the lines (6 hex characters).
export const runId = () => (holder.flowplanRunId ??= randomBytes(3).toString("hex"));

// ANSI colours (Next.js colours some of its lines) are not kept.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

export class RotatingLog {
  private lines = -1;
  private bytes = 0;
  constructor(
    readonly path: string,
    private readonly limits: { lines: number; bytes: number } = LOG_LIMITS,
  ) {}
  private measure() {
    try {
      const text = readFileSync(this.path, "utf8");
      this.bytes = Buffer.byteLength(text);
      this.lines = text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0;
    } catch {
      this.lines = 0;
      this.bytes = 0;
    }
  }
  // Appends whole lines (without "\n"); throws when the disk refuses.
  append(lines: string[]) {
    if (!lines.length) return;
    if (this.lines < 0) this.measure();
    const text = lines.map((l) => `${l}\n`).join("");
    const size = Buffer.byteLength(text);
    if (this.lines > 0 && (this.lines + lines.length > this.limits.lines || this.bytes + size > this.limits.bytes)) {
      renameSync(this.path, `${this.path}.1`);
      this.lines = 0;
      this.bytes = 0;
    }
    try {
      appendFileSync(this.path, text, { mode: 0o600 });
    } catch {
      // The folder went away: once more with it.
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      appendFileSync(this.path, text, { mode: 0o600 });
    }
    this.lines += lines.length;
    this.bytes += size;
  }
}

/* ---------- Reading ---------- */

export type LogLine = { at: number; run: string; stream: string; text: string };
export function parseLogLine(line: string): LogLine | null {
  const m = /^(\S+) (\S+) (\S+) ?(.*)$/.exec(line);
  if (!m) return null;
  const at = Date.parse(m[1]);
  return Number.isFinite(at) ? { at, run: m[2], stream: m[3], text: m[4] } : null;
}
// The end of a file, at most `max` bytes (the files are bounded anyway).
function tailText(path: string, max = 2 * LOG_LIMITS.bytes) {
  let fd: number | null = null;
  try {
    const size = statSync(path).size;
    fd = openSync(path, "r");
    const length = Math.min(size, max);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const text = buffer.toString("utf8");
    return length < size ? text.slice(text.indexOf("\n") + 1) : text;
  } catch {
    return "";
  } finally {
    if (fd !== null) closeSync(fd);
  }
}
// The lines of a rotating log, oldest first (.1, then the current file).
export function readLog(path: string): LogLine[] {
  const out: LogLine[] = [];
  for (const file of [`${path}.1`, path])
    for (const line of tailText(file).split("\n")) {
      const parsed = line ? parseLogLine(line) : null;
      if (parsed) out.push(parsed);
    }
  return out;
}
export const appLogPath = (key = fileKey()) => resolve(logsDir(), `app-${key}.log`);
export const litestreamLogPath = () => resolve(logsDir(), "litestream.log");

// The lines one run left: its own (by run id) and Litestream's while it ran
// (from its start until `until`), oldest first, the last `limit`.
// The entrypoint marks each container start in litestream.log ("start"):
// the run's Litestream lines begin at the mark before it started (its
// restore) and end at the next one (the following container's).
export function runLines(key: string, run: string, from: number, until: number, limit = 200): string[] {
  const own = readLog(appLogPath(key)).filter((l) => l.run === run);
  const all = readLog(litestreamLogPath());
  const marks = all.filter((l) => l.stream === "start").map((l) => l.at);
  const begin = Math.max(from - 60_000, ...marks.filter((at) => at <= from));
  const end = Math.min(until, ...marks.filter((at) => at > from));
  const litestream = all.filter((l) => l.stream !== "start" && l.at >= begin && l.at <= end);
  return [...own, ...litestream]
    .sort((a, b) => a.at - b.at)
    .slice(-limit)
    .map((l) => `${new Date(l.at).toISOString()} [${l.stream}] ${l.text}`);
}

/* ---------- Capture of this process's output ---------- */

type Capture = { installed: boolean; log: RotatingLog | null; partial: Record<"out" | "err", string>; failedAt: number; secrets: string[]; busy: boolean };
const capture = globalThis as unknown as { flowplanLogCapture?: Capture };

// The text of one write: a string or bytes.
const chunkText = (chunk: unknown, encoding?: unknown) =>
  typeof chunk === "string" ? chunk : chunk instanceof Uint8Array ? Buffer.from(chunk).toString(typeof encoding === "string" ? (encoding as BufferEncoding) : "utf8") : "";

function copy(c: Capture, stream: "out" | "err", text: string, now = Date.now()) {
  // After a refused write: tried again after a minute (a full disk).
  if (!c.log || c.busy || (c.failedAt && now - c.failedAt < 60_000)) return;
  c.busy = true;
  try {
    const parts = (c.partial[stream] + text).split("\n");
    c.partial[stream] = parts.pop()!.slice(-LOG_LIMITS.lineChars);
    const lines: string[] = [];
    const at = new Date(now).toISOString();
    for (const part of parts) {
      const plain = part.replace(ANSI, "").replace(/\r/g, "").trimEnd();
      if (!plain) continue;
      lines.push(`${at} ${runId()} ${stream} ${redactLogLine(plain.slice(0, LOG_LIMITS.lineChars), c.secrets)}`);
    }
    c.log.append(lines);
    c.failedAt = 0;
  } catch {
    c.failedAt = now;
  } finally {
    c.busy = false;
  }
}

// Wraps process.stdout.write and process.stderr.write (instrumentation.ts,
// first thing). Once per process.
export function installLogCapture(env: Record<string, string | undefined> = process.env) {
  const c = (capture.flowplanLogCapture ??= { installed: false, log: null, partial: { out: "", err: "" }, failedAt: 0, secrets: [], busy: false });
  if (c.installed || !logFileEnabled(env)) return c;
  c.installed = true;
  c.secrets = logSecrets(env);
  try {
    if (!existsSync(logsDir())) mkdirSync(logsDir(), { recursive: true, mode: 0o700 });
    c.log = new RotatingLog(appLogPath());
  } catch {
    // Not writable: the container's log only.
    c.log = null;
    return c;
  }
  for (const [name, stream] of [
    ["out", process.stdout],
    ["err", process.stderr],
  ] as const) {
    const original = stream.write.bind(stream) as (...args: unknown[]) => boolean;
    stream.write = ((chunk: unknown, ...rest: unknown[]) => {
      const result = original(chunk, ...rest);
      try {
        copy(c, name, chunkText(chunk, typeof rest[0] === "string" ? rest[0] : undefined));
      } catch {}
      return result;
    }) as typeof stream.write;
  }
  return c;
}
// What is still buffered without its newline (before the process ends).
export function flushLogCapture() {
  const c = capture.flowplanLogCapture;
  if (!c?.log) return;
  for (const stream of ["out", "err"] as const) if (c.partial[stream]) copy(c, stream, "\n");
}
