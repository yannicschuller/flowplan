// The leader: in cluster mode exactly one instance runs the singleton duties
// – timed workers (schedules, digests, reminders, cleanup, syncs), staged
// restores. It is whoever holds a session-level advisory lock on the
// dedicated connection (lib/cluster/pg-session.ts): the lock lives as long
// as that connection, so when the leader stops, crashes or loses the
// database, PostgreSQL frees it and the next instance to try takes over
// (within FLOWPLAN_LEADER_INTERVAL, default 5 s). No Redis needed for it.
//
// Outside cluster mode this process is the only one and always leads – or,
// with several processes on the host (FLOWPLAN_PROCESSES), process 1 leads
// and the others never do (lib/cluster/processes.ts).
// Workers run each round through leaderDuty():
//
//   setInterval(() => void leaderDuty("reminders", async () => { … }), 60_000);
//
// Fencing: taking the lock raises a term in flowplan_meta ("leader_term");
// the leader's term is its token. A round starts only when (1) this
// instance leads, (2) the term in the database is still its own – an
// instance that lost the lead without noticing yet (its connection broke)
// sees the newer term and skips – and (3) it gets the duty's own advisory
// lock on a second session connection ("duties", lib/cluster/pg-session.ts):
// a round an old leader is still running holds that lock until it ends, so
// the new leader's round of the same duty waits for the next tick instead
// of running beside it. A stopping instance starts no new rounds and waits
// for the running ones (lib/cluster/runtime.ts).
import { clusterMode, instanceId } from "./config";
import { postgresSchema } from "../db-driver/context";
import { dutySessionGeneration, dutySessionQuery, sessionGeneration, sessionQuery } from "./pg-session";
import { primaryProcess } from "./processes";

type State = {
  leader: boolean;
  since: number | null;
  generation: number;
  // The fencing token: the term this instance took the lead with.
  term: number | null;
  timer?: ReturnType<typeof setInterval>;
  running: boolean;
  handlers: Set<(leader: boolean) => void>;
  lastError: string | null;
  stopped: boolean;
  duties: Set<Promise<unknown>>;
  // Duties with a round running in this process (cluster mode).
  active: Set<string>;
  skipped: number;
};
const holder = globalThis as unknown as { flowplanLeader?: State };
const state = (): State =>
  (holder.flowplanLeader ??= { leader: false, since: null, generation: -1, term: null, running: false, handlers: new Set(), lastError: null, stopped: false, duties: new Set(), active: new Set(), skipped: 0 });

// One lock per installation (schema): tests run several on one database.
export const leaderLockKey = () => `flowplan:leader:${postgresSchema()}`;
export const dutyLockKey = (name: string) => `flowplan:duty:${postgresSchema()}:${name}`;

export function isLeader(): boolean {
  if (!clusterMode()) return primaryProcess();
  return state().leader;
}
export function leaderSince() {
  return clusterMode() ? state().since : null;
}
export function leaderError() {
  return state().lastError;
}
// The fencing token of this instance's lead (null: not leading).
export function leaderTerm() {
  return clusterMode() && state().leader ? state().term : null;
}
// Rounds left out because another round of the same duty was still running
// or the term had moved on (system view, tests).
export const skippedDuties = () => state().skipped;
// Called with true when this instance becomes leader, false when it stops.
export function onLeadership(handler: (leader: boolean) => void) {
  state().handlers.add(handler);
  return () => state().handlers.delete(handler);
}

function change(s: State, leader: boolean) {
  if (s.leader === leader) return;
  s.leader = leader;
  s.since = leader ? Date.now() : null;
  if (!leader) s.term = null;
  console.log(leader ? `Cluster: ${instanceId()} is now the leader (term ${s.term})` : `Cluster: ${instanceId()} is no longer the leader`);
  for (const handler of s.handlers)
    try {
      handler(leader);
    } catch (error) {
      console.error("Cluster: leadership handler failed", error);
    }
}

// The next term, written by the instance that holds the leader lock.
async function raiseTerm(): Promise<number> {
  await sessionQuery("CREATE TABLE IF NOT EXISTS flowplan_meta(key text PRIMARY KEY,value text NOT NULL)");
  const { rows } = await sessionQuery<{ value: string }>(
    "INSERT INTO flowplan_meta(key,value) VALUES('leader_term','1') ON CONFLICT(key) DO UPDATE SET value=(CASE WHEN flowplan_meta.value ~ '^[0-9]+$' THEN flowplan_meta.value::bigint ELSE 0 END+1)::text RETURNING value",
  );
  return Number(rows[0].value);
}

