// Uploads mirrored to S3-compatible object storage (MinIO, Garage, AWS …).
// The local uploads folder stays the working copy, so all file code keeps
// its synchronous, transactional behaviour. Triggers on the files table queue
// every new and deleted file in the same transaction; a background worker
// then uploads the object, or moves it to .deleted/uploads/ (removed there
// once no kept scheduled backup refers to it, lib/deleted-uploads.ts). A
// container started without the local files (new host, lost volume) fetches
// them back from the bucket.
// With FLOWPLAN_ENCRYPTION_KEY the objects are encrypted before they leave
// (lib/encryption.ts); the local copy stays plain. storage_sealed records
// with which key each object went up, so the Admin page can count what is
// still plain and "Encrypt existing objects" uploads just those again.
import { AwsClient } from "aws4fetch";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { all, one, run, sql } from "./db";
import { currentKeyId, isEncrypted, seal, unseal } from "./encryption";
import { DELETED_UPLOADS, deletedName } from "./deleted-uploads";

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
function objectUrl(config: StorageConfig, key: string, folder = "uploads") {
  const path = [config.prefix, folder, key].filter(Boolean).join("/");
  return `${config.endpoint}/${encodeURIComponent(config.bucket)}/${path}`;
}
// CopyObject's source: /<bucket>/<key>, URL-encoded.
const copySource = (config: StorageConfig, key: string) =>
  `/${encodeURIComponent(config.bucket)}/${[config.prefix, "uploads", key].filter(Boolean).map(encodeURIComponent).join("/")}`;
const scheduledBackupsOn = () => one<{ value: string }>("SELECT value FROM instance_settings WHERE key='backupSchedule'")?.value !== "false";
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
// Other objects of this instance in the bucket (scheduled backups): the
// path is relative to the prefix; a query string lists objects.
export function bucketFetch(path: string, init: RequestInit) {
  const config = storageConfig();
  if (!config) throw new Error("Kein S3-Speicher eingerichtet.");
  const base = `${config.endpoint}/${encodeURIComponent(config.bucket)}`;
  const url = path.startsWith("?")
    ? `${base}${path}`
    : `${base}/${[config.prefix, path].filter(Boolean).join("/")}`;
  return aws(config).fetch(url, init);
}
// Where the files of this instance go; a change means a full upload.
const target = (config: StorageConfig) =>
  `${config.endpoint}/${config.bucket}/${config.prefix}`;

const state = globalThis as unknown as {
  flowplanStorage?: {
    draining: boolean;
    again: boolean;
    timer?: ReturnType<typeof setInterval>;
  };
};

