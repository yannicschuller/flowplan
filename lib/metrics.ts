// Usage statistics of the instance for the monitoring (lib/admin-monitoring.ts):
// requests, 5xx answers and latency per minute, the people active per hour,
// AI tokens per day and feature, storage and disk per day, push deliveries
// per hour, channel and result (lib/push-status.ts), the time per API route
// per hour (the slowest endpoints) and AI requests in detail – per model,
// provider, workspace and person, with errors and response times.
//
// Cheap by design: a request only increments counters in memory (no
// database write per request, lib/request-metrics.ts); once a minute the
// finished minutes are written and rolled up into hours (lib/metrics-worker.ts),
// once an hour today's storage row is refreshed, once a day old rows go.
// Privacy: only counts are stored – no addresses, paths, user agents or
// people. Who was active is kept in memory for the running hour only (to
// count each person once). Routes are patterns (routeKey: every segment that
// is not a plain lower-case word becomes ":id"), never a path as typed. The
// AI details name a workspace and a person by id – counts only, never a
// prompt or an answer – and are shown to administrators only.
//
// Switched off with FLOWPLAN_METRICS=off (nothing is collected, the switch in
// the administration is locked) or by an administrator (Administration →
// Überwachung → Statistik).
import { statfsSync } from "node:fs";
import { resolve } from "node:path";
import { all, lockFor, one, run, sql, transaction } from "./db";

const MINUTE = 60_000,
  HOUR = 3_600_000,
  DAY = 86_400_000;
// How long each resolution is kept: minutes for two days, hours as long as
// the refusal counters (KEEP_EVENTS_DAYS in lib/admin-ops.ts, 35 days),
// days (storage, AI tokens – no personal data) for a little more than a year.
// Routes a week, the AI details per person and workspace 90 days.
export const METRICS_KEEP = { minutesMs: 48 * HOUR, hoursMs: 35 * DAY, days: 400, routesMs: 7 * DAY, aiDetailDays: 90 } as const;

// The local calendar day (server time zone), as in lib/admin-ops.ts.
export const localDay = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

// Upper bounds (ms) of the latency buckets, in the order of their index in
// the stored histograms ("index:count", encodeHist): Infinity takes the
// rest. Indices never change meaning – finer buckets are appended (15 s and
// 20 s, #516) – so rows written before still read the same. Since then
// index 18 (≤ 30 s) holds 20–30 s; in older rows it holds 10–30 s, which
// reads as 20–30 s (as coarse as it was then, never faster). Walk the
// buckets in LATENCY_ORDER, ascending by bound.
export const LATENCY_BUCKETS = [5, 10, 20, 35, 50, 75, 100, 150, 200, 300, 500, 750, 1000, 1500, 2000, 3000, 5000, 10_000, 30_000, Infinity, 15_000, 20_000] as const;
export const LATENCY_ORDER: readonly number[] = LATENCY_BUCKETS.map((_, i) => i).sort((a, b) => LATENCY_BUCKETS[a] - LATENCY_BUCKETS[b]);

type Minute = { at: number; requests: number; errors: number; clientErrors: number; hist: number[] };
type AiCount = { requests: number; tokensIn: number; tokensOut: number };
type AiDetail = AiCount & { errors: number; timeouts: number; ms: number; hist: number[] };
type RouteCount = { requests: number; errors: number; ms: number; hist: number[] };
type State = {
  enabled: boolean;
  current: Minute | null;
  // Finished minutes not yet written.
  done: Minute[];
  // People seen in the running hour: id → last time (memory only).
  hour: { at: number; people: Map<string, number> };
  // The previous hour's count until it is written.
  lastHour: { at: number; people: number } | null;
  ai: Map<string, AiCount>;
  // "day|model|source|workspace|user|feature" → counts, until written.
  aiDetail: Map<string, AiDetail>;
  // "hour|route" → time spent, until written.
  routes: Map<string, RouteCount>;
  // Push deliveries: "hour|channel|result" → count, until written.
  push: Map<string, number>;
  // The last success per channel and the last failure – kept even with the
  // statistics off (diagnostics, no personal data), written with the counts.
  pushLast?: PushLast;
  pushLastSaved?: string;
  timer?: ReturnType<typeof setInterval>;
  sweptAt?: number;
  snapshotAt?: number;
  aiPing?: AiPing & { checking?: boolean };
};
export type AiPing = { ok: boolean; ms: number | null; error: string | null; at: number };

const envOff = () => /^(off|false|0|no)$/i.test(process.env.FLOWPLAN_METRICS?.trim() || "");
const floorTo = (ms: number, step: number) => Math.floor(ms / step) * step;
const emptyHist = () => new Array<number>(LATENCY_BUCKETS.length).fill(0);
const SETTING_KEY = "metrics";

// Shared by every module instance (route handlers, instrumentation).
const holder = globalThis as unknown as { flowplanMetrics?: State };
function state(): State {
  return (holder.flowplanMetrics ??= {
    enabled: !envOff(),
    current: null,
    done: [],
    hour: { at: 0, people: new Map() },
    lastHour: null,
    ai: new Map(),
    aiDetail: new Map(),
    routes: new Map(),
    push: new Map(),
  });
}
function forget(s: State) {
  s.current = null;
  s.done = [];
  s.hour = { at: 0, people: new Map() };
  s.lastHour = null;
  s.ai.clear();
  s.aiDetail.clear();
  s.routes.clear();
  s.push.clear();
}

/* ---------- Switch ---------- */

