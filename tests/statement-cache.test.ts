import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-statement-cache-"));
const { one, all, run, db, reopenDatabase, transaction } = await import("../lib/db");

// lib/db.ts keeps the prepared statements of one/all/run per connection.

test("cached statements return current data and take new parameters", async () => {
  await run("CREATE TABLE IF NOT EXISTS cache_probe(id TEXT PRIMARY KEY,n INTEGER)");
  for (let i = 0; i < 5; i++) await run("INSERT INTO cache_probe(id,n) VALUES(?,?)", `r${i}`, i);
  for (let i = 0; i < 5; i++) assert.equal((await one<{ n: number }>("SELECT n FROM cache_probe WHERE id=?", `r${i}`))?.n, i);
  await run("UPDATE cache_probe SET n=n+10 WHERE id=?", "r1");
  assert.equal((await one<{ n: number }>("SELECT n FROM cache_probe WHERE id=?", "r1"))?.n, 11);
  assert.equal((await all("SELECT * FROM cache_probe ORDER BY id")).length, 5);
  // A row of a multi-row result does not keep the statement (and its read)
  // open: the table can be changed right after.
  assert.equal((await one<{ id: string }>("SELECT id FROM cache_probe ORDER BY id"))?.id, "r0");
  await transaction(async () => await run("DELETE FROM cache_probe WHERE id=?", "r4"));
  assert.equal((await all("SELECT * FROM cache_probe ORDER BY id")).length, 4);
  // Results are plain objects, not the statement's null-prototype rows.
  assert.equal(Object.getPrototypeOf(await one("SELECT n FROM cache_probe WHERE id=?", "r0")), Object.prototype);
});

test("a schema change is seen by statements prepared before it", async () => {
  assert.deepEqual(Object.keys((await one("SELECT * FROM cache_probe WHERE id=?", "r0"))!), ["id", "n"]);
  await run("ALTER TABLE cache_probe ADD COLUMN label TEXT NOT NULL DEFAULT 'x'");
  assert.deepEqual(await one("SELECT * FROM cache_probe WHERE id=?", "r0"), { id: "r0", n: 0, label: "x" });
  // Also when migrate() runs again (the schema number is reset by tests and
  // after a restore).
  (globalThis as { flowplanSchema?: number }).flowplanSchema = undefined;
  db();
  assert.deepEqual(Object.keys((await one("SELECT * FROM cache_probe WHERE id=?", "r0"))!), ["id", "n", "label"]);
});

test("a reopened database does not use the closed connection's statements", async () => {
  const before = db();
  assert.equal((await one<{ n: number }>("SELECT n FROM cache_probe WHERE id=?", "r2"))?.n, 2);
  const after = await reopenDatabase();
  assert.notEqual(after, before);
  assert.equal((await one<{ n: number }>("SELECT n FROM cache_probe WHERE id=?", "r2"))?.n, 2);
  await run("UPDATE cache_probe SET n=? WHERE id=?", 42, "r2");
  assert.equal((await one<{ n: number }>("SELECT n FROM cache_probe WHERE id=?", "r2"))?.n, 42);
});

test("many different statements stay correct beyond the cache size", async () => {
  for (let i = 0; i < 1200; i++)
    assert.equal((await one<{ v: number }>(`SELECT ${i} AS v, n FROM cache_probe WHERE id=?`, "r0"))?.v, i);
  assert.equal((await one<{ n: number }>("SELECT n FROM cache_probe WHERE id=?", "r0"))?.n, 0);
});
