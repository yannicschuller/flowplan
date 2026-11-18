// Parallel AI answers per person (AI_LIMITS.concurrent, lib/ai/run.ts).
//
// A single container counts in memory. In cluster mode a person's requests
// reach different instances, so the count is shared through Redis: one
// sorted set per person, an entry per running answer with the time it
// lapses as its score. Taking a slot is one Lua script (drop lapsed
// entries, refuse when full, add) and so atomic across instances; giving it
// back removes the entry. An entry lapses after SLOT_TTL_MS unless the
// instance running the answer renews it (every RENEW_MS while it streams) –
// so an instance that crashed mid-answer frees its slots by itself instead
// of blocking the person (a plain INCR/DECR counter would stay up).
//
// Redis away (or failing, or slower than ANSWER_MS): each instance counts
// on its own, as a single container does (fail open, logged once until
// Redis answers again) and asks Redis again after DOWN_MS – a request never
// waits for an absent Redis longer than ANSWER_MS.
import { randomUUID } from "node:crypto";
import { clusterMode, redisPrefix } from "../cluster/config";
import { redis } from "../cluster/bus";

export const SLOT_TTL_MS = 120_000;
const RENEW_MS = 30_000;
const ANSWER_MS = 1_000;
const DOWN_MS = 15_000;

const TAKE = `-- ai-slot take
local key, now, ttl, max = KEYS[1], tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', key, '-inf', now)
if redis.call('ZCARD', key) >= max then return 0 end
redis.call('ZADD', key, now + ttl, ARGV[4])
redis.call('PEXPIRE', key, ttl)
return 1`;
const RENEW = `-- ai-slot renew
if redis.call('ZSCORE', KEYS[1], ARGV[2]) then
  redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2])
  redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[3]))
end
return 1`;

type State = { local: Map<string, number>; redisDown: boolean; downAt: number };
const holder = globalThis as unknown as { flowplanAiSlots?: State };
const state = (): State => (holder.flowplanAiSlots ??= { local: new Map(), redisDown: false, downAt: 0 });
const keyOf = (userId: string) => `${redisPrefix()}ai-running:${userId}`;

function takeLocal(userId: string, max: number): (() => void) | null {
  const s = state();
  const count = s.local.get(userId) || 0;
  if (count >= max) return null;
  s.local.set(userId, count + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (s.local.get(userId) || 1) - 1;
    if (left > 0) s.local.set(userId, left);
    else s.local.delete(userId);
  };
}

function redisFailed(error: unknown) {
  const s = state();
  s.downAt = Date.now();
  if (s.redisDown) return;
  s.redisDown = true;
  console.error("AI: Redis unavailable, parallel AI answers are counted per instance", (error as Error)?.message || error);
}

// A slot for one answer of the person, or null when `max` run already.
// The function returned gives it back (call it once the answer ended;
// further calls do nothing).
export async function takeAiSlot(userId: string, max: number, now = Date.now()): Promise<(() => void) | null> {
  if (!clusterMode()) return takeLocal(userId, max);
  const s = state();
  if (s.redisDown && Date.now() - s.downAt < DOWN_MS) return takeLocal(userId, max);
  const key = keyOf(userId);
  const slot = randomUUID();
  let taken: boolean;
  try {
    const asked = redis().eval(TAKE, [key], [now, SLOT_TTL_MS, max, slot]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer within ${ANSWER_MS} ms`)), ANSWER_MS);
    });
    try {
      taken = Number(await Promise.race([asked, late])) === 1;
    } catch (error) {
      // A slot taken after all, too late: given back.
      void asked.then((answer) => (Number(answer) === 1 ? redis().command("ZREM", key, slot) : null)).catch(() => {});
      throw error;
    } finally {
      clearTimeout(timer);
    }
    if (state().redisDown) {
      state().redisDown = false;
      console.log("AI: Redis answers again, parallel AI answers are counted across instances");
    }
  } catch (error) {
    redisFailed(error);
    return takeLocal(userId, max);
  }
  if (!taken) return null;
  const renew = setInterval(() => {
    void redis()
      .eval(RENEW, [key], [Date.now() + SLOT_TTL_MS, slot, SLOT_TTL_MS])
      .catch(() => {});
  }, RENEW_MS);
  renew.unref?.();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    clearInterval(renew);
    // If this fails, the entry lapses after SLOT_TTL_MS.
    void redis()
      .command("ZREM", key, slot)
      .catch(() => {});
  };
}
