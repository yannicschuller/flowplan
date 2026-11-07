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

// Which checks decide readiness (FLOWPLAN_READY_REQUIRE, a comma list;
// default all of them). Redis and the bucket are shared by every instance:
// when one is away, all instances turn unready together and the balancer
// has nothing left – leaving them out keeps the instances serving (editing
// works without Redis; live updates between instances and shared limits
// pause) while the checks still show the failure.
export function readinessRequires(env: Record<string, string | undefined> = process.env): Set<string> {
  const raw = env.FLOWPLAN_READY_REQUIRE?.trim();
  return new Set(raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : ["database", "redis", "objectStorage"]);
}

export async function readiness() {
  const checks: Record<string, Check> = { database: await checkDatabase() };
  if (clusterMode()) {
    const [redisCheck, bucket] = await Promise.all([checkRedis(), checkBucket()]);
    checks.redis = redisCheck;
    checks.objectStorage = bucket;
  }
  const stopping = shuttingDown();
  const required = readinessRequires();
  // The database always counts.
  const ready = !stopping && Object.entries(checks).every(([name, c]) => c.ok || (name !== "database" && !required.has(name)));
  return { ready, stopping, checks };
}
