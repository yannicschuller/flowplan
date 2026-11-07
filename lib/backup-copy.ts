// What the scheduled backups share (lib/scheduled-backup.ts for S3 and the
// data folder, lib/sftp-backup.ts for SFTP): the consistent copy of the
// database (encrypted with FLOWPLAN_ENCRYPTION_KEY), its name and which old
// copies go. SQLite: VACUUM INTO, flowplan-….sqlite. PostgreSQL: pg_dump in
// its custom format, flowplan-….dump (lib/pg-backup.ts) – restored with
// pg_restore on PostgreSQL; without the client tools, or with
// FLOWPLAN_BACKUP_FORMAT=sqlite, the portable SQLite copy as on SQLite
// (lib/db-snapshot.ts; restores on either database).
import { snapshotDatabase } from "./db-snapshot";
import { dumpDatabase, pgDumpAvailable } from "./pg-backup";
import { sql } from "./db";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { id, run } from "./db";
import { encryptionEnabled, seal } from "./encryption";

const dataDir = () => resolve(/* turbopackIgnore: true */ process.env.FLOWPLAN_DATA_DIR || "./data");
// A backup file of its own (flowplan-2026-11-06-03-00.sqlite[.enc], on
// PostgreSQL flowplan-2026-11-06-03-00.dump[.enc]).
export const BACKUP_FILE = /^flowplan-[\d-]+\.(sqlite|dump)(\.enc)?$/;
export type BackupFormat = "sqlite" | "pg_dump";
export const backupName = (now: number, encrypted: boolean, format: BackupFormat = "sqlite") =>
  `flowplan-${new Date(now).toISOString().slice(0, 16).replace(/[:T]/g, "-")}.${format === "pg_dump" ? "dump" : "sqlite"}${encrypted ? ".enc" : ""}`;
// pg_dump on PostgreSQL when its tools are there (and not switched off).
export async function backupFormat(): Promise<BackupFormat> {
  if (sql.name === "sqlite" || /^sqlite$/i.test(process.env.FLOWPLAN_BACKUP_FORMAT || "")) return "sqlite";
  if (await pgDumpAvailable()) return "pg_dump";
  console.warn("Backups: pg_dump is missing – the scheduled backup is a SQLite copy (install the PostgreSQL client tools or set FLOWPLAN_PG_BIN).");
  return "sqlite";
}

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
  const format = await backupFormat();
  if (format === "pg_dump") await dumpDatabase(copy);
  else await snapshotDatabase(copy);
  if (encrypted) writeFileSync(copy, seal(readFileSync(copy)));
  return { copy, name: backupName(now, encrypted, format), encrypted, format, bytes: statSync(copy).size };
}