// Called once when the database opens: with the SQLite connection
// (lib/db.ts, db()), or without one on PostgreSQL (the first use of the
// database). The queue tables are in the migrations.
export function setupStorage(d?: DatabaseSync) {
  const config = storageConfig();
  const postgres = sql.name === "postgres";
  if (!config) {
    if (d)
      d.exec(`DROP TRIGGER IF EXISTS storage_file_insert;
        DROP TRIGGER IF EXISTS storage_file_delete;`); // sqlite-only
    else if (postgres) {
      run("DROP TRIGGER IF EXISTS storage_file_insert ON files");
      run("DROP TRIGGER IF EXISTS storage_file_delete ON files");
    }
    run("DELETE FROM storage_queue");
    run("DELETE FROM storage_sealed");
    return;
  }
  if (d) {
    // A trigger cannot wait for the commit; the kick runs after the current
    // synchronous transaction has finished.
    d.function("storage_kick", () => {
      setImmediate(kickStorage);
      return null;
    });
    // sqlite-only
    d.exec(`CREATE TRIGGER IF NOT EXISTS storage_file_insert AFTER INSERT ON files BEGIN
        INSERT INTO storage_queue(key,op) VALUES(NEW.id,'put') ON CONFLICT(key) DO UPDATE SET op='put',attempts=0,next_at=0;
        SELECT storage_kick();
      END;
      CREATE TRIGGER IF NOT EXISTS storage_file_delete AFTER DELETE ON files BEGIN
        INSERT INTO storage_queue(key,op) VALUES(OLD.id,'delete') ON CONFLICT(key) DO UPDATE SET op='delete',attempts=0,next_at=0;
        SELECT storage_kick();
      END;`);
  } else if (postgres) {
    // The same queue; the worker looks at it often instead of being kicked
    // by the trigger (a function of this process cannot run in Postgres).
    run(`CREATE OR REPLACE FUNCTION storage_queue_file() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        IF TG_OP='DELETE' THEN
          INSERT INTO storage_queue(key,op) VALUES(OLD.id,'delete') ON CONFLICT(key) DO UPDATE SET op='delete',attempts=0,next_at=0;
        ELSE
          INSERT INTO storage_queue(key,op) VALUES(NEW.id,'put') ON CONFLICT(key) DO UPDATE SET op='put',attempts=0,next_at=0;
        END IF;
        RETURN NULL;
      END $fn$`);
    run("CREATE OR REPLACE TRIGGER storage_file_insert AFTER INSERT ON files FOR EACH ROW EXECUTE FUNCTION storage_queue_file()");
    run("CREATE OR REPLACE TRIGGER storage_file_delete AFTER DELETE ON files FOR EACH ROW EXECUTE FUNCTION storage_queue_file()");
  }
  const marker = resolve(process.env.FLOWPLAN_DATA_DIR || "./data", "storage-resync");
  const previous = one<{ value: string }>("SELECT value FROM storage_state WHERE name='target'")?.value;
  // First use of this bucket, or local files replaced by an instance
  // restore: every file is uploaded again.
  if (previous !== target(config) || existsSync(marker)) {
    run("DELETE FROM storage_sealed");
    run("INSERT INTO storage_queue(key,op) SELECT id,'put' FROM files WHERE true ON CONFLICT(key) DO UPDATE SET op='put',attempts=0,next_at=0");
    run("INSERT INTO storage_state(name,value) VALUES('target',?) ON CONFLICT(name) DO UPDATE SET value=excluded.value", target(config));
    rmSync(marker, { force: true });
  }
  state.flowplanStorage = { draining: false, again: false };
  // Retries and files written outside a transaction (Postgres: also what
  // the trigger queued, see above).
  state.flowplanStorage.timer = setInterval(kickStorage, postgres ? 500 : 15_000);
  state.flowplanStorage.timer.unref?.();
  setImmediate(kickStorage);
  setImmediate(() => void hydrate());
}