// One round: keep or try to take the lock.
export async function electionRound() {
  const s = state();
  if (s.stopped) return;
  try {
    if (s.leader) {
      // Still the same connection? A new one has lost the lock with the old.
      const { rows } = await sessionQuery<{ term: string | null }>("SELECT (SELECT value FROM flowplan_meta WHERE key='leader_term') AS term");
      if (sessionGeneration() !== s.generation) change(s, false);
      else {
        // The lock is ours, the term is not (a restore replaced the table):
        // a new one, so rounds can start again.
        if (Number(rows[0]?.term) !== s.term) s.term = await raiseTerm();
        return;
      }
    }
    const { rows } = await sessionQuery<{ ok: boolean | number }>("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS ok", [leaderLockKey()]);
    s.lastError = null;
    if (rows[0]?.ok) {
      try {
        s.term = await raiseTerm();
      } catch (error) {
        // Without a term no round could start: give the lock back.
        await sessionQuery("SELECT pg_advisory_unlock(hashtextextended($1,0))", [leaderLockKey()]).catch(() => {});
        throw error;
      }
      s.generation = sessionGeneration();
      change(s, true);
    }
  } catch (error) {
    s.lastError = (error as Error).message;
    change(s, false);
  }
}

// Runs one round of a singleton duty – on the leader only, fenced (see the
// top of this file). Returns fn's result, or undefined when the round was
// left out. Outside cluster mode fn runs as before (and counts for the
// shutdown's wait) – in process 1 only when the host runs several.
export async function leaderDuty<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
  const s = state();
  if (s.stopped) return undefined;
  if (!clusterMode()) return primaryProcess() ? await track(s, fn) : undefined;
  if (!s.leader || s.term === null) return undefined;
  // The duty locks are re-entrant within a session: a round of this
  // process still running is checked here.
  if (s.active.has(name)) {
    s.skipped++;
    return undefined;
  }
  s.active.add(name);
  try {
    return await fencedRound(s, name, fn);
  } finally {
    s.active.delete(name);
  }
}
async function fencedRound<T>(s: State, name: string, fn: () => Promise<T>): Promise<T | undefined> {
  const term = s.term;
  const key = dutyLockKey(name);
  let lockedOn: number | null = null;
  try {
    const { rows } = await dutySessionQuery<{ ok: boolean; term: string | null }>(
      "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS ok, (SELECT value FROM flowplan_meta WHERE key='leader_term') AS term",
      [key],
    );
    if (rows[0]?.ok) lockedOn = dutySessionGeneration();
    if (lockedOn === null || Number(rows[0].term) !== term || s.term !== term || !s.leader || s.stopped) {
      // Not ours to run (now): the lock, if taken, goes back at once.
      if (lockedOn !== null) await unlockDuty(key, lockedOn);
      s.skipped++;
      return undefined;
    }
  } catch (error) {
    s.lastError = (error as Error).message;
    if (lockedOn !== null) await unlockDuty(key, lockedOn);
    s.skipped++;
    return undefined;
  }
  try {
    return await track(s, fn);
  } finally {
    await unlockDuty(key, lockedOn);
  }
}
async function unlockDuty(key: string, generation: number) {
  // On a renewed connection the lock is gone already.
  if (dutySessionGeneration() !== generation) return;
  await dutySessionQuery("SELECT pg_advisory_unlock(hashtextextended($1,0))", [key]).catch(() => {});
}
async function track<T>(s: State, fn: () => Promise<T>): Promise<T> {
  const p = fn();
  s.duties.add(p);
  try {
    return await p;
  } finally {
    s.duties.delete(p);
  }
}
// Shutdown: no new rounds (the election stops too) …
export function stopDuties() {
  state().stopped = true;
}
// … and the running ones finish, at most until `deadline`.
export async function waitForDuties(deadline: number) {
  const s = state();
  while (s.duties.size && Date.now() < deadline) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.allSettled([...s.duties]), new Promise((r) => (timer = setTimeout(r, Math.max(0, deadline - Date.now()))))]);
    clearTimeout(timer);
  }
}

// Starts the election (cluster mode only; idempotent).
export function startLeaderElection() {
  const s = state();
  if (!clusterMode() || s.timer || s.stopped) return;
  const every = Math.max(500, Number(process.env.FLOWPLAN_LEADER_INTERVAL) || 5000);
  const round = async () => {
    if (s.running) return;
    s.running = true;
    try {
      await electionRound();
    } finally {
      s.running = false;
    }
  };
  s.timer = setInterval(() => void round(), every);
  s.timer.unref?.();
  void round();
}

// Gives the lead up (graceful shutdown): another instance takes over at
// its next round instead of waiting for this connection to close.
export async function resignLeadership() {
  const s = state();
  if (s.timer) clearInterval(s.timer);
  s.timer = undefined;
  if (!s.leader) return;
  try {
    // All of this session's advisory locks: the leader lock is the only one,
    // possibly taken more than once (it is re-entrant) after a failed round.
    await sessionQuery("SELECT pg_advisory_unlock_all()");
  } catch {}
  change(s, false);
}
