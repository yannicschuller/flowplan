// Administration → Überwachung → System: how this installation runs –
// single container or cluster, the database (kind, version, pool), Redis,
// the object storage, the instances alive, the leader and what the
// distributed queues hold. Part of the monitoring overview
// (lib/admin-monitoring.ts); no secrets (hosts only, no credentials).
import { one } from "../db";
import { database, poolStats } from "../db-driver";
import { postgresTimeouts } from "../db-driver/postgres";
import { clusterMode, instanceId } from "./config";
import { busStats, redis } from "./bus";
import { checkBucket, checkDatabase, checkRedis, type Check } from "./health";
import { liveInstances, type InstanceBeat } from "./instances";
import { isLeader, leaderError, leaderSince } from "./leader";
import { storageConfig, storageStatus } from "../storage";

export type SystemOverview = {
  mode: "single" | "cluster";
  instance: string;
  database: {
    kind: "sqlite" | "postgres";
    version: string | null;
    check: Check;
    pool: { size: number; total: number; idle: number; waiting: number } | null;
    timeouts: { statementMs: number; lockMs: number; idleInTransactionMs: number } | null;
  };
  redis: { check: Check; version: string | null; host: string; published: number; received: number; failed: number } | null;
  objectStorage: { configured: boolean; host: string | null; bucket: string | null; check: Check | null; pending: number | null; retrying: boolean };
  instances: InstanceBeat[];
  instancesError: string | null;
  leader: { id: string | null; self: boolean; since: number | null; error: string | null };
  queues: { storageDue: number; storageInFlight: number; mailDue: number; pushDue: number; webhooksDue: number; messengersDue: number };
};

const count = async (query: string, ...params: number[]) => Number((await one<{ n: number }>(query, ...params))?.n || 0);
const hostOf = (url: string) => {
  try {
    const parsed = new URL(url);
    return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
  } catch {
    return "";
  }
};

async function databaseVersion(kind: "sqlite" | "postgres") {
  try {
    if (kind === "postgres") return (await one<{ v: string }>("SELECT current_setting('server_version') AS v"))?.v ?? null;
    return (await one<{ v: string }>("SELECT sqlite_version() AS v"))?.v ?? null; // sqlite-only
  } catch {
    return null;
  }
}
async function redisVersion() {
  try {
    const info = String(await redis().command("INFO", "server"));
    return /redis_version:([^\r\n]+)/.exec(info)?.[1] ?? null;
  } catch {
    return null;
  }
}

export async function systemOverview(now = Date.now()): Promise<SystemOverview> {
  const cluster = clusterMode();
  const kind = database().backend;
  const config = storageConfig();
  const [dbCheck, version] = await Promise.all([checkDatabase(), databaseVersion(kind)]);
  let instances: InstanceBeat[] = [];
  let instancesError: string | null = null;
  try {
    instances = await liveInstances(now);
  } catch (error) {
    instancesError = String((error as Error).message || error);
  }
  const leaderEntry = instances.find((i) => i.leader);
  const mirror = await storageStatus().catch(() => ({ enabled: false as const }));
  const timeouts = kind === "postgres" ? postgresTimeouts() : null;
  const bus = busStats();
  return {
    mode: cluster ? "cluster" : "single",
    instance: instanceId(),
    database: {
      kind,
      version,
      check: dbCheck,
      pool: poolStats(),
      timeouts: timeouts && { statementMs: timeouts.statementTimeout, lockMs: timeouts.lockTimeout, idleInTransactionMs: timeouts.idleInTransactionTimeout },
    },
    redis: cluster
      ? { check: await checkRedis(), version: await redisVersion(), host: hostOf(process.env.REDIS_URL || ""), published: bus.published, received: bus.received, failed: bus.failed }
      : null,
    objectStorage: {
      configured: !!config,
      host: config ? hostOf(config.endpoint) : null,
      bucket: config?.bucket ?? null,
      check: cluster && config ? await checkBucket(now) : null,
      pending: mirror.enabled ? mirror.pending : null,
      retrying: mirror.enabled ? mirror.failing : false,
    },
    instances,
    instancesError,
    leader: {
      id: cluster ? (isLeader() ? instanceId() : (leaderEntry?.id ?? null)) : instanceId(),
      self: isLeader(),
      since: cluster ? (isLeader() ? leaderSince() : null) : null,
      error: cluster ? leaderError() : null,
    },
    queues: {
      storageDue: config ? await count("SELECT COUNT(*) n FROM storage_queue WHERE next_at<=?", now) : 0,
      storageInFlight: config ? await count("SELECT COUNT(*) n FROM storage_queue WHERE next_at>? AND attempts=0", now) : 0,
      mailDue: await count("SELECT COUNT(*) n FROM mail_queue WHERE sent_at IS NULL AND attempts<8 AND next_at<=?", now),
      pushDue: await count("SELECT COUNT(*) n FROM push_deliveries WHERE delivered_at IS NULL AND attempts<5 AND available_at<=?", now),
      webhooksDue: await count("SELECT COUNT(*) n FROM webhook_deliveries WHERE delivered_at IS NULL AND next_at<=?", now),
      messengersDue: await count("SELECT COUNT(*) n FROM messenger_deliveries WHERE delivered_at IS NULL AND available_at<=?", now),
    },
  };
}
