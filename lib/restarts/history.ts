// The restart history (Administration → Überwachung → Neustarts): one row
// in restart_events per previous run that ended (lib/restarts/tracker.ts
// classifies it) – when it was noticed, the run's start and uptime, the
// reason (clean, crash, oom, killed), the last heartbeat (memory) and, for
// an unexpected one, the error and the run's last 200 log lines (redacted).
// A clean restart is a light row without lines: the history shows every
// restart, the unexpected ones are those that matter. Kept 30 days (the
// daily operations sweep, lib/admin-ops.ts). Per instance in cluster mode:
// every instance records the runs it took over.
//
// Alert (one per incident, like the stuck Litestream replica): a crash, or
// two unexpected restarts less than an hour apart. Restarts closer than an
// hour to each other form one incident; it is opened once (the first row's
// `incident` is claimed atomically), then the operator's webhook (event
// ops.unexpected_restart), the administrators' chat apps, the landing
// page's tile (for 24 hours) and an activity log entry.
import { all, audit, id, one, run } from "../db";
import { ct } from "../content-locale";
import { HttpError } from "../auth";
import { requireOpsAdmin } from "../admin-ops";
import type { Identity } from "../types";
import { claimPreviousRuns, classifyRun, memoryShare, sweepLogFiles, takePreviousRuns, type Heartbeat, type PreviousRun, type RestartReason } from "./tracker";

const HOUR = 3_600_000,
  DAY = 24 * HOUR;
export const RESTARTS_KEEP_DAYS = 30;
// Unexpected restarts closer than this belong to one incident.
export const INCIDENT_GAP_MS = HOUR;
// The incident shows on the landing page's tile this long.
export const INCIDENT_SHOWN_MS = DAY;

export type RestartMemory = { rss: number; limit: number | null; workingSet: number | null; heapUsed: number; heapLimit: number; share: number | null };
export type RestartRow = {
  id: string;
  at: number;
  endedAt: number;
  instance: string;
  host: string;
  previousStart: number;
  uptimeMs: number;
  reason: RestartReason;
  signal: string | null;
  code: number | null;
  version: string | null;
  memory: RestartMemory | null;
  // The first line of the error (the whole one in the detail).
  error: string | null;
  lines: number;
  incident: boolean;
};
export type RestartDetail = RestartRow & { errorText: string | null; logLines: string[]; heartbeat: Heartbeat | null };

type Db = {
  id: string;
  at: number;
  ended_at: number;
  instance: string;
  host: string;
  previous_start: number;
  uptime_ms: number;
  reason: RestartReason;
  signal: string | null;
  exit_code: number | null;
  version: string | null;
  heartbeat: string | null;
  error: string | null;
  line_count: number;
  incident: string | null;
};
const COLUMNS = "id,at,ended_at,instance,host,previous_start,uptime_ms,reason,signal,exit_code,version,heartbeat,error,line_count,incident";

const parse = <T>(text: string | null): T | null => {
  try {
    return text ? (JSON.parse(text) as T) : null;
  } catch {
    return null;
  }
};
function memoryOf(h: Heartbeat | null): RestartMemory | null {
  if (!h) return null;
  const share = memoryShare(h);
  return { rss: h.rss, limit: h.memLimit, workingSet: h.memWorkingSet, heapUsed: h.heapUsed, heapLimit: h.heapLimit, share: share === null ? null : Math.round(share * 1000) / 1000 };
}
function row(r: Db): RestartRow {
  return {
    id: r.id,
    at: Number(r.at),
    endedAt: Number(r.ended_at),
    instance: r.instance,
    host: r.host,
    previousStart: Number(r.previous_start),
    uptimeMs: Number(r.uptime_ms),
    reason: r.reason,
    signal: r.signal,
    code: r.exit_code === null ? null : Number(r.exit_code),
    version: r.version,
    memory: memoryOf(parse<Heartbeat>(r.heartbeat)),
    error: r.error ? r.error.split("\n")[0].slice(0, 300) : null,
    lines: Number(r.line_count || 0),
    incident: !!r.incident,
  };
}

