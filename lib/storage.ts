// Uploads mirrored to S3-compatible object storage (MinIO, Garage, AWS …).
// The local uploads folder stays the working copy, so all file code keeps
// its synchronous, transactional behaviour. Triggers on the files table queue
// every new and deleted file in the same transaction; a background worker
// then uploads or deletes the object. A container started without the local
// files (new host, lost volume) fetches them back from the bucket.
import { AwsClient } from "aws4fetch";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";

export type StorageConfig = {
  endpoint: string;
  bucket: string;
  region: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
};
export function storageConfig(): StorageConfig | null {
  const bucket = process.env.S3_BUCKET?.trim();
  if (!bucket) return null;
  const region = process.env.S3_REGION?.trim() || "us-east-1";
  return {
    endpoint: (
      process.env.S3_ENDPOINT?.trim() || `https://s3.${region}.amazonaws.com`
    ).replace(/\/+$/, ""),
    bucket,
    region,
    prefix: (process.env.S3_PREFIX ?? "flowplan").replace(/^\/+|\/+$/g, ""),
    accessKeyId: process.env.S3_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || "",
  };
}
const uploadsDir = () =>
  resolve(process.env.FLOWPLAN_DATA_DIR || "./data", "uploads");
const localPath = (key: string) => resolve(uploadsDir(), key);
const validKey = (key: string) => /^[A-Za-z0-9_-]{1,100}$/.test(key);
// Path-style URLs work with MinIO, Garage and AWS alike.
function objectUrl(config: StorageConfig, key: string) {
  const path = [config.prefix, "uploads", key].filter(Boolean).join("/");
  return `${config.endpoint}/${encodeURIComponent(config.bucket)}/${path}`;
}
let client: { key: string; aws: AwsClient } | undefined;
function aws(config: StorageConfig) {
  const key = `${config.accessKeyId}:${config.region}`;
  if (client?.key !== key)
    client = {
      key,
      aws: new AwsClient({
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
        service: "s3",
        region: config.region,
        // The queue retries with its own backoff; a request fails fast.
        retries: 0,
      }),
    };
  return client.aws;
}
// Where the files of this instance go; a change means a full upload.
const target = (config: StorageConfig) =>
  `${config.endpoint}/${config.bucket}/${config.prefix}`;

const state = globalThis as unknown as {
  flowplanStorage?: {
    db: DatabaseSync;
    draining: boolean;
    again: boolean;
    timer?: ReturnType<typeof setInterval>;
  };
};

// Called once when the database opens.
export function setupStorage(d: DatabaseSync) {
  d.exec(`CREATE TABLE IF NOT EXISTS storage_queue(key TEXT PRIMARY KEY,op TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS storage_state(name TEXT PRIMARY KEY,value TEXT NOT NULL);`);
  const config = storageConfig();
  if (!config) {
    d.exec(`DROP TRIGGER IF EXISTS storage_file_insert;
      DROP TRIGGER IF EXISTS storage_file_delete;
      DELETE FROM storage_queue;`);
    return;
  }
  // A trigger cannot wait for the commit; the kick runs after the current
  // synchronous transaction has finished.
  d.function("storage_kick", () => {
    setImmediate(kickStorage);
    return null;
  });
  d.exec(`CREATE TRIGGER IF NOT EXISTS storage_file_insert AFTER INSERT ON files BEGIN
      INSERT INTO storage_queue(key,op) VALUES(NEW.id,'put') ON CONFLICT(key) DO UPDATE SET op='put',attempts=0,next_at=0;
      SELECT storage_kick();
    END;
    CREATE TRIGGER IF NOT EXISTS storage_file_delete AFTER DELETE ON files BEGIN
      INSERT INTO storage_queue(key,op) VALUES(OLD.id,'delete') ON CONFLICT(key) DO UPDATE SET op='delete',attempts=0,next_at=0;
      SELECT storage_kick();
    END;`);
  const marker = resolve(process.env.FLOWPLAN_DATA_DIR || "./data", "storage-resync");
  const previous = (
    d.prepare("SELECT value FROM storage_state WHERE name='target'").get() as
      | { value: string }
      | undefined
  )?.value;
  // First use of this bucket, or local files replaced by an instance
  // restore: every file is uploaded again.
  if (previous !== target(config) || existsSync(marker)) {
    d.exec(
      "INSERT INTO storage_queue(key,op) SELECT id,'put' FROM files WHERE true ON CONFLICT(key) DO UPDATE SET op='put',attempts=0,next_at=0",
    );
    d.prepare(
      "INSERT INTO storage_state(name,value) VALUES('target',?) ON CONFLICT(name) DO UPDATE SET value=excluded.value",
    ).run(target(config));
    rmSync(marker, { force: true });
  }
  state.flowplanStorage = { db: d, draining: false, again: false };
  // Retries and files written outside a transaction.
  state.flowplanStorage.timer = setInterval(kickStorage, 15_000);
  state.flowplanStorage.timer.unref?.();
  setImmediate(kickStorage);
  setImmediate(() => void hydrate());
}

