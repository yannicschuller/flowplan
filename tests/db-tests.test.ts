// The PostgreSQL job runs the test files that reach the database
// (scripts/db-tests.mjs, ci.yml): they are found through imports, so a new
// database test needs no list. Here: the ones that must be in, and that the
// selection really leaves some out.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const chosen = execFileSync(process.execPath, ["scripts/db-tests.mjs"], { encoding: "utf8" }).trim().split("\n");

test("database tests are chosen through their imports", () => {
  // lib/db directly, the SQLite → PostgreSQL migration (pg), the cluster
  // with the job's Redis, a route test that reaches the database through
  // the app's modules.
  for (const file of ["tests/db-migrate.test.ts", "tests/cluster.test.ts", "tests/pgvector.test.ts"]) assert.ok(chosen.includes(file), file);
  assert.ok(chosen.length > 300, `${chosen.length} files`);
});

test("files without the database stay in the SQLite job only", () => {
  for (const file of ["tests/docker-user.test.ts", "tests/e2e-build.test.ts", "tests/db-tests.test.ts"]) assert.ok(!chosen.includes(file), file);
  assert.ok(chosen.every((file) => /^tests\/[^/]+\.test\.ts$/.test(file)));
});
