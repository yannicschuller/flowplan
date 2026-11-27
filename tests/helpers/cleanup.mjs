// Loaded before every test file (package.json "test"): removes the file's
// temporary data folder when its process ends, so test runs do not fill
// the disk (OCR language data alone is ~56 MB per folder).
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { isMainThread } from "node:worker_threads";
import { AsyncLocalStorage } from "node:async_hooks";

// Next.js picks its request-scope storage when its modules load: a real
// AsyncLocalStorage only if the global exists then (Next's server sets it,
// next/dist/server/node-environment-baseline). Tests that call route
// handlers in a request scope (tests/helpers/next-request.ts) need it even
// when another test file in the same process loaded Next first – as in the
// PostgreSQL run, where the files share a process.
if (typeof globalThis.AsyncLocalStorage !== "function") globalThis.AsyncLocalStorage = AsyncLocalStorage;

// The server's language catalogues load on first use (instrumentation.ts
// sets up the loader in the app; lib/i18n-catalogs-server.ts) – in the test
// itself, not in worker threads (OCR), which load this file without the
// TypeScript loader. A test that translates synchronously into fr, zh or ru
// awaits ensureCatalog() first.
if (isMainThread) await import("../../lib/i18n-catalogs-server.ts");

// DATABASE_URL=postgres://…: this test file runs against PostgreSQL, in a
// schema of its own (tests/helpers/postgres-backend.ts); else SQLite.
const databaseUrl = process.env.DATABASE_URL || "";
if (isMainThread && /^postgres(ql)?:\/\//i.test(databaseUrl))
  await (await import("./postgres-backend.ts")).preparePostgres(databaseUrl);

process.on("exit", () => {
  // Only the test's own process: a worker thread that ends (OCR,
  // lib/worker-pool.ts) shares the folder and leaves it alone.
  if (!isMainThread) return;
  const dir = process.env.FLOWPLAN_DATA_DIR;
  if (!dir) return;
  const path = resolve(dir);
  if (dirname(path) !== resolve(tmpdir()) || !basename(path).startsWith("flowplan-")) return;
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {}
});
