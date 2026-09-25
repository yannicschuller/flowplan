import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { resolve } from "node:path";

// Swaps a validated instance restore into place before the database opens.
// The previous state moves to pre-restore-<time> and can be recovered.
export function applyPendingRestore(dir: string) {
  const pending = resolve(dir, "restore-pending");
  if (!existsSync(resolve(pending, "READY"))) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const previous = resolve(dir, `pre-restore-${stamp}`);
  mkdirSync(previous, { recursive: true });
  for (const name of [
    "flowplan.sqlite",
    "flowplan.sqlite-wal",
    "flowplan.sqlite-shm",
    "uploads",
  ])
    if (existsSync(resolve(dir, name)))
      renameSync(resolve(dir, name), resolve(previous, name));
  renameSync(
    resolve(pending, "flowplan.sqlite"),
    resolve(dir, "flowplan.sqlite"),
  );
  if (existsSync(resolve(pending, "uploads")))
    renameSync(resolve(pending, "uploads"), resolve(dir, "uploads"));
  else mkdirSync(resolve(dir, "uploads"), { recursive: true });
  rmSync(pending, { recursive: true, force: true });
  // Language data and caches are rebuilt on demand.
  for (const name of readdirSync(dir))
    if (name === "tmp")
      rmSync(resolve(dir, name), { recursive: true, force: true });
  return previous;
}
