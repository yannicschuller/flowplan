// A committed write is noted again at its commit (lib/db.ts noteCommitted):
// under PostgreSQL other connections see it only then, so a read on another
// connection between the statement and the COMMIT – the workspace live
// signal's version check, a memoized read – got the old rows under the new
// write generation and kept them (seen as a lost "renamed" signal,
// workspace-live.test.ts in CI).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-commit-generation-"));
const { id, run, one, transaction, writeGeneration } = await import("../lib/db");
const { onPostgres } = await import("./helpers/backend");

test("a transaction's writes count again once committed; a read-only one does not", { skip: !onPostgres && "PostgreSQL only: SQLite commits on the one connection" }, async () => {
  const uid = id();
  let during = 0;
  await transaction(async () => {
    await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, "Gen", `${uid}@example.com`);
    during = writeGeneration();
  });
  assert.ok(writeGeneration() > during, "the commit moved the generation on");
  const before = writeGeneration();
  await transaction(async () => {
    await one("SELECT id FROM users WHERE id=?", uid);
  });
  assert.equal(writeGeneration(), before, "nothing written, nothing noted");
  await run("DELETE FROM users WHERE id=?", uid);
});
