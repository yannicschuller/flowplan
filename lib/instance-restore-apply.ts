import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

// The files of the data folder an instance move brings along besides the
// database and uploads (lib/instance-move-pull.ts, MOVE_EXTRAS).
const MOVE_EXTRAS = ["web-push-keys.json", "secrets.key"];

// Swaps a validated instance restore into place before the database opens.
// The previous state moves to pre-restore-<time> (pre-move-<time> after an
// instance move, lib/instance-move.ts) and can be recovered.
// A pg_dump archive (flowplan.dump, a scheduled backup of a PostgreSQL
// instance) is staged only on PostgreSQL; it lands in the data folder as
// flowplan.dump for lib/db-restore.ts. SQLite (`dumps: false`) leaves such
// a restore where it is.
export function applyPendingRestore(dir: string, options: { dumps?: boolean } = {}) {
  const pending = resolve(dir, "restore-pending");
  if (!existsSync(resolve(pending, "READY"))) return null;
  const dump = existsSync(resolve(pending, "flowplan.dump"));
  if (dump && options.dumps === false) {
    console.error("Wiederherstellung übersprungen: ein PostgreSQL-Dump lässt sich nur mit PostgreSQL wiederherstellen (DATABASE_URL).");
    return null;
  }
  const move = existsSync(resolve(pending, "MOVE"));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const previous = resolve(dir, `${move ? "pre-move" : "pre-restore"}-${stamp}`);
  mkdirSync(previous, { recursive: true });
  for (const name of [
    "flowplan.sqlite",
    "flowplan.sqlite-wal",
    "flowplan.sqlite-shm",
    "uploads",
  ])
    if (existsSync(resolve(dir, name)))
      renameSync(resolve(dir, name), resolve(previous, name));
  // A move brings the instance's own keys: the old ones are kept as well.
  for (const name of MOVE_EXTRAS)
    if (move && existsSync(resolve(pending, name))) {
      if (existsSync(resolve(dir, name))) renameSync(resolve(dir, name), resolve(previous, name));
      renameSync(resolve(pending, name), resolve(dir, name));
    }
  if (dump) renameSync(resolve(pending, "flowplan.dump"), resolve(dir, "flowplan.dump"));
  else
    renameSync(
      resolve(pending, "flowplan.sqlite"),
      resolve(dir, "flowplan.sqlite"),
    );
  if (existsSync(resolve(pending, "uploads")))
    renameSync(resolve(pending, "uploads"), resolve(dir, "uploads"));
  else mkdirSync(resolve(dir, "uploads"), { recursive: true });
  rmSync(pending, { recursive: true, force: true });
  // With object storage configured, every restored file is uploaded again.
  writeFileSync(resolve(dir, "storage-resync"), "");
  // Language data and caches are rebuilt on demand.
  for (const name of readdirSync(dir))
    if (name === "tmp")
      rmSync(resolve(dir, name), { recursive: true, force: true });
  return previous;
}
