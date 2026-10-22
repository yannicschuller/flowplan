// Counters of refused requests for the operations dashboard
// (lib/admin-ops.ts): failed sign-ins, requests refused with 429 and
// anonymous uploads over their daily budget – and successful sign-ins (a new
// session, lib/auth.ts issueSession), for the sign-in chart. Limits usually refuse inside a
// transaction that is rolled back, so the events are written right after
// the current synchronous work (transactions here never span an await).
import { run } from "./db";

export const opsEventKinds = ["login_failure", "rate_limited", "anonymous_refused", "login_success"] as const;
export type OpsEventKind = (typeof opsEventKinds)[number];

const state = globalThis as unknown as { flowplanOpsPending?: { kind: OpsEventKind; at: number }[]; flowplanOpsFlush?: boolean; flowplanOpsWorkers?: Map<string, number> };

export function recordOpsEvent(kind: OpsEventKind, at = Date.now()) {
  // Successful sign-ins are usage statistics: not kept while they are
  // switched off (lib/metrics.ts).
  if (kind === "login_success" && (globalThis as { flowplanMetrics?: { enabled?: boolean } }).flowplanMetrics?.enabled === false) return;
  const pending = (state.flowplanOpsPending ??= []);
  // A flood of refusals must not grow memory without bound.
  if (pending.length < 10_000) pending.push({ kind, at });
  if (state.flowplanOpsFlush) return;
  state.flowplanOpsFlush = true;
  setImmediate(flushOpsEvents);
}

// The last run of a background worker and its last error (kept until a
// later run succeeds, with the time it happened).
export function noteWorkerRun(name: string, error?: unknown, at = Date.now()) {
  // Frequent workers (every few seconds) write a success once a minute.
  const written = (state.flowplanOpsWorkers ??= new Map());
  if (error === undefined && at - (written.get(name) ?? -Infinity) < 60_000) return;
  written.set(name, error === undefined ? at : -Infinity);
  try {
    if (error === undefined)
      run(
        "INSERT INTO ops_workers(name,last_run) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET last_run=excluded.last_run,last_error=NULL,error_at=NULL",
        name,
        at,
      );
    else
      run(
        "INSERT INTO ops_workers(name,last_run,last_error,error_at) VALUES(?,?,?,?) ON CONFLICT(name) DO UPDATE SET last_run=excluded.last_run,last_error=excluded.last_error,error_at=excluded.error_at",
        name,
        at,
        String((error as Error)?.message || error).slice(0, 300),
        at,
      );
  } catch {
    // The status is informative only.
  }
}

export function flushOpsEvents() {
  state.flowplanOpsFlush = false;
  const pending = state.flowplanOpsPending?.splice(0) || [];
  for (const event of pending)
    try {
      run("INSERT INTO ops_events(kind,at) VALUES(?,?)", event.kind, event.at);
    } catch {
      // Counting must never break the request that was refused.
    }
}
