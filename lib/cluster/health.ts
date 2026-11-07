// Liveness and readiness (both modes), and the system overview for the
// administration (lib/cluster/system.ts uses these checks).
//
// - Liveness (/api/health/live): the process answers. A failing database
//   does not make it "dead" – restarting would not help.
// - Readiness (/api/health/ready): it should get requests: the database
//   answers, and in cluster mode Redis and the bucket too; not while the
//   instance is stopping (lib/cluster/runtime.ts).
import { one } from "../db";
import { clusterMode } from "./config";
import { redis } from "./bus";
import { shuttingDown } from "./runtime";
import { bucketFetch, storageConfig } from "../storage";

export type Check = { ok: boolean; ms: number; error?: string };

async function timed(fn: () => Promise<unknown>, timeoutMs = 3000): Promise<Check> {
  const start = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      fn(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer within ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
    return { ok: true, ms: Math.round(performance.now() - start) };
  } catch (error) {
    return { ok: false, ms: Math.round(performance.now() - start), error: String((error as Error)?.message || error).slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}

export const checkDatabase = () => timed(() => one("SELECT 1"));
export const checkRedis = () =>
  timed(async () => {
    if ((await redis().command("PING")) !== "PONG") throw new Error("unexpected answer");
  });
// The bucket answers a listing of this instance's prefix (cached 10 s: a
// probe every few seconds per instance would be a request each time).
let bucketCache: { at: number; check: Check } | null = null;
export async function checkBucket(now = Date.now()): Promise<Check> {
  if (!storageConfig()) return { ok: false, ms: 0, error: "S3_BUCKET is not set" };
  if (bucketCache && now - bucketCache.at < 10_000) return bucketCache.check;
  const check = await timed(async () => {
    const response = await bucketFetch(`?list-type=2&max-keys=1&prefix=${encodeURIComponent(storageConfig()!.prefix)}`, { method: "GET" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  });
  bucketCache = { at: now, check };
  return check;
}

export async function readiness() {
  const checks: Record<string, Check> = { database: await checkDatabase() };
  if (clusterMode()) {
    const [redisCheck, bucket] = await Promise.all([checkRedis(), checkBucket()]);
    checks.redis = redisCheck;
    checks.objectStorage = bucket;
  }
  const stopping = shuttingDown();
  return { ready: !stopping && Object.values(checks).every((c) => c.ok), stopping, checks };
}
