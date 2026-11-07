// Which instances are alive (cluster mode): each writes a heartbeat into a
// Redis hash every 10 s; entries older than 30 s count as gone and are
// removed by whoever lists them. For the administration's system view and
// the leader's record of who leads.
import { hostname } from "node:os";
import { clusterMode, instanceId, redisPrefix } from "./config";
import { redis } from "./bus";
import { isLeader } from "./leader";

export type InstanceBeat = {
  id: string;
  host: string;
  pid: number;
  version: string | null;
  startedAt: number;
  seenAt: number;
  leader: boolean;
  ready: boolean;
  pool?: { total: number; idle: number; waiting: number };
  rssMb?: number;
  loopDelayMs?: number | null;
};

export const HEARTBEAT_MS = 10_000;
export const STALE_MS = 30_000;
const hashKey = () => `${redisPrefix()}instances`;

type State = { timer?: ReturnType<typeof setInterval>; startedAt: number; ready: () => boolean; extra: () => Partial<InstanceBeat> };
const holder = globalThis as unknown as { flowplanHeartbeat?: State };
const state = (): State => (holder.flowplanHeartbeat ??= { startedAt: Date.now(), ready: () => true, extra: () => ({}) });

export function beat(now = Date.now()): InstanceBeat {
  const s = state();
  return {
    id: instanceId(),
    host: hostname(),
    pid: process.pid,
    version: process.env.FLOWPLAN_VERSION || null,
    startedAt: s.startedAt,
    seenAt: now,
    leader: isLeader(),
    ready: s.ready(),
    rssMb: Math.round(process.memoryUsage().rss / 1048576),
    ...s.extra(),
  };
}

export async function sendHeartbeat() {
  await redis().command("HSET", hashKey(), instanceId(), JSON.stringify(beat()));
}

// Starts the heartbeat (cluster mode; idempotent). `ready` and `extra`
// add what lib/cluster/runtime.ts knows (readiness, pool).
export function startHeartbeat(options: { ready?: () => boolean; extra?: () => Partial<InstanceBeat> } = {}) {
  const s = state();
  if (options.ready) s.ready = options.ready;
  if (options.extra) s.extra = options.extra;
  if (!clusterMode() || s.timer) return;
  const tick = () => void sendHeartbeat().catch(() => {});
  s.timer = setInterval(tick, HEARTBEAT_MS);
  s.timer.unref?.();
  tick();
}

export async function stopHeartbeat() {
  const s = state();
  if (s.timer) clearInterval(s.timer);
  s.timer = undefined;
  if (clusterMode()) await redis().command("HDEL", hashKey(), instanceId()).catch(() => {});
}

// The instances alive now, this one first; stale entries are dropped.
export async function liveInstances(now = Date.now()): Promise<InstanceBeat[]> {
  if (!clusterMode()) return [beat(now)];
  const raw = (await redis().command("HGETALL", hashKey())) as string[] | null;
  const alive: InstanceBeat[] = [];
  const stale: string[] = [];
  for (let i = 0; raw && i < raw.length; i += 2) {
    try {
      const entry = JSON.parse(raw[i + 1]) as InstanceBeat;
      if (now - entry.seenAt > STALE_MS) stale.push(raw[i]);
      else alive.push(entry);
    } catch {
      stale.push(raw[i]);
    }
  }
  if (stale.length) await redis().command("HDEL", hashKey(), ...stale).catch(() => {});
  const self = instanceId();
  return alive.sort((a, b) => (a.id === self ? -1 : b.id === self ? 1 : a.startedAt - b.startedAt));
}
