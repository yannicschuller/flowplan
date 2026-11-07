// The leader: in cluster mode exactly one instance runs the singleton duties
// – timed workers (schedules, digests, reminders, cleanup, syncs), staged
// restores. It is whoever holds a session-level advisory lock on the
// dedicated connection (lib/cluster/pg-session.ts): the lock lives as long
// as that connection, so when the leader stops, crashes or loses the
// database, PostgreSQL frees it and the next instance to try takes over
// (within FLOWPLAN_LEADER_INTERVAL, default 5 s). No Redis needed for it.
//
// Outside cluster mode this process is the only one and always leads.
// Workers ask isLeader() at the start of each round:
//
//   setInterval(() => { if (!isLeader()) return; … }, 60_000);
import { clusterMode, instanceId } from "./config";
import { postgresSchema } from "../db-driver/context";
import { sessionGeneration, sessionQuery } from "./pg-session";

type State = {
  leader: boolean;
  since: number | null;
  generation: number;
  timer?: ReturnType<typeof setInterval>;
  running: boolean;
  handlers: Set<(leader: boolean) => void>;
  lastError: string | null;
};
const holder = globalThis as unknown as { flowplanLeader?: State };
const state = (): State => (holder.flowplanLeader ??= { leader: false, since: null, generation: -1, running: false, handlers: new Set(), lastError: null });

// One lock per installation (schema): tests run several on one database.
export const leaderLockKey = () => `flowplan:leader:${postgresSchema()}`;

export function isLeader(): boolean {
  if (!clusterMode()) return true;
  return state().leader;
}
export function leaderSince() {
  return clusterMode() ? state().since : null;
}
export function leaderError() {
  return state().lastError;
}
// Called with true when this instance becomes leader, false when it stops.
export function onLeadership(handler: (leader: boolean) => void) {
  state().handlers.add(handler);
  return () => state().handlers.delete(handler);
}

function change(s: State, leader: boolean) {
  if (s.leader === leader) return;
  s.leader = leader;
  s.since = leader ? Date.now() : null;
  console.log(leader ? `Cluster: ${instanceId()} is now the leader` : `Cluster: ${instanceId()} is no longer the leader`);
  for (const handler of s.handlers)
    try {
      handler(leader);
    } catch (error) {
      console.error("Cluster: leadership handler failed", error);
    }
}

// One round: keep or try to take the lock.
export async function electionRound() {
  const s = state();
  try {
    if (s.leader) {
      // Still the same connection? A new one has lost the lock with the old.
      await sessionQuery("SELECT 1");
      if (sessionGeneration() !== s.generation) change(s, false);
      else return;
    }
    const { rows } = await sessionQuery<{ ok: boolean | number }>("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS ok", [leaderLockKey()]);
    s.lastError = null;
    if (rows[0]?.ok) {
      s.generation = sessionGeneration();
      change(s, true);
    }
  } catch (error) {
    s.lastError = (error as Error).message;
    change(s, false);
  }
}

// Starts the election (cluster mode only; idempotent).
export function startLeaderElection() {
  const s = state();
  if (!clusterMode() || s.timer) return;
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
