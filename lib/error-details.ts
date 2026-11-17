// Error details for the monitoring (Administration → Überwachung → "Fehler
// im Detail"): where the 5xx answers come from. The KPI "Fehler 24 Std." and
// the chart count them (lib/metrics.ts); this keeps, per kind of error,
// what an administrator needs to find it – and to report it.
//
// Captured (lib/request-metrics.ts, when a response with status ≥ 500 is
// finished; instrumentation.ts onRequestError; the `catch` of the route
// handlers through serverError(), lib/request-context.ts; failing
// background workers and jobs): the time, method, route pattern (routeKey –
// never the path as typed, no query string, no ids), the command of
// /api/command, the status, the error's name and message (scrubbed), the top
// stack frames in Flowplan's own code (mapped to the source when the build's
// source maps are next to it, otherwise the compiled file and function), the
// database's error code, the request id (also in the X-Request-Id header and
// the JSON error body, so a person can quote it), the instance and version,
// and the caller's role (admin, member, token, MCP …).
//
// Never: addresses, request bodies, headers, the person, anything typed
// beyond what the scrubbed message holds.
//
// Grouped by a fingerprint (route, command, error name, top frame): count,
// first and last time, counts per 5 minutes (48 hours) and per hour (14
// days) for the trend, and the last OCCURRENCES occurrences. Kept 14 days,
// at most MAX_GROUPS groups (the least recent go first).
//
// Cheap: a failing request only pushes a small object into memory (never a
// database write, never an exception); a second later the pending ones are
// written, merged under a lock per group (cluster mode: every instance
// writes its own). Collected whether the usage statistics are on or not –
// like the server log, which has these errors anyway.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { SourceMap } from "node:module";
import { isAbsolute, relative } from "node:path";
import { all, lockFor, one, run, transaction } from "./db";
import { afterTransaction } from "./db-driver/context";
import { redactSecrets } from "./ai/redact";
import { buildInfo } from "./build-info";
import { clusterMode, instanceId } from "./cluster/config";
import { requestContext, roleOf, type CallerRole } from "./request-context";
import type { ErrorGroupView, ErrorKind, ErrorOccurrence, StackFrame } from "./error-report";

const MINUTE = 60_000,
  HOUR = 3_600_000,
  DAY = 86_400_000;
const FIVE = 5 * MINUTE;
export const ERROR_DETAILS_KEEP = { days: 14, maxGroups: 500, occurrences: 20, fineHours: 48 } as const;
const MESSAGE_MAX = 500;
const MAX_FRAMES = 5;
// Pending occurrences in memory at most (a flood must not grow memory).
const MAX_PENDING = 1000;

export type { ErrorKind, StackFrame, ErrorOccurrence, ErrorGroupView } from "./error-report";
export { frameText, issueReport } from "./error-report";
type Pending = {
  at: number;
  kind: ErrorKind;
  method: string;
  route: string;
  action: string;
  status: number;
  requestId: string;
  role: CallerRole | "";
  error: unknown;
};

/* ---------- Scrubbing ---------- */

const SCRUB: [RegExp, string][] = [
  // URLs with credentials: postgres://user:secret@host
  [/\b([a-z][a-z0-9+.-]{1,20}:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[…]@"],
  // E-mail addresses
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[e-mail]"],
  // password=…, "secret": "…", token: …
  [/\b(pass(?:word|wd)?|pwd|secret|token|session|cookie|credentials?|private[-_]?key)(["']?\s*[:=]\s*["']?)[^\s"',;}&]+/gi, "$1$2[…]"],
  // JSON Web Tokens
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[…]"],
  // IPv4 and IPv6 addresses
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[IP]"],
  [/\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b/gi, "[IP]"],
  // Ids (they may name a person) and long opaque strings: keys, hashes, tokens
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "[id]"],
  [/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}\b/g, "[…]"],
];
// The message as it is kept: at most 500 characters, without anything that
// looks like a key, a password, a token, an e-mail or an address.
export function scrubMessage(text: unknown): string {
  let out = redactSecrets(String(text ?? "")).replace(/\s+/g, " ").trim();
  for (const [pattern, replacement] of SCRUB) out = out.replace(pattern, replacement);
  return out.length > MESSAGE_MAX ? `${out.slice(0, MESSAGE_MAX - 1)}…` : out;
}

/* ---------- Stack frames ---------- */