export async function metricsSetting(): Promise<{ enabled: boolean; locked: boolean }> {
  if (envOff()) return { enabled: false, locked: true };
  let enabled = true;
  try {
    const row = await one<{ value: string }>("SELECT value FROM instance_settings WHERE key=?", SETTING_KEY);
    if (row) enabled = JSON.parse(row.value)?.enabled !== false;
  } catch {}
  return { enabled, locked: false };
}
// Re-reads the switch (the worker does this every minute; saving at once).
export async function refreshMetricsEnabled() {
  const s = state();
  s.enabled = (await metricsSetting()).enabled;
  if (!s.enabled) forget(s);
  return s.enabled;
}
export async function saveMetricsSetting(enabled: boolean) {
  await run(
    "INSERT INTO instance_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    SETTING_KEY,
    JSON.stringify({ enabled }),
  );
  return await refreshMetricsEnabled();
}
// Removes everything collected so far (successful sign-ins included).
export async function clearMetrics() {
  await run("DELETE FROM metrics_minute");
  await run("DELETE FROM metrics_hour");
  await run("DELETE FROM metrics_day");
  await run("DELETE FROM metrics_ai");
  await run("DELETE FROM metrics_ai_usage");
  await run("DELETE FROM metrics_routes");
  await run("DELETE FROM metrics_push");
  await run("DELETE FROM ops_events WHERE kind='login_success'");
  forget(state());
}

/* ---------- Collectors (memory only) ---------- */

export const bucketOf = (ms: number) => {
  for (const i of LATENCY_ORDER) if (ms <= LATENCY_BUCKETS[i]) return i;
  return LATENCY_ORDER[LATENCY_ORDER.length - 1];
};
function minuteFor(s: State, now: number) {
  const at = floorTo(now, MINUTE);
  if (s.current && s.current.at >= at) return s.current; // a late request of the previous minute counts in this one
  // A flood of finished minutes (the worker stopped) must not grow memory.
  if (s.current && s.done.length < 24 * 60) s.done.push(s.current);
  s.current = { at, requests: 0, errors: 0, clientErrors: 0, hist: emptyHist() };
  return s.current;
}

// One finished HTTP request: its status and duration (null: not measured,
// e.g. an event stream that stayed open), and its route (routeKey) for the
// time per endpoint. `upstream`: the 5xx reports a failing third-party
// service (#514, lib/error-details.ts "Fehler bei Fremddiensten") – a
// request, but no server error and no client error.
export function noteRequest(status: number, ms: number | null, now = Date.now(), route: string | null = null, upstream = false) {
  const s = state();
  if (!s.enabled) return;
  const m = minuteFor(s, now);
  m.requests++;
  const error = status >= 500 && !upstream;
  if (error) m.errors++;
  else if (status >= 400 && status < 500) m.clientErrors++;
  if (ms === null || !Number.isFinite(ms) || ms < 0) return;
  m.hist[bucketOf(ms)]++;
  if (route) noteRoute(s, route, error, ms, now);
}

/* ---------- Time per route ---------- */

