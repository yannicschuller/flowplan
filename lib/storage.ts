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
//
// Cluster mode (FLOWPLAN_CLUSTER=1): the bucket is the truth and the local
// folder only a cache. Code that stores a file calls publishUpload() after
// writing it; that returns once the object is in the bucket, so a request
// that stored a file answers only when every other instance can read it
// (the queue then finds the object sealed with the current key and only
// drops its job). Code that reads a file asks localUpload()/readUpload(),
// which fetch it from the bucket when this instance does not have it. The
// cache is kept below FLOWPLAN_CACHE_MAX_MB (oldest unused files first). On
// shutdown the uploads under way and the due queue are drained.
//
// S3_LOCAL_CACHE (#389, e.g. "2GB"): the same cache for a single instance.
// The bucket is the truth for the files confirmed in it; above the limit the
// least recently used of those leave the local folder (pruneUploadCache) and
// come back when a request needs them (ensureLocal). Files not confirmed in
// the bucket always stay. Whole-instance copies (backup, SFTP mirror, move)
// read the evicted ones from the bucket without putting them back into the
// cache (withUploadFile, openUploadStream). The SQLite database is never
// part of this.
import { AwsClient } from "aws4fetch";
import { createReadStream, createWriteStream, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { all, one, run, sql } from "./db";
import { currentKeyId, fileIsEncrypted, OVERHEAD, seal, sealer, unsealFile } from "./encryption";
import { DELETED_UPLOADS, deletedName } from "./deleted-uploads";
import { clusterMode } from "./cluster/config";
import { channelName, listen } from "./cluster/pg-session";
import { onShutdownTask, SHUTDOWN_PHASE } from "./cluster/runtime";

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
export const uploadsDir = () =>
  resolve(process.env.FLOWPLAN_DATA_DIR || "./data", "uploads");
const localPath = (key: string) => resolve(uploadsDir(), key);
export const validKey = (key: string) => /^[A-Za-z0-9_-]{1,100}$/.test(key);
// Where a file of the uploads folder is (or is written to). Reading it
// there directly misses a file this instance does not have yet in cluster
// mode: read with localUpload()/readUpload() instead.
export function uploadPath(key: string) {
  if (!validKey(key)) throw new Error(`Ungültiger Dateischlüssel: ${key.slice(0, 40)}`);
  return localPath(key);
}
// Path-style URLs work with MinIO, Garage and AWS alike.
function objectUrl(config: StorageConfig, key: string, folder = "uploads") {
  const path = [config.prefix, folder, key].filter(Boolean).join("/");
  return `${config.endpoint}/${encodeURIComponent(config.bucket)}/${path}`;
}
// CopyObject's source: /<bucket>/<key>, URL-encoded.
const copySource = (config: StorageConfig, key: string) =>
  `/${encodeURIComponent(config.bucket)}/${[config.prefix, "uploads", key].filter(Boolean).map(encodeURIComponent).join("/")}`;
const scheduledBackupsOn = async () => (await one<{ value: string }>("SELECT value FROM instance_settings WHERE key='backupSchedule'"))?.value !== "false";
let client: { key: string; aws: AwsClient } | undefined;
// Signs with aws4fetch, then sends the original body with a plain URL and
// init (#518). aws4fetch's own fetch() hands fetch a Request object; inside
// Next.js the patched fetch passes such a body on as a stream of unknown
// length, so a PUT went out chunked without Content-Length – S3 servers
// answer 411 (or a proxy hangs). A string or byte body keeps its length.
async function s3Fetch(signer: AwsClient, url: string, init: RequestInit = {}) {
  const signed = await signer.sign(url, init);
  return fetch(signed.url, {
    method: signed.method,
    headers: signed.headers,
    body: init.body ?? null,
    signal: init.signal ?? null,
    cache: "no-store",
  });
}
function aws(config: StorageConfig) {
  const signer = awsSigner(config);
  return { fetch: (url: string, init?: RequestInit) => s3Fetch(signer, url, init) };
}
function awsSigner(config: StorageConfig) {
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
    prune?: ReturnType<typeof setInterval>;
    pruneSoon?: ReturnType<typeof setTimeout>;
    pruning?: boolean;
    unlisten?: () => void;
  };
};
// The NOTIFY channel of the queue trigger on PostgreSQL (per schema).
const QUEUE_CHANNEL = "flowplan_storage";

