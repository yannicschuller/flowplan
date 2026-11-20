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

// Wave 3: the rows are built from arrays, one property per column in the
// columns' order (every row of a statement has the same shape).
test("rows keep the columns' order, names and values", { skip: sqliteOnly }, () => {
  sqliteRun("CREATE TABLE IF NOT EXISTS t383b(z TEXT,a INTEGER,m REAL,b BLOB)");
  sqliteRun("DELETE FROM t383b");
  sqliteRun("INSERT INTO t383b VALUES('z',1,1.5,x'0102'),(NULL,NULL,NULL,NULL)");
  const rows = sqliteAll<Record<string, unknown>>("SELECT * FROM t383b ORDER BY a IS NULL");
  assert.deepStrictEqual(Object.keys(rows[0]), ["z", "a", "m", "b"]);
  assert.equal(rows[0].z, "z");
  assert.equal(rows[0].a, 1);
  assert.equal(rows[0].m, 1.5);
  assert.deepStrictEqual([...(rows[0].b as Uint8Array)], [1, 2]);
  assert.deepStrictEqual(rows[1], { z: null, a: null, m: null, b: null });
  // Aliases, and a name that comes twice keeps its last value (as
  // node:sqlite's own objects did).
  assert.deepStrictEqual(sqliteOne("SELECT 1 x,2 x,3 y"), { x: 2, y: 3 });
  assert.deepStrictEqual(sqliteAll("SELECT a n,z FROM t383b WHERE a=?", 1), [{ n: 1, z: "z" }]);
  // A column called __proto__ stays a property.
  const odd = sqliteOne<Record<string, unknown>>('SELECT 1 "__proto__",2 x')!;
  assert.equal(Object.getPrototypeOf(odd), Object.prototype);
  assert.deepStrictEqual(Object.keys(odd), ["__proto__", "x"]);
  // RETURNING through sqliteAll/sqliteOne.
  assert.deepStrictEqual(sqliteAll("INSERT INTO t383b(z,a) VALUES('r',7) RETURNING z,a"), [{ z: "r", a: 7 }]);
  // Statements without rows.
  assert.deepStrictEqual(sqliteAll("SELECT * FROM t383b WHERE a=-1"), []);
});

test("a cached SELECT * follows a column added later", { skip: sqliteOnly }, async () => {
  const { db } = await import("../lib/db");
  sqliteRun("CREATE TABLE IF NOT EXISTS t383c(id TEXT)");
  sqliteRun("INSERT INTO t383c VALUES('a')");
  assert.deepStrictEqual(sqliteOne("SELECT * FROM t383c"), { id: "a" });
  // Past run() (which forgets the cached statements): straight on the connection.
  db().exec("ALTER TABLE t383c ADD COLUMN extra TEXT DEFAULT 'e'");
  assert.deepStrictEqual(sqliteOne("SELECT * FROM t383c"), { id: "a", extra: "e" });
  assert.deepStrictEqual(sqliteAll("SELECT * FROM t383c"), [{ id: "a", extra: "e" }]);
});
