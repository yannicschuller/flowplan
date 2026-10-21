// Scheduled backups: once a day a consistent copy of the database (VACUUM
// INTO). With S3 it goes to <prefix>/backups/ in the bucket, where the
// uploads are mirrored anyway; without S3 to backups/ in the data folder.
// The newest N copies are kept. Complements Litestream (continuous but
// only for the database) and the manual instance backup.
// With FLOWPLAN_ENCRYPTION_KEY the copy is encrypted (flowplan-….sqlite.enc,
// lib/encryption.ts), in the bucket and in the data folder alike. Daily, or
// hourly when Litestream is off and the encrypted copies replace it.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { id, one, run } from "./db";
import { instanceSettings } from "./instance-settings";
import { bucketFetch, storageConfig } from "./storage";
import { lastMarkdownExport, runMarkdownExports } from "./scheduled-markdown-export";
import { encryptionEnabled, seal } from "./encryption";
import { runDueSpaceGitExports } from "./space-git-export";

const dataDir = () => resolve(process.env.FLOWPLAN_DATA_DIR || "./data");
const DAY_MS = 86400_000;
const HOUR_MS = 3600_000;
// Plain and encrypted copies count alike when old ones are removed.
const BACKUP_NAME = /flowplan-[\d-]+\.sqlite(\.enc)?$/;

export type BackupRun = { at: number; target: "s3" | "local"; name: string; bytes: number; error: string | null };

function lastRun(): BackupRun | null {
  const row = one<{ value: string }>("SELECT value FROM instance_state WHERE key='scheduledBackup'");
  return row ? (JSON.parse(row.value) as BackupRun) : null;
}
function remember(result: BackupRun) {
  run(
    "INSERT INTO instance_state(key,value) VALUES('scheduledBackup',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    JSON.stringify(result),
  );
}

async function listBucket(prefix: string) {
  const response = await bucketFetch(`?list-type=2&prefix=${encodeURIComponent(prefix)}`, { method: "GET" });
  if (!response.ok) throw new Error(`Liste der Sicherungen: HTTP ${response.status}`);
  const xml = await response.text();
  return [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);
}

export async function runScheduledBackup(now = Date.now()): Promise<BackupRun> {
  const keep = Math.max(1, instanceSettings().backupKeep ?? 14);
  let name = `flowplan-${new Date(now).toISOString().slice(0, 16).replace(/[:T]/g, "-")}.sqlite`;
  const tmp = resolve(dataDir(), "tmp");
  mkdirSync(tmp, { recursive: true });
  const copy = resolve(tmp, `backup-${id()}.sqlite`);
  const config = storageConfig();
  let result: BackupRun;
  try {
    // Fails before anything is written when the key is wrong.
    const encrypted = encryptionEnabled();
    if (encrypted) name += ".enc";
    run(`VACUUM INTO '${copy.replaceAll("'", "''")}'`);
    if (encrypted) writeFileSync(copy, seal(readFileSync(copy)));
    const bytes = statSync(copy).size;
    if (config) {
      const response = await bucketFetch(`backups/${name}`, {
        method: "PUT",
        body: new Uint8Array(readFileSync(copy)),
        headers: { "Content-Type": encrypted ? "application/octet-stream" : "application/vnd.sqlite3" },
      });
      if (!response.ok) throw new Error(`Hochladen: HTTP ${response.status}`);
      const keys = (await listBucket(`${config.prefix ? `${config.prefix}/` : ""}backups/`))
        .filter((k) => BACKUP_NAME.test(k))
        .sort();
      for (const key of keys.slice(0, Math.max(0, keys.length - keep)))
        await bucketFetch(key.slice((config.prefix ? `${config.prefix}/` : "").length), { method: "DELETE" });
      result = { at: now, target: "s3", name, bytes, error: null };
    } else {
      const folder = resolve(dataDir(), "backups");
      mkdirSync(folder, { recursive: true });
      const { renameSync } = await import("node:fs");
      renameSync(copy, resolve(folder, name));
      const files = readdirSync(folder)
        .filter((f) => BACKUP_NAME.test(f))
        .sort();
      for (const file of files.slice(0, Math.max(0, files.length - keep))) rmSync(resolve(folder, file));
      result = { at: now, target: "local", name, bytes, error: null };
    }
  } catch (error) {
    result = { at: now, target: config ? "s3" : "local", name, bytes: 0, error: String((error as Error).message || error).slice(0, 300) };
  } finally {
    if (existsSync(copy)) rmSync(copy);
  }
  remember(result);
  return result;
}

export function scheduledBackupStatus() {
  const settings = instanceSettings();
  return {
    enabled: settings.backupSchedule !== false,
    hourly: settings.backupInterval === "hourly",
    encrypted: (() => {
      try {
        return encryptionEnabled();
      } catch {
        return false;
      }
    })(),
    keep: settings.backupKeep ?? 14,
    target: storageConfig() ? ("s3" as const) : ("local" as const),
    last: lastRun(),
  };
}

const runtime = globalThis as unknown as { flowplanBackupTimer?: ReturnType<typeof setInterval>; flowplanBackupBusy?: boolean };
// Checks every 10 minutes whether the next backup is due.
export function startBackupWorker() {
  if (runtime.flowplanBackupTimer) return;
  const backupDue = () => {
    const status = scheduledBackupStatus();
    if (!status.enabled) return false;
    if (status.last && Date.now() - status.last.at < (status.hourly ? HOUR_MS - 5 * 60_000 : DAY_MS) && !status.last.error) return false;
    return !(status.last?.error && Date.now() - status.last.at < 3600_000);
  };
  const tick = async () => {
    if (runtime.flowplanBackupBusy) return;
    runtime.flowplanBackupBusy = true;
    try {
      if (backupDue()) {
        await runScheduledBackup();
        // The readable copy (Markdown, optionally into Git) comes along, once
        // a day also with hourly backups.
        const exported = lastMarkdownExport();
        if (!exported || Date.now() - exported >= DAY_MS - 30 * 60_000)
          await runMarkdownExports().catch((error) => console.error("Markdown export failed", error));
      }
      // The Git export of spaces whose interval has passed, also when
      // backups are off (lib/space-git-export.ts).
      await runDueSpaceGitExports().catch((error) => console.error("Space Git export failed", error));
    } catch (error) {
      // Nothing here may become an unhandled rejection of the interval.
      console.error("Scheduled backup check failed", error);
    } finally {
      runtime.flowplanBackupBusy = false;
    }
  };
  runtime.flowplanBackupTimer = setInterval(() => void tick(), 10 * 60_000);
  runtime.flowplanBackupTimer.unref?.();
  setTimeout(() => void tick(), 60_000).unref?.();
}