// Stores what the previous runs left (taken by the tracker at the start).
// Returns the rows written.
export async function recordPreviousRuns(runs: PreviousRun[], now = Date.now()) {
  const written: string[] = [];
  for (const prev of runs) {
    const c = classifyRun(prev);
    if (!c) continue;
    const h = prev.heartbeat;
    const unexpected = c.reason !== "clean";
    const rowId = id();
    await run(
      `INSERT INTO restart_events(${COLUMNS},log_lines) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      rowId,
      now,
      c.endedAt,
      String(h.instance || h.key).slice(0, 120),
      String(h.host || "").slice(0, 80),
      h.startedAt,
      c.uptimeMs,
      c.reason,
      c.signal,
      c.code,
      h.version ? String(h.version).slice(0, 40) : null,
      JSON.stringify(h),
      c.error ? c.error.slice(0, 6000) : null,
      unexpected ? prev.lines.length : 0,
      null,
      unexpected && prev.lines.length ? JSON.stringify(prev.lines) : null,
    );
    written.push(rowId);
    if (unexpected)
      console.warn(
        `Restart: the previous run (${h.instance || h.key}, up ${Math.round(c.uptimeMs / 1000)} s) ended unexpectedly – ${c.reason}${c.error ? `: ${c.error.split("\n")[0]}` : ""}. Settings → Instance → Monitoring → Restarts has its last log lines.`,
      );
  }
  if (written.length) await checkRestartIncident(now);
  return written;
}

// The unexpected restarts of the last week, newest first, cut where two
// are an hour or more apart: the current chain.
async function currentChain(now: number) {
  const recent = await all<{ id: string; at: number; reason: RestartReason; incident: string | null; instance: string; error: string | null }>(
    "SELECT id,at,reason,incident,instance,error FROM restart_events WHERE reason<>'clean' AND at>=? ORDER BY at DESC LIMIT 200",
    now - 7 * DAY,
  );
  const chain: typeof recent = [];
  for (const r of recent) {
    if (chain.length && Number(chain[chain.length - 1].at) - Number(r.at) >= INCIDENT_GAP_MS) break;
    chain.push(r);
  }
  return chain;
}

const reasonName = (reason: RestartReason) =>
  ({
    clean: ct("sauber beendet", "clean"),
    crash: ct("Absturz", "crash"),
    oom: ct("vermutlich Speicher voll (OOM)", "likely out of memory (OOM)"),
    killed: ct("ohne Spur beendet", "killed without trace"),
  })[reason];

// Opens the incident when the current chain is one (a crash, or two or
// more within the hour) and it was not opened yet. Returns the key when it
// was opened here.
export async function checkRestartIncident(now = Date.now()) {
  const chain = await currentChain(now);
  if (!chain.length || Number(chain[0].at) < now - INCIDENT_SHOWN_MS) return null;
  if (chain.length < 2 && !chain.some((r) => r.reason === "crash")) return null;
  const first = chain[chain.length - 1];
  const key = `restart:${first.id}`;
  // Claimed on the first row: one process opens it, once.
  const opened = (await run("UPDATE restart_events SET incident=? WHERE id=? AND incident IS NULL", key, first.id)).changes > 0;
  await run(`UPDATE restart_events SET incident=? WHERE incident IS NULL AND id IN (${chain.map(() => "?").join(",")})`, key, ...chain.map((r) => r.id));
  if (!opened) return null;
  const instances = [...new Set(chain.map((r) => r.instance).filter(Boolean))];
  const crash = chain.find((r) => r.reason === "crash");
  const detail = [
    chain.length === 1
      ? ct("1 unerwarteter Neustart", "1 unexpected restart")
      : ct(`${chain.length} unerwartete Neustarts innerhalb einer Stunde`, `${chain.length} unexpected restarts within an hour`),
    [...new Set(chain.map((r) => reasonName(r.reason)))].join(", "),
    instances.length ? instances.join(", ") : null,
    crash?.error ? crash.error.split("\n")[0].slice(0, 200) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  await audit("", "instance.restart.incident", "instance", JSON.stringify({ restarts: chain.length, reasons: chain.map((r) => r.reason), instances }));
  console.error(`Restart: ${detail} (Settings → Instance → Monitoring → Restarts).`);
  const { sendIncidentAlert } = await import("../admin-ops");
  await sendIncidentAlert("unexpected_restart", key, detail, now).catch((error) => console.error("Restart alert failed", (error as Error)?.message));
  return key;
}

// For the health alerts and the landing page (lib/admin-ops.ts activeAlerts):
// an incident whose last restart is less than a day old.
export async function openRestartIncident(now = Date.now()) {
  const last = await one<{ incident: string; at: number }>("SELECT incident,at FROM restart_events WHERE incident IS NOT NULL ORDER BY at DESC LIMIT 1");
  if (!last || Number(last.at) < now - INCIDENT_SHOWN_MS) return null;
  const n = Number((await one<{ n: number }>("SELECT COUNT(*) n FROM restart_events WHERE incident=?", last.incident))?.n || 0);
  return { key: last.incident, restarts: n, lastAt: Number(last.at) };
}

export async function sweepRestartEvents(now = Date.now()) {
  await run("DELETE FROM restart_events WHERE at<?", now - RESTARTS_KEEP_DAYS * DAY);
  sweepLogFiles(now, RESTARTS_KEEP_DAYS * DAY);
}

/* ---------- Administration ---------- */

export type RestartHistory = { restarts: RestartRow[]; keepDays: number; unexpected24h: number; incident: Awaited<ReturnType<typeof openRestartIncident>> };
export async function restartHistory(now = Date.now(), limit = 100): Promise<RestartHistory> {
  const rows = await all<Db>(`SELECT ${COLUMNS} FROM restart_events WHERE at>=? ORDER BY at DESC LIMIT ?`, now - RESTARTS_KEEP_DAYS * DAY, limit);
  const restarts = rows.map(row);
  return {
    restarts,
    keepDays: RESTARTS_KEEP_DAYS,
    unexpected24h: restarts.filter((r) => r.reason !== "clean" && r.at >= now - DAY).length,
    incident: await openRestartIncident(now),
  };
}
export async function restartDetail(restartId: string): Promise<RestartDetail> {
  const r = await one<Db & { log_lines: string | null }>(`SELECT ${COLUMNS},log_lines FROM restart_events WHERE id=?`, restartId);
  if (!r) throw new HttpError(404, "Dieser Neustart ist nicht (mehr) gespeichert.");
  const lines = parse<unknown[]>(r.log_lines);
  return {
    ...row(r),
    errorText: r.error,
    logLines: Array.isArray(lines) ? lines.map((l) => String(l)) : [],
    heartbeat: parse<Heartbeat>(r.heartbeat),
  };
}
// The route (app/api/admin/monitoring/handler.ts ?view=restarts|restart):
// administrators in the browser only.
export async function restartsForAdmin(user: Identity, restartId?: string | null) {
  requireOpsAdmin(user);
  if (typeof restartId === "string") {
    if (!restartId) throw new HttpError(400, "Ungültige Eingabe.");
    return await restartDetail(restartId.slice(0, 80));
  }
  return await restartHistory();
}

/* ---------- Worker ---------- */

const runtime = globalThis as unknown as { flowplanRestartTimer?: ReturnType<typeof setInterval>; flowplanRestartSwept?: number };
async function recordTakenRuns(runs: PreviousRun[]) {
  if (!runs.length) return;
  await recordPreviousRuns(runs).catch((error) => console.error("Restart history failed", (error as Error)?.message));
}
// instrumentation.ts, once the database is open: the runs the tracker took
// over at the start, then every five minutes runs of other containers on
// the same data folder that went stale since.
export async function startRestartWorker() {
  if (runtime.flowplanRestartTimer) return;
  await recordTakenRuns(takePreviousRuns());
  runtime.flowplanRestartTimer = setInterval(() => {
    void recordTakenRuns(claimPreviousRuns());
    // This data folder's old log files (each instance may have its own).
    if (Date.now() - (runtime.flowplanRestartSwept ?? 0) >= DAY) {
      runtime.flowplanRestartSwept = Date.now();
      sweepLogFiles(Date.now(), RESTARTS_KEEP_DAYS * DAY);
    }
  }, 5 * 60_000);
  runtime.flowplanRestartTimer.unref?.();
}
