// Liveness and readiness (both modes), and the system overview for the
// administration (lib/cluster/system.ts uses these checks).
//
// - Liveness (/api/health/live): the process answers. A failing database
//   does not make it "dead" – restarting would not help.
// - Readiness (/api/health/ready): it should get requests: the opening
//   steps are done (schema, data steps – checkOpening below), the database
//   answers, and in cluster mode Redis and the bucket too (which of those
//   two count: FLOWPLAN_READY_REQUIRE); not while the instance is stopping
//   (lib/cluster/runtime.ts).
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

// The opening steps (lib/db-driver/index.ts): the schema of this version on
// PostgreSQL, a staged restore, the storage queue and the data steps. Ready
// only once they are done; a failure keeps the instance out of the rotation
// with the reason (a rolling update then stops at this pod instead of
// replacing working ones). Failed data steps are tried again at most once
// a minute; the database's schema must be at least this version's
// (FLOWPLAN_PG_SCHEMA_AUTO=off leaves it to the migration Job).
const retry = globalThis as unknown as { flowplanStepRetry?: number };
export async function checkOpening(now = Date.now()): Promise<Check> {
  const start = performance.now();
  const ms = () => Math.round(performance.now() - start);
  const { openingState, startOpening } = await import("../db-driver");
  let opening = openingState();
  if (opening.state === "pending") {
    // A new instance: the probe starts the opening, and waits briefly.
    await Promise.race([startOpening(), new Promise((r) => setTimeout(r, 2000).unref?.())]);
    opening = openingState();
  }
  if (opening.state === "pending" || opening.state === "running") return { ok: false, ms: ms(), error: "opening steps still running" };
  if (opening.state === "failed") return { ok: false, ms: ms(), error: `opening steps failed: ${opening.error}` };
  const { failedDataSteps, runDataSteps } = await import("../data-steps");
  const failed = failedDataSteps();
  if (failed.size) {
    if (now - (retry.flowplanStepRetry ?? 0) > 60_000) {
      retry.flowplanStepRetry = now;
      void runDataSteps([...failed.keys()]).catch(() => {});
    }
    const [name, error] = [...failed.entries()][0];
    return { ok: false, ms: ms(), error: `data step ${name} failed: ${error}` };
  }
  const { schemaVersion, SCHEMA_VERSION } = await import("../db");
  const have = await schemaVersion();
  if (have < SCHEMA_VERSION) return { ok: false, ms: ms(), error: `database schema ${have} is older than this version's ${SCHEMA_VERSION}` };
  return { ok: true, ms: ms() };
}

// The database and the opening steps always count.
const ALWAYS = new Set(["database", "opening"]);
export async function readiness() {
  const checks: Record<string, Check> = {};
  // While the opening steps run, a query would only wait for them: the
  // database is checked once they are done.
  checks.opening = await checkOpening().catch((error) => ({ ok: false, ms: 0, error: String((error as Error)?.message || error).slice(0, 200) }));
  const { openingState } = await import("../db-driver");
  if (openingState().state === "done" || openingState().state === "failed") checks.database = await checkDatabase();
  if (clusterMode()) {
    const [redisCheck, bucket] = await Promise.all([checkRedis(), checkBucket()]);
    checks.redis = redisCheck;
    checks.objectStorage = bucket;
  }
  const stopping = shuttingDown();
  const required = readinessRequires();
  const ready = !stopping && !!checks.database && Object.entries(checks).every(([name, c]) => c.ok || (!ALWAYS.has(name) && !required.has(name)));
  return { ready, stopping, checks };
}
