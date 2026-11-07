// Delayed deletion of the files mirrored next to the scheduled backups
// (SFTP: lib/sftp-backup.ts, S3: lib/storage.ts and lib/scheduled-backup.ts).
// No imports: lib/storage.ts is loaded by lib/db.ts.

// When a backup was made, from its name (minutes, UTC); null for others.
export function backupTime(name: string) {
  const m = /flowplan-(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})\.(sqlite|dump)(\.enc)?$/.exec(name);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : null;
}
// The oldest backup still on the target (after old ones were removed).
export function oldestBackup(names: string[]) {
  const times = names.map(backupTime).filter((t): t is number => t !== null);
  return times.length ? Math.min(...times) : null;
}

// Delayed deletion of mirrored files: a file deleted here is not removed
// from the backup target right away but moved to .deleted/uploads/ there,
// named <file>.<when it was moved, ms since 1970> – the time travels with
// the name, so it survives copying the folder or restoring the instance
// elsewhere. It goes for good only once it was moved before the oldest
// backup still kept there: then no kept backup refers to it any more, and
// every kept backup can be restored with all its files.
export const DELETED_UPLOADS = ".deleted/uploads";
export const deletedName = (file: string, at: number) => `${file}.${Math.floor(at)}`;
export function parseDeleted(name: string) {
  const m = /^([A-Za-z0-9_-]{1,100})\.(\d{1,16})$/.exec(name);
  return m ? { file: m[1], at: Number(m[2]), name } : null;
}
export type DeletedCopy = NonNullable<Awaited<ReturnType<typeof parseDeleted>>>;
// The newest deleted copy of each file.
export function newestDeleted(copies: DeletedCopy[]) {
  const map = new Map<string, DeletedCopy>();
  for (const c of copies) if ((map.get(c.file)?.at ?? -1) < c.at) map.set(c.file, c);
  return map;
}
// Purged once moved before the oldest kept backup; never without a backup.
export const purgeable = (copy: DeletedCopy, oldest: number | null) => oldest !== null && copy.at < oldest;