// The database is closed and opened again (lib/db.ts, reopenDatabase).
export function stopStorage() {
  const s = state.flowplanStorage;
  if (s?.timer) clearInterval(s.timer);
  state.flowplanStorage = undefined;
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
    const jobs = all<{ key: string; op: string; attempts: number }>(
      "SELECT key,op,attempts FROM storage_queue WHERE next_at<=? ORDER BY next_at,key LIMIT 16",
      Date.now(),
    );
    if (!jobs.length) return;
    await Promise.all(
      jobs.map(async (job) => {
        const finish = () => run("DELETE FROM storage_queue WHERE key=? AND op=? AND attempts=?", job.key, job.op, job.attempts);
        try {
          if (!validKey(job.key)) return finish();
          if (job.op === "put") {
            const path = localPath(job.key);
            // Removed again before it was uploaded.
            if (!existsSync(path)) {
              if (!one("SELECT 1 FROM files WHERE id=?", job.key))
                return finish();
              throw new Error("Lokale Datei fehlt noch.");
            }
            const keyId = currentKeyId();
            const response = await aws(config).fetch(objectUrl(config, job.key), {
              method: "PUT",
              body: new Uint8Array(seal(readFileSync(path))),
            });
            if (!response.ok) throw new Error(`PUT ${response.status}`);
            run("INSERT INTO storage_sealed(key,key_id) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET key_id=excluded.key_id", job.key, keyId);
          } else {
            // Delayed deletion (lib/deleted-uploads.ts): the object moves to
            // .deleted/uploads/ first, so the scheduled backups in the bucket
            // that still refer to it keep their file; lib/scheduled-backup.ts
            // removes it once no kept backup does. Without scheduled backups
            // nothing would ever remove it: then it goes right away.
            if (scheduledBackupsOn()) {
              const copy = await aws(config).fetch(objectUrl(config, deletedName(job.key, Date.now()), DELETED_UPLOADS), {
                method: "PUT",
                headers: { "x-amz-copy-source": copySource(config, job.key) },
              });
              // 404: never uploaded, nothing to keep.
              if (!copy.ok && copy.status !== 404) throw new Error(`COPY ${copy.status}`);
            }
            const response = await aws(config).fetch(objectUrl(config, job.key), {
              method: "DELETE",
            });
            if (!response.ok && response.status !== 404)
              throw new Error(`DELETE ${response.status}`);
            run("DELETE FROM storage_sealed WHERE key=?", job.key);
          }
          finish();
        } catch (error) {
          if (job.attempts + 1 >= MAX_ATTEMPTS) {
            console.error(`Dateispeicher: ${job.op} ${job.key} aufgegeben`, error);
            return finish();
          }
          run(
            "UPDATE storage_queue SET attempts=attempts+1,next_at=? WHERE key=? AND op=? AND attempts=?",
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
    // Plain objects (from before encryption) come back as they are – but one
    // that went up encrypted must still be: a plain object in its place was
    // swapped in the bucket.
    const raw = Buffer.from(await response.arrayBuffer());
    const sealedWith = state.flowplanStorage ? one<{ key_id: string }>("SELECT key_id FROM storage_sealed WHERE key=?", key) : undefined;
    if (sealedWith?.key_id && !isEncrypted(raw)) throw new Error("Unverschlüsseltes Objekt anstelle eines verschlüsselten – nicht übernommen.");
    const data = unseal(raw);
    mkdirSync(uploadsDir(), { recursive: true });
    const partial = `${path}.${process.pid}.part`;
    writeFileSync(partial, data);
    renameSync(partial, path);
    return true;
  } catch (error) {
    if (/Schlüssel|Entschlüsseln|verschlüsselt/.test(String((error as Error)?.message)))
      console.error(`Dateispeicher: ${key} – ${(error as Error).message}`);
    return false;
  }
}
// After a start without local files, all known files come back in the
// background; requests fetch what they need right away.
async function hydrate() {
  const s = state.flowplanStorage;
  if (!s) return;
  const ids = all<{ id: string }>("SELECT id FROM files")
    .map((row) => row.id)
    .filter((key) => validKey(key) && !existsSync(localPath(key)));
  let restored = 0;
  for (const key of ids)
    if (!one("SELECT 1 FROM storage_queue WHERE key=?", key) && (await ensureLocal(key)))
      restored++;
  if (restored) console.log(`Dateispeicher: ${restored} Dateien aus dem Bucket geladen`);
}

export function storageStatus() {
  const s = state.flowplanStorage;
  const config = storageConfig();
  if (!config || !s) return { enabled: false as const };
  const row = one<{ pending: number; attempts: number }>("SELECT COUNT(*) AS pending, COALESCE(MAX(attempts),0) AS attempts FROM storage_queue")!;
  return {
    enabled: true as const,
    bucket: config.bucket,
    pending: Number(row.pending),
    failing: Number(row.attempts) > 0,
  };
}

// Files whose object in the bucket is not (yet) encrypted with the current
// key: from before encryption was turned on, or with an earlier key.
export function storageEncryption() {
  const s = state.flowplanStorage;
  if (!s || !storageConfig()) return null;
  let keyId = "";
  try {
    keyId = currentKeyId();
  } catch {}
  const count = (query: string, ...args: string[]) => Number(one<{ n: number }>(query, ...args)?.n || 0);
  return {
    files: count("SELECT count(*) n FROM files"),
    behind: keyId
      ? count(
          "SELECT count(*) n FROM files f LEFT JOIN storage_sealed x ON x.key=f.id WHERE x.key_id IS NULL OR x.key_id<>?",
          keyId,
        )
      : 0,
  };
}
// Uploads those again; the queue encrypts them on the way.
export function encryptExistingObjects() {
  const s = state.flowplanStorage;
  const keyId = currentKeyId();
  if (!s || !keyId) return 0;
  const result = run(
    `INSERT INTO storage_queue(key,op) SELECT f.id,'put' FROM files f LEFT JOIN storage_sealed x ON x.key=f.id
     WHERE (x.key_id IS NULL OR x.key_id<>?) AND f.id NOT IN (SELECT key FROM storage_queue)
     ON CONFLICT(key) DO NOTHING`,
    keyId,
  );
  setImmediate(kickStorage);
  return Number(result.changes);
}
