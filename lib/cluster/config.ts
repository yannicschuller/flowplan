// Cluster mode: several Flowplan instances against one PostgreSQL database
// (docs/architecture/database.md §13). Switched on with FLOWPLAN_CLUSTER=1
// (or FLOWPLAN_MODE=cluster); then PostgreSQL (DATABASE_URL), Redis
// (REDIS_URL) and S3 object storage (S3_BUCKET …) are all required – an
// instance refuses to start without one of them. Without it Flowplan is the
// single container it always was: SQLite or PostgreSQL, no Redis, S3 optional.
import { hostname } from "node:os";
import { randomBytes } from "node:crypto";

export function clusterMode(env: Record<string, string | undefined> = process.env): boolean {
  const flag = env.FLOWPLAN_CLUSTER?.trim().toLowerCase();
  const mode = env.FLOWPLAN_MODE?.trim().toLowerCase();
  return flag === "1" || flag === "true" || flag === "on" || mode === "cluster";
}

// What is missing for cluster mode, as sentences for the log (empty: fine).
export function clusterConfigProblems(env: Record<string, string | undefined> = process.env): string[] {
  const problems: string[] = [];
  const url = env.DATABASE_URL?.trim() || "";
  if (!/^postgres(ql)?:\/\//i.test(url)) problems.push("DATABASE_URL must point to PostgreSQL (postgres://…): SQLite is one file on one host.");
  const redis = env.REDIS_URL?.trim() || "";
  if (!redis) problems.push("REDIS_URL is missing (redis://…): instances exchange live updates, presence and rate limits through Redis.");
  else if (!/^rediss?:\/\//i.test(redis)) problems.push("REDIS_URL must start with redis:// or rediss://.");
  if (!env.S3_BUCKET?.trim()) problems.push("S3_BUCKET (with S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY) is missing: files must live in object storage that every instance reaches.");
  return problems;
}

// Called once at start (instrumentation.ts): throws with every problem at
// once, so the instance stops with a message instead of running half-way.
export function requireClusterConfig(env: Record<string, string | undefined> = process.env) {
  if (!clusterMode(env)) {
    if (env.REDIS_URL?.trim()) console.warn("REDIS_URL is set but cluster mode is off (FLOWPLAN_CLUSTER=1): Redis is not used.");
    return false;
  }
  const problems = clusterConfigProblems(env);
  if (problems.length)
    throw new Error(`Cluster mode (FLOWPLAN_CLUSTER=1) cannot start:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  return true;
}

// This process: FLOWPLAN_INSTANCE_ID, else the host name (the pod name on
// Kubernetes, the container id with Docker) and a random suffix, so a
// restarted container is a new instance.
const holder = globalThis as unknown as { flowplanInstanceId?: string };
export function instanceId(): string {
  return (holder.flowplanInstanceId ??= (
    process.env.FLOWPLAN_INSTANCE_ID?.trim() || `${hostname().slice(0, 40)}-${randomBytes(3).toString("hex")}`
  ).replace(/[^A-Za-z0-9_.:-]/g, "_"));
}

// Keys and channels of this installation in Redis (several installations,
// or test processes, can share one Redis).
export function redisPrefix(env: Record<string, string | undefined> = process.env): string {
  const prefix = env.FLOWPLAN_REDIS_PREFIX?.trim() || "flowplan:";
  return prefix.endsWith(":") ? prefix : `${prefix}:`;
}
