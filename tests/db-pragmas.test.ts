import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sqliteOnly } from "./helpers/backend";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-pragmas-"));
const { db, one, sqliteCacheBytes } = await import("../lib/db");

// How the SQLite file is used (#383): WAL with synchronous=NORMAL, a larger
// page cache, memory-mapped reads, temporary data in memory, and the
// planner's statistics from PRAGMA optimize.
test("the connection is tuned for WAL", { skip: sqliteOnly }, async () => {
  const d = db();
  const pragma = (name: string) => Object.values(d.prepare(`PRAGMA ${name}`).get() as Record<string, unknown>)[0];
  assert.equal(pragma("journal_mode"), "wal");
  assert.equal(pragma("synchronous"), 1, "NORMAL");
  assert.equal(pragma("cache_size"), -65536);
  assert.equal(pragma("mmap_size"), 268435456);
  assert.equal(pragma("temp_store"), 2, "MEMORY");
  assert.equal(pragma("foreign_keys"), 1);
  assert.equal(pragma("busy_timeout"), 5000);
  assert.equal(await sqliteCacheBytes(), 64 * 1024 * 1024);
  // PRAGMA optimize works on the open connection (through the driver too).
  d.exec("PRAGMA optimize");
  assert.ok(await one("SELECT 1 AS ok"));
});