// Called once when the database opens: with the SQLite connection
// (lib/db.ts, db()), or without one on PostgreSQL (the first use of the
// database). The queue tables are in the migrations.
export async function setupStorage(d?: DatabaseSync) {
  const config = storageConfig();
  const postgres = sql.name === "postgres";
  if (!config) {
    if (process.env.S3_LOCAL_CACHE?.trim())
      console.log("Dateispeicher: S3_LOCAL_CACHE wird ignoriert – ohne S3_BUCKET bleiben alle Dateien lokal.");
    if (d)
      d.exec(`DROP TRIGGER IF EXISTS storage_file_insert;
        DROP TRIGGER IF EXISTS storage_file_delete;`); // sqlite-only
    else if (postgres) {
      await run("DROP TRIGGER IF EXISTS storage_file_insert ON files");
      await run("DROP TRIGGER IF EXISTS storage_file_delete ON files");
    }
    await run("DELETE FROM storage_queue");
    await run("DELETE FROM storage_sealed");
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
  } else if (postgres) await ensureStorageTriggers();
  const marker = resolve(process.env.FLOWPLAN_DATA_DIR || "./data", "storage-resync");
  const previous = (await one<{ value: string }>("SELECT value FROM storage_state WHERE name='target'"))?.value;
  // First use of this bucket, or local files replaced by an instance
  // restore: every file is uploaded again.
  if (previous !== target(config) || existsSync(marker)) {
    // With a cache, files removed locally exist only in the old place: they
    // cannot be uploaded from here (the queue gives up on them).
    if (previous && localCacheMode()) {
      const missing = (await all<{ id: string }>("SELECT id FROM files")).filter((f) => validKey(String(f.id)) && !existsSync(localPath(String(f.id)))).length;
      if (missing)
        console.error(`Dateispeicher: Ziel geändert (${previous} → ${target(config)}), aber ${missing} Dateien liegen nur im bisherigen Bucket – kopiere sie dorthin (z. B. mit rclone copy), sonst fehlen sie.`);
    }
    await run("DELETE FROM storage_sealed");
    await run("INSERT INTO storage_queue(key,op) SELECT id,'put' FROM files WHERE true ON CONFLICT(key) DO UPDATE SET op='put',attempts=0,next_at=0");
    await run("INSERT INTO storage_state(name,value) VALUES('target',?) ON CONFLICT(name) DO UPDATE SET value=excluded.value", target(config));
    rmSync(marker, { force: true });
  }
  const current = (state.flowplanStorage = { draining: false, again: false } as NonNullable<typeof state.flowplanStorage>);
  // Retries and files written outside a transaction; on PostgreSQL also
  // what a lost LISTEN connection missed (it used to poll every 0.5 s).
  current.timer = setInterval(kickStorage, 15_000);
  current.timer.unref?.();
  if (postgres)
    void listen(channelName(QUEUE_CHANNEL), (payload) => {
      // In cluster mode only the instance that wrote the file can upload
      // it: the others leave a "put" to it (a deletion anyone can do).
      const [op, key] = [payload.slice(0, payload.indexOf(":")), payload.slice(payload.indexOf(":") + 1)];
      if (clusterMode() && op === "put" && !(validKey(key) && existsSync(localPath(key)))) return;
      kickStorage();
    })
      .then((unlisten) => {
        if (state.flowplanStorage === current) current.unlisten = unlisten;
        else unlisten();
      })
      .catch((error) => console.error("Dateispeicher: LISTEN fehlgeschlagen, nur die Abfrage alle 15 s", (error as Error).message));
  setImmediate(kickStorage);
  // In cluster mode and with S3_LOCAL_CACHE the local folder is a cache of
  // the bucket: files come when a request needs them (ensureLocal), not all
  // at every start (that would refill what was evicted on purpose), and the
  // least used go again when it grows past the limit – at the start, after
  // uploads and every five minutes.
  const raw = process.env.S3_LOCAL_CACHE?.trim();
  if (raw && parseCacheSize(raw) === null)
    console.error(`Dateispeicher: S3_LOCAL_CACHE="${raw.slice(0, 40)}" nicht verstanden (z. B. 2GB, 500MB) – alle Dateien bleiben lokal.`);
  if (!localCacheMode()) setImmediate(() => void hydrate());
  else {
    const limit = cacheLimitBytes();
    if (!clusterMode()) console.log(`Dateispeicher: lokaler Zwischenspeicher auf ${formatSize(limit)} begrenzt (S3_LOCAL_CACHE), der Bucket hält alle Dateien.`);
    current.prune = setInterval(() => schedulePrune(0), 5 * 60_000);
    current.prune.unref?.();
    schedulePrune(5_000);
  }
  onShutdownTask("storage", SHUTDOWN_PHASE.files, (deadline) => flushStorage(deadline));
}

// The queue's trigger on PostgreSQL (with a bucket configured): at the
// opening, and again after a pg_dump restore, which makes the schema anew
// (lib/cluster/duties.ts; outside cluster mode the opening follows it).
export async function ensureStorageTriggers() {
  if (!storageConfig() || sql.name !== "postgres") return;
  // The same queue; the trigger cannot call this process, so it sends a
  // NOTIFY (delivered at the commit) to every instance listening on the
  // queue's channel, with the file's key: an instance that has the file
  // uploads it right away. A slow poll catches what a lost connection
  // missed.
  await run(`CREATE OR REPLACE FUNCTION storage_queue_file() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      IF TG_OP='DELETE' THEN
        INSERT INTO storage_queue(key,op) VALUES(OLD.id,'delete') ON CONFLICT(key) DO UPDATE SET op='delete',attempts=0,next_at=0;
        PERFORM pg_notify('${QUEUE_CHANNEL}_' || current_schema(), 'delete:' || OLD.id);
      ELSE
        INSERT INTO storage_queue(key,op) VALUES(NEW.id,'put') ON CONFLICT(key) DO UPDATE SET op='put',attempts=0,next_at=0;
        PERFORM pg_notify('${QUEUE_CHANNEL}_' || current_schema(), 'put:' || NEW.id);
      END IF;
      RETURN NULL;
    END $fn$`);
  await run("CREATE OR REPLACE TRIGGER storage_file_insert AFTER INSERT ON files FOR EACH ROW EXECUTE FUNCTION storage_queue_file()");
  await run("CREATE OR REPLACE TRIGGER storage_file_delete AFTER DELETE ON files FOR EACH ROW EXECUTE FUNCTION storage_queue_file()");
}

