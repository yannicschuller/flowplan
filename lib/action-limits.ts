// Limits for actions that reach people outside: invitations, shared pages
// and their e-mails, AI requests, sign-up and reset attempts. Counted in
// memory (one server process); a restart starts the count again, which is
// fine for this purpose.
//
// Cluster mode (lib/cluster): the count is shared through Redis as well.
// The decision stays synchronous and local – every caller keeps its
// signature – and each allowed action is also recorded in a sorted set in
// Redis (a sliding window, one Lua script). When the shared count is over
// the limit, this instance refuses the key until the window has room again,
// and tells the others (bus message), which do the same. So across N
// instances a key gets at most its limit plus about one action per
// instance in flight – not N times the limit. If Redis is away, each
// instance keeps counting on its own (logged), as a single container does.
import { HttpError } from "./auth";
import { clusterMode, instanceId, redisPrefix } from "./cluster/config";
import { onBus, publish, redis } from "./cluster/bus";

const hits = new Map<string, number[]>();
// Refused until (ms), from the shared count (cluster mode).
const blocked = new Map<string, number>();
const pending = new Set<Promise<unknown>>();
let sequence = 0;
let failures = 0;

// Records an allowed action in the shared window; answers the time until
// which the key is full (0: there is room).
const SHARED_WINDOW = `
local key, now, window, max = KEYS[1], tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
redis.call('ZADD', key, now, ARGV[4])
redis.call('PEXPIRE', key, window)
local n = redis.call('ZCARD', key)
if n < max then return 0 end
local entry = redis.call('ZRANGE', key, n - max, n - max, 'WITHSCORES')
return tonumber(entry[2]) + window`;

function block(key: string, until: number) {
  if (until > (blocked.get(key) || 0)) blocked.set(key, until);
  if (blocked.size > 10_000) {
    const now = Date.now();
    for (const [k, at] of blocked) if (at <= now) blocked.delete(k);
  }
}
const listening = globalThis as unknown as { flowplanLimitBus?: boolean };
function listen() {
  if (listening.flowplanLimitBus) return;
  listening.flowplanLimitBus = true;
  onBus("limit", (payload) => {
    const { key, until } = payload as { key: string; until: number };
    if (typeof key === "string" && typeof until === "number") block(key, until);
  });
}

function share(key: string, max: number, windowMs: number, now: number) {
  listen();
  const job = redis()
    .eval(SHARED_WINDOW, [`${redisPrefix()}limit:${key}`], [now, windowMs, max, `${now}:${instanceId()}:${sequence++}`])
    .then((answer) => {
      const until = Number(answer) || 0;
      if (until > Date.now()) {
        block(key, until);
        publish("limit", { key, until });
      }
    })
    .catch((error) => {
      if (failures++ % 100 === 0) console.error("Rate limits: Redis unavailable, counting per instance", (error as Error).message);
    })
    .finally(() => pending.delete(job));
  pending.add(job);
}
// Waits for the shared counts sent so far (tests).
export async function settleLimits() {
  await Promise.all([...pending]);
}

// Whether `key` may act again: at most `max` times within `windowMs`.
export function allow(key: string, max: number, windowMs: number, now = Date.now()) {
  const until = blocked.get(key);
  if (until !== undefined) {
    if (until > now) return false;
    blocked.delete(key);
  }
  const recent = (hits.get(key) || []).filter((at) => at > now - windowMs);
  if (recent.length >= max) {
    hits.set(key, recent);
    return false;
  }
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 10_000) for (const [k, list] of hits) if (!list.some((at) => at > now - windowMs)) hits.delete(k);
  if (clusterMode()) share(key, max, windowMs, now);
  return true;
}
export function requireAllowed(key: string, max: number, windowMs: number) {
  if (!allow(key, max, windowMs)) throw new HttpError(429, "Zu viele Einladungen in kurzer Zeit. Bitte später erneut versuchen.");
}
const HOUR = 3_600_000;
// Per person who invites or shares, and per address that receives mail.
export const limitInviter = (userId: string) => requireAllowed(`inviter:${userId}`, 40, HOUR);
export const mailAllowed = (email: string) => allow(`mail:${email.toLowerCase()}`, 5, HOUR);
// AI requests per person (lib/ai/run.ts): a burst limit and an hourly one,
// FLOWPLAN_AI_REQUESTS_PER_HOUR to change the latter.
const aiPerHour = () => Math.max(1, Number(process.env.FLOWPLAN_AI_REQUESTS_PER_HOUR) || 300);
export function limitAi(userId: string) {
  if (!allow(`ai:${userId}`, 30, 60_000) || !allow(`ai-hour:${userId}`, aiPerHour(), HOUR))
    throw new HttpError(429, "Zu viele KI-Anfragen in kurzer Zeit. Bitte später erneut versuchen.");
}
// AI lookups without a provider call (page titles in an answer → links):
// no slot of the AI limit, but a ceiling against a client in a loop.
export function limitAiLookup(userId: string) {
  if (!allow(`ai-lookup:${userId}`, 120, 60_000))
    throw new HttpError(429, "Zu viele KI-Anfragen in kurzer Zeit. Bitte später erneut versuchen.");
}
// Connection tests, model lists and downloads in the settings.
export function limitAiSetup(userId: string) {
  if (!allow(`ai-setup:${userId}`, 20, 10 * 60_000))
    throw new HttpError(429, "Zu viele KI-Anfragen in kurzer Zeit. Bitte später erneut versuchen.");
}
