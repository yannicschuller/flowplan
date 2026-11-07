// Scheduled backups: once a day a consistent copy of the database (VACUUM
// INTO). With S3 it goes to <prefix>/backups/ in the bucket, where the
// uploads are mirrored anyway; without S3 to backups/ in the data folder.
// The newest N copies are kept. Complements Litestream (continuous but
// only for the database) and the manual instance backup.
// With FLOWPLAN_ENCRYPTION_KEY the copy is encrypted (flowplan-….sqlite.enc,
// lib/encryption.ts), in the bucket and in the data folder alike. Daily, or
// hourly when Litestream is off and the encrypted copies replace it.
// An SFTP server (lib/sftp-backup.ts, #128) receives the same copy as well.
// Files deleted here stay in the bucket under .deleted/uploads/ as long as a
// kept backup may refer to them (lib/deleted-uploads.ts).
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { moveFile } from "./move-file";
import { resolve } from "node:path";
import { one, run } from "./db";
import { instanceSettings } from "./instance-settings";
import { bucketFetch, storageConfig } from "./storage";
import { lastMarkdownExport, runMarkdownExports } from "./scheduled-markdown-export";
import { encryptionEnabled } from "./encryption";
import { backupName, beyondKeep, copyPath, databaseCopy } from "./backup-copy";
import { DELETED_UPLOADS, oldestBackup, parseDeleted, purgeable } from "./deleted-uploads";
import { sendToSftp, sftpBackupActive, sftpBackupStatus } from "./sftp-backup";
import { runDueSpaceGitExports } from "./space-git-export";
import { firstAccount } from "./local-auth";

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

// All keys under a prefix (1000 per page).
async function listBucket(prefix: string) {
  const keys: string[] = [];
  let token = "";
  for (let page = 0; page < 1000; page++) {
    const response = await bucketFetch(
      `?list-type=2&prefix=${encodeURIComponent(prefix)}${token ? `&continuation-token=${encodeURIComponent(token)}` : ""}`,
      { method: "GET" },
    );
    if (!response.ok) throw new Error(`Liste der Sicherungen: HTTP ${response.status}`);
    const xml = await response.text();
    keys.push(...[...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]));
    token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? (/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1] ?? "") : "";
    if (!token) break;
  }
  return keys;
}

// Delayed deletion in the bucket (lib/deleted-uploads.ts, lib/storage.ts
// moves deleted files to .deleted/uploads/): removes the copies moved before
// the oldest kept backup – and at least a day ago, Litestream's history in
// the same bucket reaches that far back – and those of files that are back.
async function purgeDeleted(prefix: string, oldest: number | null, now: number) {
  let purged = 0;
  for (const key of await listBucket(`${prefix}${DELETED_UPLOADS}/`)) {
    const copy = parseDeleted(key.slice(`${prefix}${DELETED_UPLOADS}/`.length));
    if (!copy) continue;
    const back = !!one("SELECT 1 FROM files WHERE id=?", copy.file) && !one("SELECT 1 FROM storage_queue WHERE key=?", copy.file);
    if (!back && !(purgeable(copy, oldest) && copy.at < now - DAY_MS)) continue;
    const response = await bucketFetch(key.slice(prefix.length), { method: "DELETE" });
    if (response.ok || response.status === 404) purged++;
  }
  return purged;
}

export async function runScheduledBackup(now = Date.now()): Promise<BackupRun> {
  const keep = Math.max(1, instanceSettings().backupKeep ?? 14);
  let name = backupName(now, false);
  const copy = copyPath();
  const config = storageConfig();
  let result: BackupRun;
  let made: ReturnType<typeof databaseCopy> | null = null;
  try {
    made = databaseCopy(now, copy);
    name = made.name;
    const { encrypted, bytes } = made;
    if (config) {
      const response = await bucketFetch(`backups/${name}`, {
        method: "PUT",
        body: new Uint8Array(readFileSync(copy)),
        headers: { "Content-Type": encrypted ? "application/octet-stream" : "application/vnd.sqlite3" },
      });
      if (!response.ok) throw new Error(`Hochladen: HTTP ${response.status}`);
      const prefix = config.prefix ? `${config.prefix}/` : "";
      const keys = (await listBucket(`${prefix}backups/`)).filter((k) => BACKUP_NAME.test(k));
      const old = beyondKeep(keys, keep);
      for (const key of old) await bucketFetch(key.slice(prefix.length), { method: "DELETE" });
      // Not a failed backup when this does not work; the next run tries again.
      await purgeDeleted(prefix, oldestBackup(keys.filter((k) => !old.includes(k))), now).catch((error) =>
        console.error("Gelöschte Dateien im Bucket aufräumen fehlgeschlagen", (error as Error)?.message),
      );
      result = { at: now, target: "s3", name, bytes, error: null };
    } else {
      const folder = resolve(dataDir(), "backups");
      mkdirSync(folder, { recursive: true });
      // A copy, not a move, when the SFTP target below still sends this one.
      // A move that also works onto a mounted share (#161).
      (sftpBackupActive() ? copyFileSync : moveFile)(copy, resolve(folder, name));
      for (const file of beyondKeep(readdirSync(folder).filter((f) => BACKUP_NAME.test(f)), keep)) rmSync(resolve(folder, file));
      result = { at: now, target: "local", name, bytes, error: null };
    }
  } catch (error) {
    result = { at: now, target: config ? "s3" : "local", name, bytes: 0, error: String((error as Error).message || error).slice(0, 300) };
  }
  try {
    remember(result);
    // The same copy also goes to the SFTP server when one is set up; its
    // outcome is recorded on its own (lib/sftp-backup.ts).
    if (made && existsSync(copy) && sftpBackupActive()) await sendToSftp(made, now);
  } finally {
    if (existsSync(copy)) rmSync(copy);
  }
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
    // The additional SFTP target (lib/sftp-backup.ts).
    sftp: sftpBackupStatus(),
  };
}

const runtime = globalThis as unknown as { flowplanBackupTimer?: ReturnType<typeof setInterval>; flowplanBackupBusy?: boolean };
// Checks every 10 minutes whether the next backup is due.
export function startBackupWorker() {
  if (runtime.flowplanBackupTimer) return;
  const backupDue = () => {
    const status = scheduledBackupStatus();
    if (!status.enabled) return false;
    // Not before the first account: a new instance pointed at the bucket of
    // an old one would put its empty copy next to the old backups – as the
    // newest, the one the setup restore picks – and push one of them out of
    // the kept ones.
    if (firstAccount()) return false;
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