export function kickStorage() {
  const s = state.flowplanStorage;
  if (!s) return;
  if (s.draining) {
    s.again = true;
    return;
  }
  s.draining = true;
  void drain()
    .catch((error) => console.error("Dateispeicher: Abgleich fehlgeschlagen", error))
    .finally(() => {
      s.draining = false;
      if (s.again) {
        s.again = false;
        kickStorage();
      }
    });
}

const MAX_ATTEMPTS = 12;
async function drain() {
  const s = state.flowplanStorage,
    config = storageConfig();
  if (!s || !config) return;
  for (;;) {
    const jobs = s.db
      .prepare(
        "SELECT key,op,attempts FROM storage_queue WHERE next_at<=? ORDER BY next_at,key LIMIT 16",
      )
      .all(Date.now()) as { key: string; op: string; attempts: number }[];
    if (!jobs.length) return;
    await Promise.all(
      jobs.map(async (job) => {
        const finish = () =>
          s.db
            .prepare("DELETE FROM storage_queue WHERE key=? AND op=? AND attempts=?")
            .run(job.key, job.op, job.attempts);
        try {
          if (!validKey(job.key)) return finish();
          if (job.op === "put") {
            const path = localPath(job.key);
            // Removed again before it was uploaded.
            if (!existsSync(path)) {
              if (!s.db.prepare("SELECT 1 FROM files WHERE id=?").get(job.key))
                return finish();
              throw new Error("Lokale Datei fehlt noch.");
            }
            const response = await aws(config).fetch(objectUrl(config, job.key), {
              method: "PUT",
              body: readFileSync(path),
            });
            if (!response.ok) throw new Error(`PUT ${response.status}`);
          } else {
            const response = await aws(config).fetch(objectUrl(config, job.key), {
              method: "DELETE",
            });
            if (!response.ok && response.status !== 404)
              throw new Error(`DELETE ${response.status}`);
          }
          finish();
        } catch (error) {
          if (job.attempts + 1 >= MAX_ATTEMPTS) {
            console.error(`Dateispeicher: ${job.op} ${job.key} aufgegeben`, error);
            return finish();
          }
          s.db
            .prepare(
              "UPDATE storage_queue SET attempts=attempts+1,next_at=? WHERE key=? AND op=? AND attempts=?",
            )
            .run(
              Date.now() + Math.min(3_600_000, 5_000 * 2 ** job.attempts),
              job.key,
              job.op,
              job.attempts,
            );
        }
      }),
    );
  }
}

// Makes sure a file exists locally, fetching it from the bucket if needed.
export async function ensureLocal(key: string) {
  if (!validKey(key)) return false;
  const path = localPath(key);
  if (existsSync(path)) return true;
  const config = storageConfig();
  if (!config) return false;
  try {
    const response = await aws(config).fetch(objectUrl(config, key));
    if (!response.ok) return false;
    const data = Buffer.from(await response.arrayBuffer());
    mkdirSync(uploadsDir(), { recursive: true });
    const partial = `${path}.${process.pid}.part`;
    writeFileSync(partial, data);
    renameSync(partial, path);
    return true;
  } catch {
    return false;
  }
}
// After a start without local files, all known files come back in the
// background; requests fetch what they need right away.
async function hydrate() {
  const s = state.flowplanStorage;
  if (!s) return;
  const ids = (s.db.prepare("SELECT id FROM files").all() as { id: string }[])
    .map((row) => row.id)
    .filter((key) => validKey(key) && !existsSync(localPath(key)));
  let restored = 0;
  for (const key of ids)
    if (!s.db.prepare("SELECT 1 FROM storage_queue WHERE key=?").get(key) && (await ensureLocal(key)))
      restored++;
  if (restored) console.log(`Dateispeicher: ${restored} Dateien aus dem Bucket geladen`);
}

export function storageStatus() {
  const s = state.flowplanStorage;
  const config = storageConfig();
  if (!config || !s) return { enabled: false as const };
  const row = s.db
    .prepare(
      "SELECT COUNT(*) AS pending, COALESCE(MAX(attempts),0) AS attempts FROM storage_queue",
    )
    .get() as { pending: number; attempts: number };
  return {
    enabled: true as const,
    bucket: config.bucket,
    pending: Number(row.pending),
    failing: Number(row.attempts) > 0,
  };
}