const FRAME = /^\s*at (?:(.*?) \()?(.*?):(\d+):(\d+)\)?$/;
const root = () => process.cwd();
// Turbopack's source paths: "turbopack:///[project]/lib/api.ts".
const sourcePath = (source: string) =>
  source
    .replace(/^turbopack:\/\/\/?/, "")
    .replace(/^\[project\]\//, "")
    .replace(/^webpack:\/\/[^/]*\//, "")
    .replace(/^file:\/\//, "")
    .replace(/\?.*$/, "");
const shortFile = (file: string) => {
  const plain = file.replace(/^file:\/\//, "");
  if (!isAbsolute(plain)) return plain;
  const rel = relative(root(), plain);
  return rel.startsWith("..") ? plain : rel;
};
// Flowplan's own code: not Node.js itself, not a dependency, not the
// bundler's runtime.
const ownCode = (file: string) =>
  !!file && !file.startsWith("node:") && !file.includes("node_modules/") && !file.includes("[turbopack]_runtime") && !/^(?:internal|native)\b/.test(file) && file !== "<anonymous>";

// Source maps next to the compiled files (a build run with `next start`;
// the standalone image ships none – it would be several hundred MB). A few
// parsed maps are kept; very large ones are not read.
const MAP_LIMIT = 25 * 1024 * 1024;
const maps = new Map<string, SourceMap | null>();
function sourceMapOf(file: string): SourceMap | null {
  if (maps.has(file)) {
    const map = maps.get(file)!;
    maps.delete(file);
    maps.set(file, map);
    return map;
  }
  let map: SourceMap | null = null;
  try {
    const path = `${file}.map`;
    if (existsSync(path) && statSync(path).size <= MAP_LIMIT) map = new SourceMap(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    map = null;
  }
  maps.set(file, map);
  while (maps.size > 6) maps.delete(maps.keys().next().value!);
  return map;
}
function mapFrame(fn: string, file: string, line: number, column: number): StackFrame {
  const plain = file.replace(/^file:\/\//, "");
  if (/\.(?:c|m)?js$/.test(plain) && isAbsolute(plain)) {
    const entry = sourceMapOf(plain)?.findEntry(line - 1, column - 1) as { originalSource?: string; originalLine?: number; originalColumn?: number; name?: string } | undefined;
    if (entry?.originalSource && typeof entry.originalLine === "number")
      return { fn: entry.name || fn, file: sourcePath(entry.originalSource), line: entry.originalLine + 1, column: (entry.originalColumn ?? 0) + 1, mapped: true };
  }
  return { fn, file: shortFile(plain), line, column, mapped: false };
}
// The top frames in Flowplan's own code (or, when there is none, the top
// frames at all).
export function stackFrames(stack: string | undefined): StackFrame[] {
  const raw: { fn: string; file: string; line: number; column: number }[] = [];
  for (const text of String(stack || "").split("\n").slice(1, 40)) {
    const m = FRAME.exec(text);
    if (!m) continue;
    raw.push({ fn: (m[1] || "").replace(/^async /, "").slice(0, 120), file: m[2], line: Number(m[3]), column: Number(m[4]) });
    if (raw.length >= 20) break;
  }
  const frames: StackFrame[] = [];
  for (const f of raw) {
    if (frames.length >= MAX_FRAMES) break;
    if (!ownCode(f.file)) continue;
    let mapped: StackFrame;
    try {
      mapped = mapFrame(f.fn, f.file, f.line, f.column);
    } catch {
      mapped = { ...f, file: shortFile(f.file), mapped: false };
    }
    if (ownCode(mapped.file)) frames.push(mapped);
  }
  if (frames.length) return frames;
  return raw.slice(0, 3).map((f) => ({ ...f, file: shortFile(f.file), mapped: false }));
}

/* ---------- The error itself ---------- */

// SQLite (node:sqlite: errcode/errstr) or PostgreSQL (pg: SQLSTATE, severity).
export function databaseCode(error: unknown): string {
  for (let e = error as Record<string, unknown> | undefined, depth = 0; e && typeof e === "object" && depth < 4; e = e.cause as Record<string, unknown> | undefined, depth++) {
    if (typeof e.errcode === "number") return `SQLite ${e.errcode}${typeof e.errstr === "string" ? ` (${e.errstr.slice(0, 60)})` : ""}`;
    if (typeof e.code === "string" && /^SQLITE_[A-Z_]+$/.test(e.code)) return `SQLite ${e.code}`;
    if (typeof e.code === "string" && /^[0-9A-Z]{5}$/.test(e.code) && ("severity" in e || "routine" in e)) return `PostgreSQL ${e.code}`;
  }
  return "";
}
function describe(error: unknown, status: number) {
  if (error === undefined) return { name: `HTTP ${status}`, message: "", frames: [] as StackFrame[], dbCode: "" };
  const e = error as { name?: unknown; message?: unknown; stack?: unknown; constructor?: { name?: string } };
  const isObject = !!error && typeof error === "object";
  const name = String((isObject && (typeof e.name === "string" && e.name !== "Error" ? e.name : e.constructor?.name)) || "Error").slice(0, 80) || "Error";
  const message = scrubMessage(isObject ? e.message : error);
  let frames: StackFrame[] = [];
  try {
    frames = isObject && typeof e.stack === "string" ? stackFrames(e.stack) : [];
  } catch {}
  return { name, message, frames, dbCode: databaseCode(error) };
}
export function fingerprintOf(route: string, action: string, name: string, frames: StackFrame[]) {
  // The top frame without its column (and, for a compiled file, without its
  // line: a new build moves it) – one group per place, not per build.
  const top = frames[0] ? `${frames[0].file}${frames[0].mapped ? `:${frames[0].line}` : ""}#${frames[0].fn}` : "";
  return createHash("sha256").update([route, action, name, top].join("\n")).digest("hex").slice(0, 20);
}

/* ---------- Capture (memory only) ---------- */

const holder = globalThis as unknown as { flowplanErrorDetails?: { pending: Pending[]; timer?: ReturnType<typeof setTimeout>; writing?: Promise<void>; sweptAt?: number } };
const state = () => (holder.flowplanErrorDetails ??= { pending: [] });

export type CaptureInput = { kind?: ErrorKind; method?: string; route: string; action?: string; status: number; requestId?: string; role?: CallerRole | ""; error?: unknown; at?: number };
// One failure. Never throws, never waits.
export function captureError(input: CaptureInput) {
  try {
    const s = state();
    if (s.pending.length >= MAX_PENDING) return;
    s.pending.push({
      at: input.at ?? Date.now(),
      kind: input.kind ?? "request",
      method: /^[A-Z]{3,7}$/.test(input.method || "") ? input.method! : "",
      route: String(input.route || "").slice(0, 200),
      action: /^[a-z][A-Za-z0-9._]{1,47}$/.test(input.action || "") ? input.action! : input.action ? "other" : "",
      status: Number.isInteger(input.status) ? input.status : 500,
      requestId: /^[A-Za-z0-9]{4,32}$/.test(input.requestId || "") ? input.requestId! : "",
      role: input.role || "",
      error: input.error,
    });
    if (!s.timer) {
      s.timer = setTimeout(() => {
        s.timer = undefined;
        afterTransaction(() => flushErrorDetails().catch(() => {}));
      }, 1000);
      s.timer.unref?.();
    }
  } catch {
    // The error details never disturb a request.
  }
}
// An unexpected failure a handler answered without a 5xx (an MCP tool's
// error result): kept with the current request's id, route and role.
export function captureHandledError(error: unknown, action?: string) {
  const context = requestContext();
  captureError({ method: context?.method, route: context?.route || "(no request)", action: action || context?.action, status: 500, requestId: context?.id, role: context ? roleOf(context) : "", error });
}
// A background worker reported a failure (lib/ops-events.ts noteWorkerRun).
export const captureWorkerError = (name: string, error: unknown) => captureError({ kind: "worker", route: `worker ${String(name).slice(0, 60)}`, status: 500, error });
// Work launched after its request failed (lib/background-jobs.ts launchJob).
export function captureJobError(kind: string, error: unknown) {
  const status = (error as { status?: unknown })?.status;
  if (typeof status === "number" && status < 500) return; // refused on purpose (HttpError 4xx)
  captureError({ kind: "job", route: `job ${String(kind).slice(0, 60)}`, status: 500, error });
}

/* ---------- Writing ---------- */

type Slots = { f: [number, number][]; h: [number, number][] };
type Row = {
  fingerprint: string;
  kind: string;
  route: string;
  action: string;
  name: string;
  message: string;
  status: number;
  frames: string;
  db_code: string;
  count: number;
  first_seen: number;
  last_seen: number;
  slots: string;
  occurrences: string;
};
const parse = <T>(text: string | null | undefined, fallback: T): T => {
  try {
    return text ? (JSON.parse(text) as T) : fallback;
  } catch {
    return fallback;
  }
};
function addSlot(list: [number, number][], at: number, n: number) {
  const last = list.find((s) => s[0] === at);
  if (last) last[1] += n;
  else list.push([at, n]);
}
function pruneSlots(slots: Slots, now: number): Slots {
  return {
    f: slots.f.filter(([at]) => at >= now - ERROR_DETAILS_KEEP.fineHours * HOUR).sort((a, b) => a[0] - b[0]),
    h: slots.h.filter(([at]) => at >= now - ERROR_DETAILS_KEEP.days * DAY).sort((a, b) => a[0] - b[0]),
  };
}

type Group = Omit<Row, "frames" | "slots" | "occurrences"> & { frames: StackFrame[]; slots: Slots; occurrences: ErrorOccurrence[] };
// Writes what is pending; resolves once that, and a write under way, is
// stored. Readers flush first, so the list includes the last failure.
export async function flushErrorDetails(now = Date.now()): Promise<void> {
  const s = state();
  const before = s.writing;
  if (before) await before.catch(() => {});
  if (!s.pending.length) return;
  const items = s.pending.splice(0);
  const work = writePending(items, now);
  s.writing = work;
  try {
    await work;
  } finally {
    if (s.writing === work) s.writing = undefined;
  }
}
async function writePending(items: Pending[], now: number) {
  const build = buildInfo();
  const node = clusterMode() ? instanceId() : "";
  const groups = new Map<string, Group>();
  for (const item of items) {
    const d = describe(item.error, item.status);
    const fingerprint = fingerprintOf(item.route, item.action, d.name, d.frames);
    const g = groups.get(fingerprint) || {
      fingerprint,
      kind: item.kind,
      route: item.route,
      action: item.action,
      name: d.name,
      message: d.message,
      status: item.status,
      frames: d.frames,
      db_code: d.dbCode,
      count: 0,
      first_seen: item.at,
      last_seen: item.at,
      slots: { f: [], h: [] },
      occurrences: [],
    };
    g.count++;
    g.first_seen = Math.min(g.first_seen, item.at);
    if (item.at >= g.last_seen) {
      g.last_seen = item.at;
      g.message = d.message;
      g.status = item.status;
      if (d.dbCode) g.db_code = d.dbCode;
    }
    addSlot(g.slots.f, Math.floor(item.at / FIVE) * FIVE, 1);
    addSlot(g.slots.h, Math.floor(item.at / HOUR) * HOUR, 1);
    g.occurrences.push({ at: item.at, requestId: item.requestId, status: item.status, method: item.method, node, version: build.version, role: item.role, message: d.message });
    groups.set(fingerprint, g);
  }
  for (const g of groups.values()) {
    try {
      await transaction(async () => {
        await lockFor(`error-group:${g.fingerprint}`);
        const old = await one<Row>("SELECT * FROM error_groups WHERE fingerprint=?", g.fingerprint);
        const slots = pruneSlots(old ? parse<Slots>(old.slots, { f: [], h: [] }) : { f: [], h: [] }, now);
        for (const [at, n] of g.slots.f) addSlot(slots.f, at, n);
        for (const [at, n] of g.slots.h) addSlot(slots.h, at, n);
        const occurrences = [...(old ? parse<ErrorOccurrence[]>(old.occurrences, []) : []), ...g.occurrences]
          .filter((o) => o.at >= now - ERROR_DETAILS_KEEP.days * DAY)
          .sort((a, b) => a.at - b.at)
          .slice(-ERROR_DETAILS_KEEP.occurrences);
        const newer = !old || g.last_seen >= old.last_seen;
        await run(
          `INSERT INTO error_groups(fingerprint,kind,route,action,name,message,status,frames,db_code,count,first_seen,last_seen,slots,occurrences) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(fingerprint) DO UPDATE SET message=excluded.message,status=excluded.status,frames=excluded.frames,db_code=excluded.db_code,count=excluded.count,first_seen=excluded.first_seen,last_seen=excluded.last_seen,slots=excluded.slots,occurrences=excluded.occurrences`,
          g.fingerprint,
          g.kind,
          g.route,
          g.action,
          g.name,
          newer ? g.message : old!.message,
          newer ? g.status : old!.status,
          JSON.stringify(g.frames.length || !old ? g.frames : parse<StackFrame[]>(old.frames, [])),
          (newer && g.db_code) || old?.db_code || g.db_code,
          (old?.count || 0) + g.count,
          Math.min(old?.first_seen ?? g.first_seen, g.first_seen),
          Math.max(old?.last_seen ?? g.last_seen, g.last_seen),
          JSON.stringify(slots),
          JSON.stringify(occurrences),
        );
      });
    } catch {
      // Diagnostics only: a failed write loses these occurrences.
    }
  }
  await sweepErrorDetails(now).catch(() => {});
}
// Retention: groups not seen for 14 days go; beyond MAX_GROUPS the least
// recent ones. At most every ten minutes (and always after clearing).
export async function sweepErrorDetails(now = Date.now(), force = false) {
  const s = state();
  if (!force && s.sweptAt && now - s.sweptAt < 10 * MINUTE) {
    // The cap is cheap to check every time.
    await capGroups();
    return;
  }
  s.sweptAt = now;
  await run("DELETE FROM error_groups WHERE last_seen<?", now - ERROR_DETAILS_KEEP.days * DAY);
  await capGroups();
}
async function capGroups() {
  const n = Number((await one<{ n: number }>("SELECT COUNT(*) n FROM error_groups"))?.n || 0);
  if (n <= ERROR_DETAILS_KEEP.maxGroups) return;
  const edge = await one<{ last_seen: number }>("SELECT last_seen FROM error_groups ORDER BY last_seen DESC LIMIT 1 OFFSET ?", ERROR_DETAILS_KEEP.maxGroups - 1);
  if (edge) await run("DELETE FROM error_groups WHERE last_seen<?", edge.last_seen);
  // Equal times at the edge: by fingerprint.
  const left = await all<{ fingerprint: string }>("SELECT fingerprint FROM error_groups ORDER BY last_seen DESC, fingerprint LIMIT 100000 OFFSET ?", ERROR_DETAILS_KEEP.maxGroups);
  for (const r of left) await run("DELETE FROM error_groups WHERE fingerprint=?", r.fingerprint);
}
export async function clearErrorDetails() {
  state().pending = [];
  await run("DELETE FROM error_groups");
}

/* ---------- Reading ---------- */

export type ErrorRange = "1h" | "24h" | "7d";
const RANGE_MS: Record<ErrorRange, number> = { "1h": HOUR, "24h": DAY, "7d": 7 * DAY };
export type ErrorDetails = Awaited<ReturnType<typeof errorDetails>>;
// The groups seen in the last 14 days, most recent first (at most `limit`).
export async function errorDetails(now = Date.now(), range: ErrorRange = "24h", limit = 100) {
  await flushErrorDetails(now).catch(() => {});
  const since = now - RANGE_MS[range];
  const step = range === "7d" ? HOUR : FIVE;
  const total = Number((await one<{ n: number }>("SELECT COUNT(*) n FROM error_groups WHERE last_seen>=?", now - ERROR_DETAILS_KEEP.days * DAY))?.n || 0);
  const rows = await all<Row>("SELECT * FROM error_groups WHERE last_seen>=? ORDER BY last_seen DESC LIMIT ?", now - ERROR_DETAILS_KEEP.days * DAY, limit);
  const groups: ErrorGroupView[] = rows.map((r) => {
    const slots = parse<Slots>(r.slots, { f: [], h: [] });
    // The hourly counts where the 5-minute ones no longer reach back.
    const list = step === FIVE ? slots.f : slots.h;
    const buckets = list.filter(([at]) => at + step > since).map(([at, n]) => [at, n] as [number, number]);
    return {
      fingerprint: r.fingerprint,
      kind: (r.kind as ErrorKind) || "request",
      route: r.route,
      action: r.action,
      name: r.name,
      message: r.message,
      status: Number(r.status),
      frames: parse<StackFrame[]>(r.frames, []),
      dbCode: r.db_code,
      count: Number(r.count),
      inRange: buckets.reduce((a, [, n]) => a + n, 0),
      firstSeen: Number(r.first_seen),
      lastSeen: Number(r.last_seen),
      buckets,
      occurrences: parse<ErrorOccurrence[]>(r.occurrences, []).reverse(),
    };
  });
  return { range, since, step, total, groups, keep: { ...ERROR_DETAILS_KEEP } };
}
