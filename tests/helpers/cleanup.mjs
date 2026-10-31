// Loaded before every test file (package.json "test"): removes the file's
// temporary data folder when its process ends, so test runs do not fill
// the disk (OCR language data alone is ~56 MB per folder).
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { isMainThread } from "node:worker_threads";

// The server's language catalogues (instrumentation.ts registers them in the
// app) – in the test itself, not in worker threads (OCR), which load this
// file without the TypeScript loader.
if (isMainThread) await import("../../lib/i18n-catalogs-server.ts");

process.on("exit", () => {
  const dir = process.env.FLOWPLAN_DATA_DIR;
  if (!dir) return;
  const path = resolve(dir);
  if (dirname(path) !== resolve(tmpdir()) || !basename(path).startsWith("flowplan-")) return;
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {}
});
