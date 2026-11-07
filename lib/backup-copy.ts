// What the scheduled backups share (lib/scheduled-backup.ts for S3 and the
// data folder, lib/sftp-backup.ts for SFTP): the consistent copy of the
// database (VACUUM INTO, encrypted with FLOWPLAN_ENCRYPTION_KEY), its name
// and which old copies go.
import { snapshotDatabase } from "./db-snapshot";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { id, run } from "./db";
import { encryptionEnabled, seal } from "./encryption";

const dataDir = () => resolve(/* turbopackIgnore: true */ process.env.FLOWPLAN_DATA_DIR || "./data");
// A backup file of its own (flowplan-2026-11-06-03-00.sqlite[.enc]).
export const BACKUP_FILE = /^flowplan-[\d-]+\.sqlite(\.enc)?$/;
export const backupName = (now: number, encrypted: boolean) =>
  `flowplan-${new Date(now).toISOString().slice(0, 16).replace(/[:T]/g, "-")}.sqlite${encrypted ? ".enc" : ""}`;

// The names sort by time; everything but the newest `keep` goes.
export function beyondKeep(names: string[], keep: number) {
  const sorted = [...names].sort();
  return sorted.slice(0, Math.max(0, sorted.length - Math.max(1, keep)));
}

// Where the next copy goes (<data>/tmp); the caller removes it, also when
// databaseCopy fails halfway.
export function copyPath() {
  const tmp = resolve(dataDir(), "tmp");
  mkdirSync(tmp, { recursive: true });
  return resolve(tmp, `backup-${id()}.sqlite`);
}
// A consistent copy of the database, encrypted when a key is set.
export async function databaseCopy(now: number, copy: string) {
  // Fails before anything is written when the key is wrong.
  const encrypted = encryptionEnabled();
  await snapshotDatabase(copy);
  if (encrypted) writeFileSync(copy, seal(readFileSync(copy)));
  return { copy, name: backupName(now, encrypted), encrypted, bytes: statSync(copy).size };
}
