// lib/db-snapshot.ts and lib/db-restore.ts on both databases: a table
// larger than one batch goes into the backup file and comes back whole
// (Postgres: cursor batches out, a few hundred rows per INSERT in).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-tests-"));
const { run, one, id, transaction } = await import("../lib/db");
const { snapshotDatabase } = await import("../lib/db-snapshot");
const { loadSqliteFile } = await import("../lib/db-restore");
const { onPostgres } = await import("./helpers/backend");

const ROWS = 1234;
test("a snapshot holds every row of a table larger than a batch; a restore brings them back", async () => {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, `local:${uid}`, "Ada", "ada@example.test");
  await transaction(async () => {
    for (let i = 0; i < ROWS; i++) await run("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)", `t${String(i).padStart(5, "0")}`, uid, "[]", Date.now() + i);
  });
  const file = join(process.env.FLOWPLAN_DATA_DIR!, "snapshot.sqlite");
  await snapshotDatabase(file);
  const copy = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal((copy.prepare("SELECT COUNT(*) n FROM sessions").get() as { n: number }).n, ROWS);
    assert.equal((copy.prepare("SELECT name FROM users WHERE id=?").get(uid) as { name: string }).name, "Ada");
  } finally {
    copy.close();
  }
  if (!onPostgres) return;
  // Postgres: the file is loaded into the database again (an instance restore).
  await run("DELETE FROM sessions");
  await loadSqliteFile(file);
  assert.equal(Number((await one<{ n: number }>("SELECT COUNT(*) n FROM sessions"))!.n), ROWS);
  assert.equal((await one<{ token: string }>("SELECT token FROM sessions ORDER BY token DESC"))!.token, `t${String(ROWS - 1).padStart(5, "0")}`);
});
