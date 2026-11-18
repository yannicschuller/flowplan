// Without cluster mode Flowplan assumes it is the only process on its
// database: timed jobs (reminders, digests, backups, workflows …) run on
// every instance, live updates and rate limits stay in the process. Two
// instances against one PostgreSQL database without FLOWPLAN_CLUSTER=1
// would run every job twice and miss each other's live updates.
//
// So on PostgreSQL outside cluster mode each instance takes a session-level
// advisory lock ("flowplan:single-instance:<schema>") on its session
// connection (lib/cluster/pg-session.ts; no extra connection) and checks
// it again every 30 s. Whoever does not get it logs a loud error and
// records itself in flowplan_meta (`single_instance_conflict:<instance>`,
// renewed with each check), which Administration → Überwachung shows as a
// warning on every instance (lib/cluster/system.ts). It still starts and
// serves: a rolling restart or a blue-green switch overlaps two instances
// for a moment. Once it gets the lock (the other one stopped) its record is
// removed and the warning ends. The lock goes back when the instance stops
// (and with its connection anyway). SQLite: one file, one process – not
// applicable.
import { hostname } from "node:os";
import { clusterMode, instanceId } from "./config";
import { postgresSchema, postgresUrl } from "../db-driver/context";
import { sessionGeneration, sessionQuery } from "./pg-session";

export const SINGLE_INSTANCE_CHECK_MS = 30_000;
// A record not renewed for this long is of an instance that is gone.
export const SINGLE_INSTANCE_STALE_MS = 2 * 60_000;
const RECORD = "single_instance_conflict:";
export const singleInstanceLockKey = () => `flowplan:single-instance:${postgresSchema()}`;

type State = { held: boolean; generation: number; since: number | null; logged: number; timer?: ReturnType<typeof setInterval>; running: boolean };
const holder = globalThis as unknown as { flowplanSingleInstance?: State };
const state = (): State => (holder.flowplanSingleInstance ??= { held: false, generation: -1, since: null, logged: 0, running: false });

export const singleInstanceGuarded = () => !clusterMode() && !!postgresUrl();
export const singleInstanceHeld = () => state().held;

export type SecondInstance = { instance: string; host: string; since: number; seenAt: number };

// One check: keep or take the lock; without it, record this instance.
// Returns whether this instance holds the lock.
export async function checkSingleInstance(now = Date.now()): Promise<boolean> {
  const s = state();
  if (s.held && sessionGeneration() === s.generation) return true;
  // A new session connection has lost the lock with the old one.
  s.held = false;
  const { rows } = await sessionQuery<{ ok: boolean }>("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS ok", [singleInstanceLockKey()]);
  if (rows[0]?.ok) {
    s.held = true;
    s.generation = sessionGeneration();
    if (s.since !== null) console.log("Flowplan: no other instance on this database any more – the warning about a second instance ends.");
    s.since = null;
    // This instance's record, and records of instances that are gone.
    await sessionQuery("DELETE FROM flowplan_meta WHERE key=$1", [`${RECORD}${instanceId()}`]);
    for (const record of await records())
      if (now - record.seenAt > SINGLE_INSTANCE_STALE_MS) await sessionQuery("DELETE FROM flowplan_meta WHERE key=$1", [`${RECORD}${record.instance}`]);
    return true;
  }
  s.since ??= now;
  const record: SecondInstance = { instance: instanceId(), host: hostname().slice(0, 80), since: s.since, seenAt: now };
  // (A new database: the opening steps may not have made it yet.)
  await sessionQuery("CREATE TABLE IF NOT EXISTS flowplan_meta(key text PRIMARY KEY,value text NOT NULL)");
  await sessionQuery("INSERT INTO flowplan_meta(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [`${RECORD}${record.instance}`, JSON.stringify(record)]);
  if (now - s.logged > 10 * 60_000) {
    s.logged = now;
    console.error(
      [
        "==========================================================================",
        "Flowplan: ANOTHER FLOWPLAN INSTANCE IS RUNNING AGAINST THIS DATABASE WITHOUT CLUSTER MODE.",
        `  This instance (${record.instance}) did not get the lock ${singleInstanceLockKey()}.`,
        "  Timed jobs (reminders, digests, backups, workflows) then run twice and live updates",
        "  do not reach the other instance. Either switch cluster mode on (FLOWPLAN_CLUSTER=1",
        "  with Redis and S3) on every instance, or stop one of them. During a rolling restart",
        "  this is expected for a moment.",
        "==========================================================================",
      ].join("\n"),
    );
  }
  return false;
}

async function records(): Promise<SecondInstance[]> {
  const { rows } = await sessionQuery<{ value: string }>("SELECT value FROM flowplan_meta WHERE key LIKE $1", [`${RECORD}%`]);
  const out: SecondInstance[] = [];
  for (const row of rows)
    try {
      const record = JSON.parse(row.value) as SecondInstance;
      if (record && typeof record.instance === "string" && typeof record.seenAt === "number") out.push(record);
    } catch {}
  return out;
}

// The instances recorded without the lock and still alive (Administration;
// every instance reads the same rows). Empty in cluster mode and on SQLite.
export async function secondInstances(now = Date.now()): Promise<SecondInstance[]> {
  if (!singleInstanceGuarded()) return [];
  try {
    return (await records()).filter((r) => now - r.seenAt <= SINGLE_INSTANCE_STALE_MS).sort((a, b) => a.since - b.since);
  } catch {
    return [];
  }
}

// At the start (lib/cluster/runtime.ts): PostgreSQL outside cluster mode
// only; the first check at once, then every SINGLE_INSTANCE_CHECK_MS. Never
// keeps the instance from starting.
export function startSingleInstanceGuard() {
  const s = state();
  if (!singleInstanceGuarded() || s.timer) return;
  const round = async () => {
    if (s.running) return;
    s.running = true;
    try {
      await checkSingleInstance();
    } catch (error) {
      console.error("Flowplan: the check for a second instance failed", (error as Error)?.message || error);
    } finally {
      s.running = false;
    }
  };
  s.timer = setInterval(() => void round(), SINGLE_INSTANCE_CHECK_MS);
  s.timer.unref?.();
  void round();
}

// At shutdown: the lock goes back (the next instance of a rolling restart
// gets it at once), the record of a waiting instance goes.
export async function releaseSingleInstance() {
  const s = state();
  if (s.timer) clearInterval(s.timer);
  s.timer = undefined;
  if (!singleInstanceGuarded()) return;
  try {
    if (s.held && sessionGeneration() === s.generation) await sessionQuery("SELECT pg_advisory_unlock(hashtextextended($1,0))", [singleInstanceLockKey()]);
    else await sessionQuery("DELETE FROM flowplan_meta WHERE key=$1", [`${RECORD}${instanceId()}`]);
  } catch {}
  s.held = false;
  s.since = null;
}