// The database is closed and opened again (lib/db.ts, reopenDatabase).
export function stopStorage() {
  const s = state.flowplanStorage;
  if (s?.timer) clearInterval(s.timer);
  if (s?.prune) clearInterval(s.prune);
  if (s?.pruneSoon) clearTimeout(s.pruneSoon);
  s?.unlisten?.();
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
// How long a claimed job stays with its worker before another may take it
// (the worker died): longer than an upload takes.
const LEASE_MS = 10 * 60_000;
// Takes up to 16 due jobs: their next_at moves past the lease, so another
// worker (instance) does not take them; on PostgreSQL rows another worker
// is claiming right now are skipped (FOR UPDATE SKIP LOCKED) rather than
// waited for. A job is done when its row is deleted; a failure sets its
// next attempt.
export async function claimStorageJobs(now = Date.now(), limit = 16) {
  return await all<{ key: string; op: string; attempts: number }>(
    `UPDATE storage_queue SET next_at=? WHERE key IN (SELECT key FROM storage_queue WHERE next_at<=? ORDER BY next_at,key LIMIT ${Math.max(1, Math.floor(limit))}${sql.skipLocked()}) RETURNING key,op,attempts`,
    now + LEASE_MS,
    now,
  );
}
async function drain() {
  const s = state.flowplanStorage,
    config = storageConfig();
  if (!s || !config) return;
  for (;;) {
    if (state.flowplanStorage !== s) return;
    const jobs = await claimStorageJobs();
    if (!jobs.length) return;
    await Promise.all(
      jobs.map(async (job) => {
        const finish = async () => await run("DELETE FROM storage_queue WHERE key=? AND op=? AND attempts=?", job.key, job.op, job.attempts);
        try {
          if (!validKey(job.key)) return await finish();
          if (job.op === "put") {
            // Cluster mode: stored through publishUpload(), so in the bucket
            // already with the current key – nothing left to do.
            if (clusterMode() && (await one<{ key_id: string }>("SELECT key_id FROM storage_sealed WHERE key=?", job.key))?.key_id === currentKeyId())
              return await finish();
            const path = localPath(job.key);
            // Removed again before it was uploaded.
            if (!existsSync(path)) {
              if (!(await one("SELECT 1 FROM files WHERE id=?", job.key)))
                return await finish();
              // Cluster mode: written on another instance, which uploads it
              // (it hears the NOTIFY); back to the queue soon, as a retry.
              throw new Error(clusterMode() ? "Datei liegt auf einer anderen Instanz." : "Lokale Datei fehlt noch.");
            }
            const keyId = currentKeyId();
            // A large file takes a while: the lease is renewed part by part,
            // so no other round takes the job meanwhile.
            await putObject(config, job.key, path, async () => {
              await run("UPDATE storage_queue SET next_at=? WHERE key=? AND op=? AND attempts=?", Date.now() + LEASE_MS, job.key, job.op, job.attempts);
            });
            await run("INSERT INTO storage_sealed(key,key_id) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET key_id=excluded.key_id", job.key, keyId);
            // Now confirmed in the bucket: may leave the cache if it is full.
            schedulePrune(30_000);
          } else {
            // Delayed deletion (lib/deleted-uploads.ts): the object moves to
            // .deleted/uploads/ first, so the scheduled backups in the bucket
            // that still refer to it keep their file; lib/scheduled-backup.ts
            // removes it once no kept backup does. Without scheduled backups
            // nothing would ever remove it: then it goes right away.
            if (await scheduledBackupsOn()) {
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
            await run("DELETE FROM storage_sealed WHERE key=?", job.key);
          }
          await finish();
        } catch (error) {
          if (job.attempts + 1 >= MAX_ATTEMPTS) {
            console.error(`Dateispeicher: ${job.op} ${job.key} aufgegeben`, error);
            return await finish();
          }
          await run(
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
  noteUse(key);
  if (existsSync(path)) return true;
  const config = storageConfig();
  if (!config) return false;
  // One download per file at a time: the others wait for it.
  const fetching = (fetchingState.flowplanFetching ??= new Map());
  const running = fetching.get(key);
  if (running) return await running;
  const job = fetchLocal(config, key, path).finally(() => fetching.delete(key));
  fetching.set(key, job);
  return await job;
}
const fetchingState = globalThis as unknown as { flowplanFetching?: Map<string, Promise<boolean>> };
async function fetchLocal(config: StorageConfig, key: string, path: string) {
  try {
    let response = await aws(config).fetch(objectUrl(config, key));
    // Cluster mode: written moments ago on another instance, whose upload
    // is still under way – wait for it a little (up to 5 s).
    for (let waited = 0; response.status === 404 && clusterMode() && waited < 5000; waited += 250) {
      if (!(await one("SELECT 1 FROM storage_queue WHERE key=? AND op='put'", key))) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
      response = await aws(config).fetch(objectUrl(config, key));
    }
    if (!response.ok) return false;
    // Streamed to disk (files of several gigabytes), decrypted from there.
    mkdirSync(uploadsDir(), { recursive: true });
    const partial = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.part`;
    await settleDownload(key, response, partial, `${partial}.raw`);
    renameSync(partial, path);
    return true;
  } catch (error) {
    if (/Schlüssel|Entschlüsseln|verschlüsselt/.test(String((error as Error)?.message)))
      console.error(`Dateispeicher: ${key} – ${(error as Error).message}`);
    return false;
  }
}
// ---- Objects of any size ----
//
// Up to SINGLE_PUT_BYTES a file goes up in one PUT (read into memory, as
// before); a larger one as a multipart upload in parts of PART_BYTES, read
// and sealed part by part: the memory stays at about one part whatever the
// file's size (uploads of up to 10 GB), and S3's limit of 5 GB per PUT does
// not apply. At most LARGE_PUTS large files go up at once, so a queue full
// of them cannot add up either. Downloads are streamed to a file and
// decrypted from there (unsealFile), never held in memory.
export const SINGLE_PUT_BYTES = 16 * 1024 * 1024;
export const PART_BYTES = 16 * 1024 * 1024;
const LARGE_PUTS = 2;
const largeSlots = globalThis as unknown as { flowplanLargePuts?: { active: number; waiting: (() => void)[] } };
async function withLargeSlot<T>(fn: () => Promise<T>): Promise<T> {
  const slots = (largeSlots.flowplanLargePuts ??= { active: 0, waiting: [] });
  while (slots.active >= LARGE_PUTS) await new Promise<void>((r) => slots.waiting.push(r));
  slots.active++;
  try {
    return await fn();
  } finally {
    slots.active--;
    slots.waiting.shift()?.();
  }
}
const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Puts the file at `path` as the object of `key`, sealed with the current
// key. `progress` runs after every part of a multipart upload.
export async function putObject(config: StorageConfig, key: string, path: string, progress?: () => Promise<void>): Promise<void> {
  const size = statSync(path).size;
  const url = objectUrl(config, key);
  if (size <= SINGLE_PUT_BYTES) {
    const response = await aws(config).fetch(url, { method: "PUT", body: new Uint8Array(seal(readFileSync(path))) });
    if (!response.ok) throw new Error(`PUT ${response.status}`);
    return;
  }
  await withLargeSlot(async () => {
    const created = await aws(config).fetch(`${url}?uploads`, { method: "POST" });
    if (!created.ok) throw new Error(`POST uploads ${created.status}`);
    const uploadId = (await created.text()).match(/<UploadId>([^<]+)<\/UploadId>/)?.[1];
    if (!uploadId) throw new Error("Multipart-Upload ohne UploadId.");
    const query = `uploadId=${encodeURIComponent(uploadId)}`;
    const etags: string[] = [];
    const sendPart = async (body: Buffer) => {
      const number = etags.length + 1;
      let last: unknown = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt) await new Promise((r) => setTimeout(r, 500 * 4 ** (attempt - 1)));
        try {
          const response = await aws(config).fetch(`${url}?partNumber=${number}&${query}`, { method: "PUT", body: new Uint8Array(body.buffer as ArrayBuffer, body.byteOffset, body.length) });
          const etag = response.headers.get("etag");
          if (response.ok && etag) {
            etags.push(etag);
            await progress?.();
            return;
          }
          last = new Error(`PUT part ${number} ${response.status}`);
        } catch (error) {
          last = error;
        }
      }
      throw last;
    };
    try {
      const sealing = sealer();
      let pending: Buffer[] = sealing ? [sealing.head] : [];
      let pendingSize = sealing ? sealing.head.length : 0;
      const add = async (piece: Buffer) => {
        if (!piece.length) return;
        pending.push(piece);
        pendingSize += piece.length;
        while (pendingSize >= PART_BYTES) {
          const joined = Buffer.concat(pending, pendingSize);
          await sendPart(joined.subarray(0, PART_BYTES));
          const rest = joined.subarray(PART_BYTES);
          pending = rest.length ? [Buffer.from(rest)] : [];
          pendingSize = rest.length;
        }
      };
      for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) await add(sealing ? sealing.update(chunk as Buffer) : (chunk as Buffer));
      if (sealing) await add(sealing.final());
      if (pendingSize || !etags.length) await sendPart(Buffer.concat(pending, pendingSize));
      const parts = etags.map((etag, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${xmlEscape(etag)}</ETag></Part>`).join("");
      const done = await aws(config).fetch(`${url}?${query}`, {
        method: "POST",
        headers: { "Content-Type": "application/xml" },
        body: `<CompleteMultipartUpload>${parts}</CompleteMultipartUpload>`,
      });
      // S3 may answer 200 and still report an error in the body.
      const text = await done.text();
      if (!done.ok || /<Error>/.test(text)) throw new Error(`POST complete ${done.status}`);
    } catch (error) {
      await aws(config).fetch(`${url}?${query}`, { method: "DELETE" }).catch(() => {});
      throw error;
    }
  });
}

// Writes a fetched object to `target`, decrypted: streamed to `raw` first
// (or straight to `target` when it is plain). An object that went up
// encrypted must still be: a plain one in its place was swapped in the
// bucket. Nothing is left behind on a failure.
async function settleDownload(key: string, response: Response, target: string, raw: string, checkSealed = !!state.flowplanStorage) {
  try {
    await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>), createWriteStream(raw));
    const encrypted = fileIsEncrypted(raw);
    const sealedWith = checkSealed ? await one<{ key_id: string }>("SELECT key_id FROM storage_sealed WHERE key=?", key) : undefined;
    if (sealedWith?.key_id && !encrypted) throw new Error("Unverschlüsseltes Objekt anstelle eines verschlüsselten – nicht übernommen.");
    rmSync(target, { force: true });
    if (encrypted) await unsealFile(raw, target);
    else renameSync(raw, target);
  } catch (error) {
    rmSync(target, { force: true });
    throw error;
  } finally {
    rmSync(raw, { force: true });
  }
}

// ---- Reading and writing through the storage layer ----

// The local path of a stored file, fetched from the bucket first when this
// instance does not have it (cluster mode, a new container); null when it
// exists nowhere. Every reader of the uploads folder goes through this (or
// readUpload), never through the path alone.
export async function localUpload(key: string): Promise<string | null> {
  if (!validKey(key)) return null;
  if (!(await ensureLocal(key))) return null;
  return localPath(key);
}
// The names of the stored files to read for a whole-instance copy (instance
// backup, SFTP mirror, instance move): the uploads folder as it is – in
// cache mode (cluster, S3_LOCAL_CACHE), where it holds only part of them,
// also every file confirmed in the bucket. Nothing is fetched here: the copy
// reads each with withUploadFile() or openUploadStream().
export async function localUploadNames(): Promise<string[]> {
  let here: string[] = [];
  try {
    here = readdirSync(uploadsDir()).filter(validKey);
  } catch {}
  if (!localCacheMode() || !storageConfig()) return here;
  const names = new Set(here);
  for (const { id } of await all<{ id: string }>("SELECT f.id FROM files f JOIN storage_sealed s ON s.key=f.id"))
    if (validKey(String(id))) names.add(String(id));
  return [...names].sort();
}
// The same as a path to read from in any case: fetched first when needed,
// otherwise the (missing) path, so the caller's own "file missing" check
// stays as it was.
export async function uploadSource(key: string): Promise<string> {
  return (await localUpload(key)) ?? resolve(uploadsDir(), key);
}
export async function readUpload(key: string): Promise<Buffer | null> {
  const path = await localUpload(key);
  if (!path) return null;
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

const inflight = globalThis as unknown as { flowplanUploadsInFlight?: Set<Promise<unknown>> };
const uploadsInFlight = () => (inflight.flowplanUploadsInFlight ??= new Set());
export const uploadsInFlightCount = () => uploadsInFlight().size;

// After a file was written to uploadPath(key): in cluster mode the object
// goes into the bucket before this returns (a few tries); a failure throws
// an HttpError 503, so the caller's transaction is rolled back (its
// rollback handler removes the local copy) and the request fails instead of
// answering with a file the other instances cannot read. Outside cluster
// mode nothing happens here: the queue uploads in the background as before.
export async function publishUpload(key: string): Promise<void> {
  const config = storageConfig();
  if (!clusterMode() || !config) return;
  const path = uploadPath(key);
  const job = (async () => {
    const keyId = currentKeyId();
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 250 * 4 ** (attempt - 1)));
      try {
        await putObject(config, key, path);
        await run("INSERT INTO storage_sealed(key,key_id) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET key_id=excluded.key_id", key, keyId);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  })();
  uploadsInFlight().add(job);
  try {
    await job;
  } catch (error) {
    console.error(`Dateispeicher: ${key} nicht in den Bucket geschrieben`, (error as Error)?.message || error);
    // HttpError is loaded here: lib/auth.ts imports the database, which imports this module.
    const { HttpError } = await import("./auth");
    throw new HttpError(503, "Die Datei konnte nicht gespeichert werden (Objektspeicher nicht erreichbar). Bitte versuche es gleich noch einmal.");
  } finally {
    uploadsInFlight().delete(job);
  }
}
// Takes back what publishUpload put into the bucket, for a file that was
// refused after it went up (lib/page-upload.ts storeUploadFile). Outside
// cluster mode nothing went up early: nothing to do.
export async function unpublishUpload(key: string): Promise<void> {
  const config = storageConfig();
  if (!clusterMode() || !config || !validKey(key)) return;
  if (await one("SELECT 1 FROM files WHERE id=?", key)) return;
  const response = await aws(config).fetch(objectUrl(config, key), { method: "DELETE" });
  if (!response.ok && response.status !== 404) throw new Error(`DELETE ${response.status}`);
  await run("DELETE FROM storage_sealed WHERE key=?", key);
}
// Writes a stored file and publishes it (see publishUpload).
export async function writeUpload(key: string, data: Uint8Array) {
  const path = uploadPath(key);
  mkdirSync(uploadsDir(), { recursive: true });
  writeFileSync(path, data);
  await publishUpload(key);
}
// A copy of a stored file under a new key (copies of pages, records,
// templates); false when the source exists nowhere.
export async function copyUpload(from: string, to: string): Promise<boolean> {
  const source = await localUpload(from);
  if (!source) return false;
  mkdirSync(uploadsDir(), { recursive: true });
  await copyFile(source, uploadPath(to));
  await publishUpload(to);
  return true;
}

// ---- The local cache (cluster mode, S3_LOCAL_CACHE) ----

// S3_LOCAL_CACHE: "2GB", "500MB", "1.5 GiB" … (1 GB = 1024 MB). Empty or 0:
// no limit (0); not understood: null (then ignored, with a log line).
const SIZE_UNITS: Record<string, number> = { b: 1, k: 1024, kb: 1024, kib: 1024, m: 1024 ** 2, mb: 1024 ** 2, mib: 1024 ** 2, g: 1024 ** 3, gb: 1024 ** 3, gib: 1024 ** 3, t: 1024 ** 4, tb: 1024 ** 4, tib: 1024 ** 4 };
export function parseCacheSize(value: string | undefined): number | null {
  const text = (value ?? "").trim();
  if (!text || text === "0") return 0;
  const match = /^(\d+(?:[.,]\d+)?)\s*(b|[kmgt](?:i?b)?)$/i.exec(text);
  if (!match) return null;
  return Math.floor(Number(match[1].replace(",", ".")) * SIZE_UNITS[match[2].toLowerCase()]);
}
export function formatSize(bytes: number) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes,
    i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${Math.round(value * 10) / 10} ${units[i]}`;
}
// The cache's size limit in bytes (0: none): S3_LOCAL_CACHE, otherwise in
// cluster mode FLOWPLAN_CACHE_MAX_MB (the Helm chart sets it below the
// emptyDir's sizeLimit).
export function cacheLimitBytes(env: Record<string, string | undefined> = process.env) {
  const configured = parseCacheSize(env.S3_LOCAL_CACHE);
  if (configured) return configured;
  return clusterMode(env) ? Math.max(0, Number(env.FLOWPLAN_CACHE_MAX_MB) || 0) * 1024 * 1024 : 0;
}
// Whether the uploads folder is only a cache of the bucket: cluster mode, or
// a single instance with S3_LOCAL_CACHE. Without S3 never.
export function localCacheMode(env: Record<string, string | undefined> = process.env) {
  if (!env.S3_BUCKET?.trim()) return false;
  return clusterMode(env) || !!parseCacheSize(env.S3_LOCAL_CACHE);
}

// When each file was last used: in memory (a Map entry per read, nothing
// else on the request's path), written as the file's mtime by the cache's
// round (flushUseStamps) – so the order survives a restart without a write
// per request. The round orders by max(stamp, mtime).
type CacheStats = {
  at: number;
  limit: number;
  // Locally: files and bytes of the cache.
  files: number;
  bytes: number;
  // Only in the bucket (evicted, or not fetched yet).
  remoteFiles: number;
  remoteBytes: number;
};
const cacheState = globalThis as unknown as {
  flowplanCacheUsed?: Map<string, number>;
  flowplanCacheStats?: CacheStats;
  flowplanCacheUnverified?: Map<string, number>;
  flowplanCacheInUse?: Map<string, number>;
};
const usedStamps = () => (cacheState.flowplanCacheUsed ??= new Map());
// Files a whole-instance copy reads right now (withUploadFile): never removed.
const inUse = () => (cacheState.flowplanCacheInUse ??= new Map());
export function noteUse(key: string, now = Date.now()) {
  if (!localCacheMode()) return;
  const used = usedStamps();
  used.set(key, now);
  // Bounded: what the round has not written yet is lost at worst.
  if (used.size > 100_000) used.delete(used.keys().next().value!);
}
export function flushUseStamps() {
  const used = usedStamps();
  for (const [key, at] of [...used]) {
    try {
      if (statSync(localPath(key)).mtimeMs < at - 1000) utimesSync(localPath(key), at / 1000, at / 1000);
    } catch {}
    if (used.get(key) === at) used.delete(key);
  }
}

// A file the round may remove must be confirmed in the bucket: uploaded
// (storage_sealed, with the key it went up with), no job of the queue left
// for it, and the object there with the expected size (HEAD) – the local
// size, plus the encryption's overhead when it went up sealed. A file whose
// object is gone although it counts as uploaded is queued again.
async function confirmedInBucket(config: StorageConfig, key: string, size: number, keyId: string) {
  const response = await aws(config).fetch(objectUrl(config, key), { method: "HEAD", signal: AbortSignal.timeout(10_000) });
  if (response.status === 404) {
    await run("DELETE FROM storage_sealed WHERE key=?", key);
    await run("INSERT INTO storage_queue(key,op) SELECT id,'put' FROM files WHERE id=? ON CONFLICT(key) DO NOTHING", key);
    setImmediate(kickStorage);
    return false;
  }
  if (!response.ok) return false;
  const length = Number(response.headers.get("content-length"));
  return Number.isFinite(length) && length === size + (keyId ? OVERHEAD : 0);
}

// Files used or written in the last ten minutes stay (a reader that has
// just fetched one reads it by its path); open files are safe anyway (their
// data stays until they are closed).
const CACHE_GRACE_MS = 10 * 60_000;
// Bounded work per round: at most this many checks in the bucket; the next
// round (scheduled right away when the cache is still too full) goes on.
const PRUNE_CHECKS = 200;

// Removes the least recently used files confirmed in the bucket until the
// cache is below 80 % of the limit. Returns what was removed.
export async function pruneUploadCache(now = Date.now(), limit = cacheLimitBytes()) {
  const config = storageConfig();
  if (!config || !localCacheMode() || !limit) return { removed: 0, bytes: 0 };
  flushUseStamps();
  let names: string[] = [];
  try {
    names = readdirSync(uploadsDir());
  } catch {}
  // Temporary downloads left by a process that ended while reading.
  for (const name of names)
    if (/\.[0-9a-f]{12}\.read$/.test(name))
      try {
        if (now - statSync(localPath(name)).mtimeMs > 3_600_000) rmSync(localPath(name), { force: true });
      } catch {}
  names = names.filter(validKey);
  const files: { key: string; size: number; at: number }[] = [];
  let total = 0;
  for (let i = 0; i < names.length; i++) {
    // Large folders: let requests through every few thousand files.
    if (i && i % 5000 === 0) await new Promise((r) => setImmediate(r));
    try {
      const info = statSync(localPath(names[i]));
      if (!info.isFile()) continue;
      total += info.size;
      files.push({ key: names[i], size: info.size, at: info.mtimeMs });
    } catch {}
  }
  let removed = 0,
    bytes = 0,
    checks = 0;
  if (total > limit) {
    const sealed = new Map((await all<{ key: string; key_id: string }>("SELECT key,key_id FROM storage_sealed")).map((r) => [String(r.key), String(r.key_id ?? "")]));
    const queued = new Set((await all<{ key: string }>("SELECT key FROM storage_queue")).map((r) => String(r.key)));
    // Checked and not confirmed: asked again after an hour at the earliest.
    const unverified = (cacheState.flowplanCacheUnverified ??= new Map());
    for (const file of files.sort((a, b) => a.at - b.at || a.key.localeCompare(b.key))) {
      if (total <= limit * 0.8 || checks >= PRUNE_CHECKS) break;
      if (now - file.at < CACHE_GRACE_MS) break; // the rest is newer
      const keyId = sealed.get(file.key);
      if (keyId === undefined || queued.has(file.key) || inUse().has(file.key) || now - (unverified.get(file.key) ?? -Infinity) < 3_600_000) continue;
      checks++;
      let confirmed = false;
      try {
        confirmed = await confirmedInBucket(config, file.key, file.size, keyId);
      } catch {}
      if (!confirmed) {
        unverified.set(file.key, now);
        if (unverified.size > 50_000) unverified.clear();
        continue;
      }
      // Once more right before removing: written, used, read or queued
      // while the bucket answered.
      try {
        const info = statSync(localPath(file.key));
        if (info.size !== file.size || info.mtimeMs !== file.at) continue;
      } catch {
        continue;
      }
      if (usedStamps().has(file.key) || inUse().has(file.key) || (await one("SELECT 1 FROM storage_queue WHERE key=?", file.key))) continue;
      rmSync(localPath(file.key), { force: true });
      total -= file.size;
      bytes += file.size;
      removed++;
    }
  }
  if (removed) console.log(`Dateispeicher: ${removed} Dateien (${formatSize(bytes)}) aus dem lokalen Zwischenspeicher entfernt, sie liegen im Bucket`);
  await recordCacheStats(now, limit, files.length - removed, total);
  if (total > limit * 0.8 && checks >= PRUNE_CHECKS) schedulePrune(1_000);
  return { removed, bytes };
}
async function recordCacheStats(now: number, limit: number, localFiles: number, localBytes: number) {
  // Files confirmed in the bucket that are not here.
  let remoteFiles = 0,
    remoteBytes = 0;
  for (const row of await all<{ id: string; size: number }>("SELECT f.id,COALESCE(f.size,0) size FROM files f JOIN storage_sealed s ON s.key=f.id"))
    if (!(validKey(String(row.id)) && existsSync(localPath(String(row.id))))) {
      remoteFiles++;
      remoteBytes += Number(row.size);
    }
  cacheState.flowplanCacheStats = { at: now, limit, files: localFiles, bytes: localBytes, remoteFiles, remoteBytes };
}
// One round at a time; a later request for one moves it no further out.
function schedulePrune(delay: number) {
  const s = state.flowplanStorage;
  if (!s || !localCacheMode() || !cacheLimitBytes()) return;
  if (s.pruneSoon) {
    if (delay) return;
    clearTimeout(s.pruneSoon);
  }
  s.pruneSoon = setTimeout(() => {
    s.pruneSoon = undefined;
    if (state.flowplanStorage !== s || s.pruning) return;
    s.pruning = true;
    void pruneUploadCache()
      .catch((error) => console.error("Dateispeicher: Zwischenspeicher nicht bereinigt", error))
      .finally(() => (s.pruning = false));
  }, delay);
  s.pruneSoon.unref?.();
}
// For Admin → Storage & backup and /api/health: the cache's limit (0: none,
// cluster mode without FLOWPLAN_CACHE_MAX_MB), what is here and what only
// in the bucket – from the last round, counted now when that is older than
// a quarter of an hour. null: no cache (every file stays local).
export async function uploadCacheStatus(now = Date.now()) {
  if (!state.flowplanStorage || !storageConfig() || !localCacheMode()) return null;
  const limit = cacheLimitBytes();
  let stats = cacheState.flowplanCacheStats;
  if (!stats || stats.limit !== limit || now - stats.at > 15 * 60_000) {
    let files = 0,
      bytes = 0;
    try {
      for (const name of readdirSync(uploadsDir()).filter(validKey))
        try {
          const info = statSync(localPath(name));
          if (info.isFile()) {
            files++;
            bytes += info.size;
          }
        } catch {}
    } catch {}
    await recordCacheStats(now, limit, files, bytes);
    stats = cacheState.flowplanCacheStats!;
  }
  return {
    limitBytes: stats.limit,
    bytes: stats.bytes,
    files: stats.files,
    onlyInBucketFiles: stats.remoteFiles,
    onlyInBucketBytes: stats.remoteBytes,
    checkedAt: new Date(stats.at).toISOString(),
  };
}

// ---- Reading a file once, without putting it back into the cache ----

// Downloads an object to a temporary file next to the cache (a name the
// round never touches) and returns its path; null when it is nowhere. The
// caller removes it.
async function fetchTemporary(key: string): Promise<string | null> {
  const config = storageConfig();
  if (!config || !validKey(key)) return null;
  try {
    const response = await aws(config).fetch(objectUrl(config, key));
    if (!response.ok) return null;
    mkdirSync(uploadsDir(), { recursive: true });
    const path = `${localPath(key)}.${randomBytes(6).toString("hex")}.read`;
    await settleDownload(key, response, path, `${localPath(key)}.${randomBytes(6).toString("hex")}.read`, true);
    return path;
  } catch (error) {
    console.error(`Dateispeicher: ${key} – ${(error as Error).message}`);
    return null;
  }
}
// Runs `use` with a path to read the file from: the local file (kept from
// the round while `use` runs), or – in cache mode, when it is only in the
// bucket – a temporary download removed afterwards. Whole-instance copies
// (backup, SFTP mirror, move) read every file this way, so they neither
// fill the cache nor change its order. null when the file exists nowhere.
export async function withUploadFile<T>(key: string, use: (path: string) => Promise<T>): Promise<T | null> {
  if (!validKey(key)) return null;
  const path = localPath(key);
  const pins = inUse();
  pins.set(key, (pins.get(key) ?? 0) + 1);
  try {
    if (existsSync(path)) return await use(path);
    if (!localCacheMode()) return (await ensureLocal(key)) ? await use(path) : null;
  } finally {
    const left = (pins.get(key) ?? 1) - 1;
    if (left) pins.set(key, left);
    else pins.delete(key);
  }
  const temporary = await fetchTemporary(key);
  if (!temporary) return null;
  try {
    return await use(temporary);
  } finally {
    rmSync(temporary, { force: true });
  }
}
// The same as an open file (its descriptor and size): opened before it is
// returned, so neither the round nor the temporary file's removal can take
// it away meanwhile. The caller closes it (a read stream on it does).
export async function openUpload(key: string): Promise<{ fd: number; size: number } | null> {
  if (!validKey(key)) return null;
  const opened = (path: string) => {
    const fd = openSync(path, "r");
    return { fd, size: fstatSync(fd).size };
  };
  const path = localPath(key);
  try {
    return opened(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!localCacheMode()) return (await ensureLocal(key)) ? opened(path) : null;
  const temporary = await fetchTemporary(key);
  if (!temporary) return null;
  try {
    return opened(temporary);
  } finally {
    rmSync(temporary, { force: true });
  }
}
// As a stream (the instance backup's ZIP reads its entries one by one).
export async function openUploadStream(key: string, start = 0): Promise<Readable | null> {
  const file = await openUpload(key);
  return file ? createReadStream("", { fd: file.fd, start }) : null;
}

// Shutdown (lib/cluster/runtime.ts): the uploads under way finish, then the
// due jobs of the queue this instance can do (its files) are drained – at
// most until the deadline. What is left, another instance takes over.
export async function flushStorage(deadline: number) {
  const wait = async (promise: Promise<unknown>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([promise.catch(() => {}), new Promise((r) => (timer = setTimeout(r, Math.max(0, deadline - Date.now()))))]);
    clearTimeout(timer);
  };
  await wait(Promise.allSettled([...uploadsInFlight()]));
  // The cache's order of use, kept for the next start.
  if (localCacheMode()) flushUseStamps();
  const s = state.flowplanStorage;
  if (!s || !storageConfig() || Date.now() >= deadline) return;
  if (s.timer) clearInterval(s.timer);
  // A drain under way first, then one more pass over what is due now.
  for (let i = 0; i < 3 && Date.now() < deadline; i++) {
    while (s.draining && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    const due = await one<{ n: number }>("SELECT COUNT(*) AS n FROM storage_queue WHERE next_at<=?", Date.now()).catch(() => null);
    if (!due || !Number(due.n)) return;
    s.draining = true;
    await wait(
      drain()
        .catch((error) => console.error("Dateispeicher: Abgleich beim Beenden fehlgeschlagen", error))
        .finally(() => (s.draining = false)),
    );
  }
}

// After a start without local files, all known files come back in the
// background; requests fetch what they need right away.
async function hydrate() {
  const s = state.flowplanStorage;
  // A cache (S3_LOCAL_CACHE, cluster mode) is never filled up again: what
  // the round removed comes back only when a request needs it.
  if (!s || localCacheMode()) return;
  const ids = (await all<{ id: string }>("SELECT id FROM files"))
    .map((row) => row.id)
    .filter((key) => validKey(key) && !existsSync(localPath(key)));
  let restored = 0;
  for (const key of ids)
    if (!(await one("SELECT 1 FROM storage_queue WHERE key=?", key)) && await ensureLocal(key))
      restored++;
  if (restored) console.log(`Dateispeicher: ${restored} Dateien aus dem Bucket geladen`);
}

export async function storageStatus() {
  const s = state.flowplanStorage;
  const config = storageConfig();
  if (!config || !s) return { enabled: false as const };
  const row = (await one<{ pending: number; attempts: number }>("SELECT COUNT(*) AS pending, COALESCE(MAX(attempts),0) AS attempts FROM storage_queue"))!;
  return {
    enabled: true as const,
    bucket: config.bucket,
    pending: Number(row.pending),
    failing: Number(row.attempts) > 0,
  };
}

// Files whose object in the bucket is not (yet) encrypted with the current
// key: from before encryption was turned on, or with an earlier key.
export async function storageEncryption() {
  const s = state.flowplanStorage;
  if (!s || !storageConfig()) return null;
  let keyId = "";
  try {
    keyId = currentKeyId();
  } catch {}
  const count = async (query: string, ...args: string[]) => Number((await one<{ n: number }>(query, ...args))?.n || 0);
  return {
    files: await count("SELECT count(*) n FROM files"),
    behind: keyId
      ? (await count(
          "SELECT count(*) n FROM files f LEFT JOIN storage_sealed x ON x.key=f.id WHERE x.key_id IS NULL OR x.key_id<>?",
          keyId,
        ))
      : 0,
  };
}
// Uploads those again; the queue encrypts them on the way.
export async function encryptExistingObjects() {
  const s = state.flowplanStorage;
  const keyId = currentKeyId();
  if (!s || !keyId) return 0;
  const result = await run(
    `INSERT INTO storage_queue(key,op) SELECT f.id,'put' FROM files f LEFT JOIN storage_sealed x ON x.key=f.id
     WHERE (x.key_id IS NULL OR x.key_id<>?) AND f.id NOT IN (SELECT key FROM storage_queue)
     ON CONFLICT(key) DO NOTHING`,
    keyId,
  );
  setImmediate(kickStorage);
  return Number(result.changes);
}