// At most this many routes per hour in memory; the rest counts as "other"
// (a client probing random addresses must not grow memory or the table).
const MAX_ROUTES = 300;
const WORD = /^[a-z][a-z-]{1,31}$/;
// The pattern of a request for the time per endpoint: the method, "/api/"
// and up to five segments, each kept only when it is a plain lower-case
// word of at most three parts ("pages", "live", "document-authors") and
// otherwise replaced by ":id" (ids, tokens, names, file names). Pages (not
// /api/) are one route.
export function routeKey(method: string | undefined, url: string | undefined): string {
  const path = (url || "/").split(/[?#]/)[0];
  const verb = /^[A-Z]{3,7}$/.test(method || "") ? method! : "GET";
  if (!path.startsWith("/api/")) return `${verb} (pages)`;
  const out: string[] = [];
  for (const part of path.slice(5).split("/").filter(Boolean).slice(0, 5)) {
    const kept = WORD.test(part) && part.split("-").length <= 3 ? part : ":id";
    // A run of ids stays one.
    if (kept !== ":id" || out[out.length - 1] !== ":id") out.push(kept);
  }
  return `${verb} /api/${out.join("/")}`;
}
// An action of /api/command (lib/api.ts) as a route of its own: the
// command endpoint alone says nothing about where the time goes.
export const COMMAND_ROUTE = "POST /api/command";
export const commandRoute = (action: string) => `${COMMAND_ROUTE} · ${/^[a-z][A-Za-z0-9.]{1,47}$/.test(action) ? action : "other"}`;

function noteRoute(s: State, route: string, error: boolean, ms: number, now: number) {
  const hour = floorTo(now, HOUR);
  let key = `${hour}|${route}`;
  if (!s.routes.has(key) && s.routes.size >= MAX_ROUTES) key = `${hour}|other`;
  const r = s.routes.get(key) || { requests: 0, errors: 0, ms: 0, hist: emptyHist() };
  r.requests++;
  if (error) r.errors++;
  r.ms += ms;
  r.hist[bucketOf(ms)]++;
  s.routes.set(key, r);
}
// A command, timed by the command handler itself (lib/api.ts); the request
// around it is also counted, as /api/command.
export function noteCommand(action: string, ms: number, failed: boolean, now = Date.now()) {
  const s = state();
  if (!s.enabled || !Number.isFinite(ms) || ms < 0) return;
  noteRoute(s, commandRoute(action), failed, ms, now);
}

// Adds to what other processes wrote for the same hour and route (like
// writeMinute). Only routes used since the last flush are written.
async function flushRoutes() {
  const s = state();
  for (const [key, r] of [...s.routes]) {
    s.routes.delete(key);
    const cut = key.indexOf("|");
    const at = Number(key.slice(0, cut)),
      route = key.slice(cut + 1);
    try {
      await transaction(async () => {
        await lockFor(`metrics-route:${at}:${route}`);
        const existing = await one<{ requests: number; errors: number; ms_total: number; hist: string }>("SELECT requests,errors,ms_total,hist FROM metrics_routes WHERE at=? AND route=?", at, route);
        await run(
          "INSERT INTO metrics_routes(at,route,requests,errors,ms_total,hist) VALUES(?,?,?,?,?,?) ON CONFLICT(at,route) DO UPDATE SET requests=excluded.requests,errors=excluded.errors,ms_total=excluded.ms_total,hist=excluded.hist",
          at,
          route,
          r.requests + (existing?.requests || 0),
          r.errors + (existing?.errors || 0),
          Math.round(r.ms) + (existing?.ms_total || 0),
          encodeHist(existing ? addHist(decodeHist(existing.hist), r.hist) : r.hist),
        );
      });
    } catch {}
  }
}

export type RouteStat = { route: string; requests: number; errors: number; totalMs: number; avgMs: number; p95: number | null };
// The routes of the last `hours` (24 by default) by total time – what keeps
// the server busy – with how slow each is (p95). /api/command itself is
// left out where its actions are listed.
export async function routeStats(now = Date.now(), hours = 24, limit = 12): Promise<RouteStat[]> {
  await flushRoutes();
  const since = floorTo(now, HOUR) - (hours - 1) * HOUR;
  const by = new Map<string, RouteCount>();
  for (const r of await all<{ route: string; requests: number; errors: number; ms_total: number; hist: string }>("SELECT route,requests,errors,ms_total,hist FROM metrics_routes WHERE at>=?", since)) {
    const b = by.get(r.route) || { requests: 0, errors: 0, ms: 0, hist: emptyHist() };
    b.requests += r.requests;
    b.errors += r.errors;
    b.ms += r.ms_total;
    b.hist = addHist(b.hist, decodeHist(r.hist));
    by.set(r.route, b);
  }
  if ([...by.keys()].some((k) => k.startsWith(`${COMMAND_ROUTE} · `))) by.delete(COMMAND_ROUTE);
  return [...by]
    .map(([route, b]) => ({ route, requests: b.requests, errors: b.errors, totalMs: Math.round(b.ms), avgMs: b.requests ? Math.round(b.ms / b.requests) : 0, p95: percentile(b.hist, 0.95) }))
    .sort((a, b) => b.totalMs - a.totalMs)
    .slice(0, limit);
}

function hourFor(s: State, now: number) {
  const at = floorTo(now, HOUR);
  if (s.hour.at !== at) {
    if (s.hour.at && s.hour.at < at) s.lastHour = { at: s.hour.at, people: s.hour.people.size };
    s.hour = { at, people: new Map() };
  }
  return s.hour;
}
// A signed-in person used the app (lib/auth.ts). Kept for the running hour
// only, to count people; never written.
export function noteActive(userId: string, now = Date.now()) {
  const s = state();
  if (!s.enabled) return;
  const hour = hourFor(s, now);
  if (hour.people.size < 100_000 || hour.people.has(userId)) hour.people.set(userId, now);
}

// People seen in the last five minutes, from memory (the server samples,
// lib/server-metrics.ts); null while the statistics are off.
export function activeRecently(now = Date.now()): number | null {
  const s = state();
  if (!s.enabled) return null;
  if (s.hour.at !== floorTo(now, HOUR)) return 0;
  let n = 0;
  for (const t of s.hour.people.values()) if (t >= now - 5 * MINUTE) n++;
  return n;
}

// Tokens of one AI request (lib/ai/run.ts; embeddings in lib/ai/providers.ts).
export function noteAiUsage(feature: string, tokensIn: number, tokensOut: number, now = Date.now()) {
  noteAiCall({ feature, tokensIn, tokensOut, answered: true }, now);
}
// One AI request in detail. `answered`: the provider answered (only then
// tokens count, as before); `failure`: it failed or timed out (a request
// the person cancelled is neither, and not counted). Model and provider as
// configured (`source`: the instance's or the person's own); workspace and
// person by id ('' when not known: embeddings, background work).
export type AiCall = {
  feature: string;
  tokensIn: number;
  tokensOut: number;
  answered: boolean;
  failure?: "error" | "timeout" | null;
  ms?: number | null;
  model?: string;
  source?: "instance" | "user" | "";
  workspaceId?: string | null;
  userId?: string | null;
};
const clip = (text: string | null | undefined, max: number) => String(text || "").slice(0, max);
export function noteAiCall(call: AiCall, now = Date.now()) {
  const s = state();
  if (!s.enabled) return;
  const tokensIn = Math.max(0, Math.round(call.tokensIn) || 0),
    tokensOut = Math.max(0, Math.round(call.tokensOut) || 0);
  const feature = clip(call.feature, 40).replaceAll("|", "/");
  if (call.answered) {
    const key = `${localDay(now)}|${feature}`;
    const c = s.ai.get(key) || { requests: 0, tokensIn: 0, tokensOut: 0 };
    c.requests++;
    c.tokensIn += tokensIn;
    c.tokensOut += tokensOut;
    if (s.ai.size < 1000 || s.ai.has(key)) s.ai.set(key, c);
  }
  if (!call.answered && !call.failure) return;
  const key = [localDay(now), clip(call.model, 120), call.source || "", clip(call.workspaceId, 64), clip(call.userId, 64)].map((v) => v.replaceAll("|", "/")).concat(feature).join("|");
  const d = s.aiDetail.get(key) || { requests: 0, tokensIn: 0, tokensOut: 0, errors: 0, timeouts: 0, ms: 0, hist: emptyHist() };
  d.requests++;
  if (call.answered) {
    d.tokensIn += tokensIn;
    d.tokensOut += tokensOut;
  }
  if (call.failure === "timeout") d.timeouts++;
  else if (call.failure) d.errors++;
  if (typeof call.ms === "number" && Number.isFinite(call.ms) && call.ms >= 0) {
    d.ms += call.ms;
    d.hist[bucketOf(call.ms)]++;
  }
  if (s.aiDetail.size < 5000 || s.aiDetail.has(key)) s.aiDetail.set(key, d);
}
// For providers that report no usage: roughly four characters per token.
export const estimateTokens = (chars: number) => Math.ceil(Math.max(0, chars) / 4);

/* ---------- Histograms ---------- */

export const encodeHist = (hist: number[]) =>
  hist
    .map((n, i) => (n ? `${i}:${n}` : ""))
    .filter(Boolean)
    .join(",");
export function decodeHist(text: string): number[] {
  const hist = emptyHist();
  for (const part of (text || "").split(",")) {
    const [i, n] = part.split(":").map(Number);
    if (Number.isInteger(i) && i >= 0 && i < hist.length && Number.isFinite(n)) hist[i] += n;
  }
  return hist;
}
const addHist = (a: number[], b: number[]) => a.map((n, i) => n + (b[i] || 0));
// Within how many ms the share q (0..1) of the requests was answered: the
// upper bound of the bucket (the open last bucket reports twice the one
// before it). Null without requests.
export function percentile(hist: number[], q: number): number | null {
  const total = hist.reduce((a, b) => a + b, 0);
  if (!total) return null;
  const want = Math.max(1, Math.ceil(total * q));
  let seen = 0;
  for (let k = 0; k < LATENCY_ORDER.length; k++) {
    const i = LATENCY_ORDER[k];
    seen += hist[i] || 0;
    if (seen >= want) return Number.isFinite(LATENCY_BUCKETS[i]) ? LATENCY_BUCKETS[i] : LATENCY_BUCKETS[LATENCY_ORDER[k - 1]] * 2;
  }
  return null;
}

/* ---------- Writing ---------- */

// Adds to what other processes wrote for the same minute (cluster mode:
// every instance flushes its own counts; the lock keeps two flushes of one
// minute from overwriting each other).
async function writeMinute(m: Minute) {
  await transaction(async () => {
    await lockFor(`metrics-minute:${m.at}`);
    const existing = await one<{ requests: number; errors: number; client_errors: number; hist: string }>("SELECT requests,errors,client_errors,hist FROM metrics_minute WHERE at=?", m.at);
    await run(
      "INSERT INTO metrics_minute(at,requests,errors,client_errors,hist) VALUES(?,?,?,?,?) ON CONFLICT(at) DO UPDATE SET requests=excluded.requests,errors=excluded.errors,client_errors=excluded.client_errors,hist=excluded.hist",
      m.at,
      m.requests + (existing?.requests || 0),
      m.errors + (existing?.errors || 0),
      m.clientErrors + (existing?.client_errors || 0),
      encodeHist(existing ? addHist(decodeHist(existing.hist), m.hist) : m.hist),
    );
  });
}
// The hour row from its minutes (exact: histograms add up).
export async function rollupHour(at: number) {
  const rows = await all<{ requests: number; errors: number; client_errors: number; hist: string }>("SELECT requests,errors,client_errors,hist FROM metrics_minute WHERE at>=? AND at<?", at, at + HOUR);
  if (!rows.length) return;
  let hist = emptyHist(),
    requests = 0,
    errors = 0,
    clientErrors = 0;
  for (const r of rows) {
    requests += r.requests;
    errors += r.errors;
    clientErrors += r.client_errors || 0;
    hist = addHist(hist, decodeHist(r.hist));
  }
  await run(
    "INSERT INTO metrics_hour(at,requests,errors,client_errors,hist) VALUES(?,?,?,?,?) ON CONFLICT(at) DO UPDATE SET requests=excluded.requests,errors=excluded.errors,client_errors=excluded.client_errors,hist=excluded.hist",
    at,
    requests,
    errors,
    clientErrors,
    encodeHist(hist),
  );
}
// People active in an hour: what was counted in memory, at least those whose
// session was last seen in it (after a restart the memory is empty).
async function writeActive(at: number, people: number) {
  let seen = 0;
  try {
    seen = Number((await one<{ n: number }>("SELECT COUNT(DISTINCT user_id) n FROM sessions WHERE last_seen>=? AND last_seen<?", at, at + HOUR))?.n || 0);
  } catch {}
  const active = Math.max(people, seen);
  if (!active && !(await one("SELECT 1 FROM metrics_hour WHERE at=?", at))) return;
  await run(`INSERT INTO metrics_hour(at,active) VALUES(?,?) ON CONFLICT(at) DO UPDATE SET active=${sql.greatest("metrics_hour.active", "excluded.active")}`, at, active);
}
// AI counts: written by the worker and when read, so the chart includes
// the last request.
export async function flushAi() {
  const s = state();
  for (const [key, c] of [...s.ai]) {
    s.ai.delete(key);
    const [day, feature] = key.split("|");
    try {
      await run(
        "INSERT INTO metrics_ai(day,feature,requests,tokens_in,tokens_out) VALUES(?,?,?,?,?) ON CONFLICT(day,feature) DO UPDATE SET requests=metrics_ai.requests+excluded.requests,tokens_in=metrics_ai.tokens_in+excluded.tokens_in,tokens_out=metrics_ai.tokens_out+excluded.tokens_out",
        day,
        feature,
        c.requests,
        c.tokensIn,
        c.tokensOut,
      );
    } catch {}
  }
  // The details add to the day's row (histograms read and merged under a
  // lock, like the minutes).
  for (const [key, c] of [...s.aiDetail]) {
    s.aiDetail.delete(key);
    const [day, model, source, workspaceId, userId, feature] = key.split("|");
    try {
      await transaction(async () => {
        await lockFor(`metrics-ai:${key}`);
        const existing = await one<{ hist: string }>(
          "SELECT hist FROM metrics_ai_usage WHERE day=? AND model=? AND source=? AND workspace_id=? AND user_id=? AND feature=?",
          day,
          model,
          source,
          workspaceId,
          userId,
          feature,
        );
        await run(
          "INSERT INTO metrics_ai_usage(day,model,source,workspace_id,user_id,feature,requests,tokens_in,tokens_out,errors,timeouts,ms_total,hist) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(day,model,source,workspace_id,user_id,feature) DO UPDATE SET requests=metrics_ai_usage.requests+excluded.requests,tokens_in=metrics_ai_usage.tokens_in+excluded.tokens_in,tokens_out=metrics_ai_usage.tokens_out+excluded.tokens_out,errors=metrics_ai_usage.errors+excluded.errors,timeouts=metrics_ai_usage.timeouts+excluded.timeouts,ms_total=metrics_ai_usage.ms_total+excluded.ms_total,hist=excluded.hist",
          day,
          model,
          source,
          workspaceId,
          userId,
          feature,
          c.requests,
          c.tokensIn,
          c.tokensOut,
          c.errors,
          c.timeouts,
          Math.round(c.ms),
          encodeHist(existing ? addHist(decodeHist(existing.hist), c.hist) : c.hist),
        );
      });
    } catch {}
  }
}
// The person's AI details go with their account (lib/account-deletion.ts):
// their counts are added to the rows without a person, so the totals per
// model and workspace stay.
export async function forgetAiPerson(userId: string) {
  // What is still in memory is written without the person.
  const s = state();
  for (const [key, c] of [...s.aiDetail]) {
    const parts = key.split("|");
    if (parts[4] !== userId) continue;
    s.aiDetail.delete(key);
    parts[4] = "";
    const other = s.aiDetail.get(parts.join("|"));
    s.aiDetail.set(
      parts.join("|"),
      other
        ? { requests: other.requests + c.requests, tokensIn: other.tokensIn + c.tokensIn, tokensOut: other.tokensOut + c.tokensOut, errors: other.errors + c.errors, timeouts: other.timeouts + c.timeouts, ms: other.ms + c.ms, hist: addHist(other.hist, c.hist) }
        : c,
    );
  }
  await run(
    "INSERT INTO metrics_ai_usage(day,model,source,workspace_id,user_id,feature,requests,tokens_in,tokens_out,errors,timeouts,ms_total,hist) SELECT day,model,source,workspace_id,'',feature,requests,tokens_in,tokens_out,errors,timeouts,ms_total,'' FROM metrics_ai_usage WHERE user_id=? ON CONFLICT(day,model,source,workspace_id,user_id,feature) DO UPDATE SET requests=metrics_ai_usage.requests+excluded.requests,tokens_in=metrics_ai_usage.tokens_in+excluded.tokens_in,tokens_out=metrics_ai_usage.tokens_out+excluded.tokens_out,errors=metrics_ai_usage.errors+excluded.errors,timeouts=metrics_ai_usage.timeouts+excluded.timeouts,ms_total=metrics_ai_usage.ms_total+excluded.ms_total",
    userId,
  );
  await run("DELETE FROM metrics_ai_usage WHERE user_id=?", userId);
  // The AI quota's counts and rule (#382) likewise.
  const { forgetQuotaPerson } = await import("./ai/quota");
  await forgetQuotaPerson(userId);
}

export function dataDir() {
  return resolve(/* turbopackIgnore: true */ process.env.FLOWPLAN_DATA_DIR || "./data");
}
// Size and free space of the volume that holds the data (null: unknown).
export function diskUsage(): { total: number; free: number } | null {
  try {
    const s = statfsSync(dataDir());
    const total = Number(s.blocks) * Number(s.bsize),
      free = Number(s.bavail) * Number(s.bsize);
    return total > 0 ? { total, free } : null;
  } catch {
    return null;
  }
}
type Sizes = { databaseBytes: number; uploadBytes: number; files: number };
// Today's storage row (refreshed once an hour; the last row of a day stays).
// The sizes come from instanceMetrics() (lib/instance-ops.ts).
export async function snapshotStorage(m: Sizes, now = Date.now()) {
  const disk = diskUsage();
  await run(
    "INSERT INTO metrics_day(day,database_bytes,upload_bytes,files,disk_total,disk_free,at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(day) DO UPDATE SET database_bytes=excluded.database_bytes,upload_bytes=excluded.upload_bytes,files=excluded.files,disk_total=excluded.disk_total,disk_free=excluded.disk_free,at=excluded.at",
    localDay(now),
    m.databaseBytes,
    m.uploadBytes,
    m.files,
    disk?.total ?? null,
    disk?.free ?? null,
    now,
  );
}

export async function sweepMetrics(now = Date.now()) {
  await run("DELETE FROM metrics_minute WHERE at<?", now - METRICS_KEEP.minutesMs);
  await run("DELETE FROM metrics_hour WHERE at<?", now - METRICS_KEEP.hoursMs);
  await run("DELETE FROM metrics_push WHERE at<?", now - METRICS_KEEP.hoursMs);
  const oldest = localDay(now - METRICS_KEEP.days * DAY);
  await run("DELETE FROM metrics_day WHERE day<?", oldest);
  await run("DELETE FROM metrics_ai WHERE day<?", oldest);
  await run("DELETE FROM metrics_ai_usage WHERE day<?", localDay(now - METRICS_KEEP.aiDetailDays * DAY));
  await run("DELETE FROM metrics_routes WHERE at<?", now - METRICS_KEEP.routesMs);
}

// Writes what is finished: minutes, their hours, the people of the last
// and the running hour, AI tokens; refreshes today's storage row hourly
// (`sizes` measures it) and sweeps daily.
export async function flushMetrics(now = Date.now(), sizes?: () => (Sizes) | Promise<Sizes>) {
  const s = state();
  await savePushLast();
  if (!s.enabled) return;
  if (s.current && s.current.at < floorTo(now, MINUTE)) {
    s.done.push(s.current);
    s.current = null;
  }
  const hours = new Set<number>();
  for (const m of s.done.splice(0)) {
    try {
      await writeMinute(m);
      hours.add(floorTo(m.at, HOUR));
    } catch {}
  }
  for (const h of hours)
    try {
      await rollupHour(h);
    } catch {}
  const hour = hourFor(s, now);
  try {
    if (s.lastHour) {
      await writeActive(s.lastHour.at, s.lastHour.people);
      s.lastHour = null;
    }
    await writeActive(hour.at, hour.people.size);
  } catch {}
  await flushAi();
  await flushRoutes();
  await flushPush();
  if (sizes && now - (s.snapshotAt ?? 0) >= HOUR) {
    try {
      await snapshotStorage(await sizes(), now);
      s.snapshotAt = now;
    } catch {}
  }
  if (now - (s.sweptAt ?? 0) >= DAY) {
    try {
      await sweepMetrics(now);
      s.sweptAt = now;
    } catch {}
  }
}

// The worker's timer (lib/metrics-worker.ts), kept with the state.
export function metricsTimer(timer?: ReturnType<typeof setInterval>) {
  const s = state();
  if (timer) s.timer = timer;
  return s.timer;
}

/* ---------- Reading ---------- */

// Minutes from the database and those still in memory, by start time.
async function minutesSince(since: number) {
  const s = state();
  const byAt = new Map<number, Minute>();
  for (const r of await all<{ at: number; requests: number; errors: number; client_errors: number; hist: string }>("SELECT at,requests,errors,client_errors,hist FROM metrics_minute WHERE at>=?", since))
    byAt.set(r.at, { at: r.at, requests: r.requests, errors: r.errors, clientErrors: r.client_errors || 0, hist: decodeHist(r.hist) });
  for (const m of [...s.done, ...(s.current ? [s.current] : [])]) {
    if (m.at < since) continue;
    const prev = byAt.get(m.at);
    byAt.set(
      m.at,
      prev
        ? { at: m.at, requests: prev.requests + m.requests, errors: prev.errors + m.errors, clientErrors: prev.clientErrors + m.clientErrors, hist: addHist(prev.hist, m.hist) }
        : { ...m, hist: [...m.hist] },
    );
  }
  return byAt;
}
// When collecting began (the oldest row or minute in memory).
export async function collectingSince(): Promise<number | null> {
  const s = state();
  const values = [
    (await one<{ at: number | null }>("SELECT MIN(at) at FROM metrics_minute"))?.at,
    (await one<{ at: number | null }>("SELECT MIN(at) at FROM metrics_hour WHERE requests>0"))?.at,
    s.done[0]?.at,
    s.current?.at,
  ].filter((x): x is number => typeof x === "number");
  return values.length ? Math.min(...values) : null;
}

export type RequestRange = "1h" | "24h" | "7d";
export const REQUEST_RANGES: RequestRange[] = ["1h", "24h", "7d"];
export type RequestPoint = { at: number; requests: number | null; errors: number | null; clientErrors: number | null; p95: number | null };
// Requests and 5xx per bucket: 1 h by minute, 24 h by 5 minutes, 7 d by
// hour. Buckets before anything was collected are null (a gap, not a zero).
export async function requestSeries(range: RequestRange, now = Date.now()): Promise<{ range: RequestRange; bucketMs: number; points: RequestPoint[] }> {
  const bucketMs = range === "1h" ? MINUTE : range === "24h" ? 5 * MINUTE : HOUR;
  const count = range === "1h" ? 60 : range === "24h" ? 288 : 168;
  const end = floorTo(now, bucketMs);
  const start = end - (count - 1) * bucketMs;
  const first = await collectingSince();
  const buckets = new Map<number, { requests: number; errors: number; clientErrors: number; hist: number[] }>();
  const add = (at: number, requests: number, errors: number, clientErrors: number, hist: number[]) => {
    const key = floorTo(at, bucketMs);
    const b = buckets.get(key) || { requests: 0, errors: 0, clientErrors: 0, hist: emptyHist() };
    b.requests += requests;
    b.errors += errors;
    b.clientErrors += clientErrors;
    b.hist = addHist(b.hist, hist);
    buckets.set(key, b);
  };
  if (range === "7d") {
    // Finished hours from their rows, the running hour from its minutes.
    const running = floorTo(now, HOUR);
    for (const r of await all<{ at: number; requests: number; errors: number; client_errors: number; hist: string }>("SELECT at,requests,errors,client_errors,hist FROM metrics_hour WHERE at>=? AND at<?", start, running))
      add(r.at, r.requests, r.errors, r.client_errors || 0, decodeHist(r.hist));
    for (const m of (await minutesSince(running)).values()) add(m.at, m.requests, m.errors, m.clientErrors, m.hist);
  } else for (const m of (await minutesSince(start)).values()) add(m.at, m.requests, m.errors, m.clientErrors, m.hist);
  const points: RequestPoint[] = [];
  for (let at = start; at <= end; at += bucketMs) {
    const b = buckets.get(at);
    if (b) points.push({ at, requests: b.requests, errors: b.errors, clientErrors: b.clientErrors, p95: percentile(b.hist, 0.95) });
    else if (first === null || at + bucketMs <= first) points.push({ at, requests: null, errors: null, clientErrors: null, p95: null });
    else points.push({ at, requests: 0, errors: 0, clientErrors: 0, p95: null });
  }
  return { range, bucketMs, points };
}

// Requests and 5xx of the last 24 hours – per hour for a trend – and of the
// 24 hours before, from the minutes (kept 48 hours). `previous` is null
// while collecting has not covered both days yet (no invented comparison).
export async function errorsDay(now = Date.now()) {
  const end = floorTo(now, HOUR);
  const start = end - 23 * HOUR;
  const first = await collectingSince();
  const hours = new Map<number, number>();
  let requests = 0,
    errors = 0,
    previousRequests = 0,
    previousErrors = 0;
  for (const m of (await minutesSince(now - 2 * DAY)).values()) {
    if (m.at >= now - DAY) {
      requests += m.requests;
      errors += m.errors;
    } else {
      previousRequests += m.requests;
      previousErrors += m.errors;
    }
    if (m.at >= start) hours.set(floorTo(m.at, HOUR), (hours.get(floorTo(m.at, HOUR)) || 0) + m.errors);
  }
  const hourly: (number | null)[] = [];
  for (let at = start; at <= end; at += HOUR) hourly.push(first === null || at + HOUR <= first ? null : hours.get(at) || 0);
  return {
    requests,
    errors,
    previous: first !== null && first <= now - 2 * DAY ? { requests: previousRequests, errors: previousErrors } : null,
    hourly,
  };
}

// People active per hour (7 days); the running hour from memory.
export async function activeSeries(now = Date.now(), hours = 168): Promise<{ at: number; people: number | null }[]> {
  const s = state();
  const end = floorTo(now, HOUR);
  const start = end - (hours - 1) * HOUR;
  const rows = new Map((await all<{ at: number; active: number }>("SELECT at,active FROM metrics_hour WHERE at>=?", start)).map((r) => [r.at, r.active]));
  if (s.enabled && s.hour.at === end) rows.set(end, Math.max(rows.get(end) || 0, s.hour.people.size));
  const first = rows.size ? Math.min(...rows.keys()) : null;
  const out: { at: number; people: number | null }[] = [];
  for (let at = start; at <= end; at += HOUR) out.push({ at, people: rows.get(at) ?? (first === null || at < first ? null : 0) });
  return out;
}

// The numbers of the live strip: now and the last hour.
export async function liveNumbers(now = Date.now()) {
  const s = state();
  const minutes = await minutesSince(now - HOUR);
  let requests = 0,
    errors = 0,
    hist = emptyHist();
  for (const m of minutes.values()) {
    requests += m.requests;
    errors += m.errors;
    hist = addHist(hist, m.hist);
  }
  // Requests per minute: the last finished minute (the running one is partial).
  const last = minutes.get(floorTo(now, MINUTE) - MINUTE);
  const recent = s.hour.at === floorTo(now, HOUR) ? [...s.hour.people.values()].filter((t) => t >= now - 5 * MINUTE).length : 0;
  let seen = 0;
  try {
    seen = Number((await one<{ n: number }>("SELECT COUNT(DISTINCT user_id) n FROM sessions WHERE last_seen>=? AND expires>?", now - 5 * MINUTE, now))?.n || 0);
  } catch {}
  return {
    enabled: s.enabled,
    activeNow: Math.max(recent, seen),
    requestsPerMinute: last?.requests ?? 0,
    requestsHour: requests,
    errorsHour: errors,
    errorRate: requests ? errors / requests : 0,
    p50: percentile(hist, 0.5),
    p95: percentile(hist, 0.95),
  };
}

const lastDays = (now: number, days: number) => {
  const noon = new Date(now);
  noon.setHours(12, 0, 0, 0);
  const keys: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(noon);
    d.setDate(d.getDate() - i);
    keys.push(localDay(d.getTime()));
  }
  return keys;
};

// Tokens per day (the last `days`) and per feature over that time.
export async function aiUsage(now = Date.now(), days = 14) {
  await flushAi();
  const keys = lastDays(now, days);
  const rows = await all<{ day: string; feature: string; requests: number; tokens_in: number; tokens_out: number }>(
    "SELECT day,feature,requests,tokens_in,tokens_out FROM metrics_ai WHERE day>=?",
    keys[0],
  );
  const perDay = new Map(keys.map((k) => [k, { day: k, tokensIn: 0, tokensOut: 0, requests: 0 }]));
  const perFeature = new Map<string, { feature: string; tokens: number; requests: number }>();
  for (const r of rows) {
    const d = perDay.get(r.day);
    if (!d) continue;
    d.tokensIn += r.tokens_in;
    d.tokensOut += r.tokens_out;
    d.requests += r.requests;
    const f = perFeature.get(r.feature) || { feature: r.feature, tokens: 0, requests: 0 };
    f.tokens += r.tokens_in + r.tokens_out;
    f.requests += r.requests;
    perFeature.set(r.feature, f);
  }
  return { days: [...perDay.values()], features: [...perFeature.values()].sort((a, b) => b.tokens - a.tokens) };
}

// Storage (database + uploads) per day, the last `days`; days without a row are null.
export async function storageTrend(now = Date.now(), days = 30) {
  const keys = lastDays(now, days);
  const rows = new Map(
    (await all<{ day: string; database_bytes: number; upload_bytes: number }>("SELECT day,database_bytes,upload_bytes FROM metrics_day WHERE day>=?", keys[0])).map((r) => [r.day, r]),
  );
  return keys.map((day) => {
    const r = rows.get(day);
    return { day, bytes: r ? r.database_bytes + r.upload_bytes : null };
  });
}

/* ---------- AI provider ---------- */

const PING_MAX_AGE = 5 * MINUTE;
// The instance provider's reachability, checked in the background at most
// every five minutes (`check` lists its models – free of charge). Returns
// what is known now; null: never checked yet.
export function aiProviderPing(check: () => Promise<unknown>, now = Date.now()): AiPing | null {
  const s = state();
  const known: AiPing | null = s.aiPing?.at ? { ok: s.aiPing.ok, ms: s.aiPing.ms, error: s.aiPing.error, at: s.aiPing.at } : null;
  if (!s.aiPing?.checking && (!s.aiPing || now - s.aiPing.at >= PING_MAX_AGE)) {
    s.aiPing = { ...(s.aiPing || { ok: false, ms: null, error: null, at: 0 }), checking: true };
    const started = Date.now();
    void Promise.resolve()
      .then(check)
      .then(
        () => {
          s.aiPing = { ok: true, ms: Date.now() - started, error: null, at: Date.now() };
        },
        (error) => {
          s.aiPing = { ok: false, ms: null, error: String((error as Error)?.message || error).slice(0, 200), at: Date.now() };
        },
      );
  }
  return known;
}
export function resetAiPing() {
  delete state().aiPing;
}

/* ---------- Push deliveries ---------- */

// Every answer of a push service the push worker (lib/push.ts) got: the
// relay (also test notifications and Live Activities), Expo and Web Push.
export type PushChannel = "relay" | "expo" | "web";
export type PushResult = "ok" | "gone" | "forbidden" | "invalid" | "rate_limited" | "error";
export const PUSH_CHANNELS: PushChannel[] = ["relay", "expo", "web"];
export const PUSH_RESULTS: PushResult[] = ["ok", "gone", "forbidden", "invalid", "rate_limited", "error"];
// A failure as a code only: a relay reason ("signature", "unreachable" …),
// "HTTP 502" or Expo's error name – never a token, address or message text.
export type PushFailure = { channel: PushChannel; result: PushResult; code: string | null; at: number };
export type PushLast = { ok: Record<PushChannel, number | null>; error: PushFailure | null };
const PUSH_LAST_KEY = "push-delivery";
const safeCode = (code: string | null | undefined) => (code && /^[A-Za-z0-9 _.:-]{1,60}$/.test(code) ? code : null);

async function pushLast(s: State): Promise<PushLast> {
  if (!s.pushLast) {
    let stored: Partial<PushLast> = {};
    try {
      const row = await one<{ value: string }>("SELECT value FROM instance_settings WHERE key=?", PUSH_LAST_KEY);
      if (row) stored = JSON.parse(row.value) || {};
    } catch {}
    const ok = (c: PushChannel) => (typeof stored.ok?.[c] === "number" ? stored.ok[c] : null);
    const e = stored.error;
    s.pushLast = {
      ok: { relay: ok("relay"), expo: ok("expo"), web: ok("web") },
      error:
        e && PUSH_CHANNELS.includes(e.channel) && PUSH_RESULTS.includes(e.result) && typeof e.at === "number"
          ? { channel: e.channel, result: e.result, code: safeCode(e.code), at: e.at }
          : null,
    };
    s.pushLastSaved = JSON.stringify(s.pushLast);
  }
  return s.pushLast;
}

// One delivery's outcome. "gone" (the device is no longer registered) is
// counted, but it is no failure of the instance.
export async function notePushResult(channel: PushChannel, result: PushResult, code: string | null = null, now = Date.now()) {
  const s = state();
  const last = await pushLast(s);
  if (result === "ok") last.ok[channel] = Math.max(last.ok[channel] ?? 0, now);
  else if (result !== "gone") last.error = { channel, result, code: safeCode(code), at: now };
  if (!s.enabled) return;
  const key = `${floorTo(now, HOUR)}|${channel}|${result}`;
  if (s.push.size < 1000 || s.push.has(key)) s.push.set(key, (s.push.get(key) || 0) + 1);
}

async function flushPush() {
  const s = state();
  for (const [key, n] of [...s.push]) {
    s.push.delete(key);
    const [at, channel, result] = key.split("|");
    try {
      await run(
        "INSERT INTO metrics_push(at,channel,result,count) VALUES(?,?,?,?) ON CONFLICT(at,channel,result) DO UPDATE SET count=metrics_push.count+excluded.count",
        Number(at),
        channel,
        result,
        n,
      );
    } catch {}
  }
}
async function savePushLast() {
  const s = state();
  if (!s.pushLast) return;
  const text = JSON.stringify(s.pushLast);
  if (text === s.pushLastSaved) return;
  try {
    await run("INSERT INTO instance_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", PUSH_LAST_KEY, text);
    s.pushLastSaved = text;
  } catch {}
}

type PushCounts = Record<PushChannel, Record<PushResult, number>>;
const emptyPushCounts = (): PushCounts =>
  Object.fromEntries(PUSH_CHANNELS.map((c) => [c, Object.fromEntries(PUSH_RESULTS.map((r) => [r, 0]))])) as PushCounts;

// Deliveries of the last `hours` (24 by default): per channel and result,
// and per hour delivered/failed (oldest first, for a sparkline). Failed:
// everything but ok and gone. With the statistics off, only the last
// success and failure are known.
export async function pushDeliveries(now = Date.now(), hours = 24) {
  const s = state();
  await flushPush();
  await savePushLast();
  const end = floorTo(now, HOUR);
  const start = end - (hours - 1) * HOUR;
  const totals = emptyPushCounts();
  const perHour = new Map<number, { ok: number; failed: number }>();
  for (const r of await all<{ at: number; channel: PushChannel; result: PushResult; count: number }>(
    "SELECT at,channel,result,count FROM metrics_push WHERE at>=?",
    start,
  )) {
    if (!totals[r.channel] || totals[r.channel][r.result] === undefined) continue;
    totals[r.channel][r.result] += r.count;
    const h = perHour.get(r.at) || { ok: 0, failed: 0 };
    if (r.result === "ok") h.ok += r.count;
    else if (r.result !== "gone") h.failed += r.count;
    perHour.set(r.at, h);
  }
  const hourly: { at: number; ok: number; failed: number }[] = [];
  for (let at = start; at <= end; at += HOUR) hourly.push({ at, ...(perHour.get(at) || { ok: 0, failed: 0 }) });
  const last = await pushLast(s);
  return { collecting: s.enabled, hours, totals, hourly, lastOk: { ...last.ok }, lastError: last.error ? { ...last.error } : null };
}
export type PushDeliveries = Awaited<ReturnType<typeof pushDeliveries>>;
