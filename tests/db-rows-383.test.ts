import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sqliteOnly } from "./helpers/backend";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-rows-383-"));
const { sqliteAll, sqliteOne, sqliteRun } = await import("../lib/db");

// The SQLite helpers hand out plain objects (Object's prototype), one per
// row and call, without copying them (#383).
test("rows are plain objects of their own", { skip: sqliteOnly }, () => {
  sqliteRun("CREATE TABLE IF NOT EXISTS t383(id TEXT PRIMARY KEY,n INTEGER,v TEXT)");
  sqliteRun("INSERT INTO t383 VALUES('a',1,'x'),('b',2,NULL)");
  const rows = sqliteAll<{ id: string; n: number; v: string | null }>("SELECT * FROM t383 ORDER BY id");
  assert.deepStrictEqual(rows, [
    { id: "a", n: 1, v: "x" },
    { id: "b", n: 2, v: null },
  ]);
  for (const row of rows) {
    assert.equal(Object.getPrototypeOf(row), Object.prototype);
    assert.ok(row.hasOwnProperty("id"));
    assert.equal(String(row), "[object Object]");
  }
  const one = sqliteOne<{ id: string; n: number }>("SELECT * FROM t383 WHERE id=?", "a")!;
  assert.equal(Object.getPrototypeOf(one), Object.prototype);
  assert.deepStrictEqual(one, { id: "a", n: 1, v: "x" });
  assert.equal(sqliteOne("SELECT * FROM t383 WHERE id=?", "none"), undefined);
  // A caller may change its rows: the next call has its own.
  rows[0].n = 99;
  delete (rows[1] as { v?: unknown }).v;
  one.n = 42;
  assert.deepStrictEqual(sqliteAll("SELECT * FROM t383 ORDER BY id"), [
    { id: "a", n: 1, v: "x" },
    { id: "b", n: 2, v: null },
  ]);
  assert.notEqual(sqliteOne("SELECT * FROM t383 WHERE id=?", "a"), sqliteOne("SELECT * FROM t383 WHERE id=?", "a"));
});
