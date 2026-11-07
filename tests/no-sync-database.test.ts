// Phase 2 of #127: the server reaches PostgreSQL through the asynchronous
// pool only. The blocking bridge of phase 1 (a worker thread answering
// synchronous calls through Atomics.wait) is gone and must not come back:
// it blocked the event loop for every round trip. The synchronous SQLite
// statements of lib/db.ts (sqliteOne/sqliteAll/sqliteRun) are for the
// SQLite driver alone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(root, dir))) {
    const path = join(dir, name);
    if (statSync(join(root, path)).isDirectory()) out.push(...sources(path));
    else if (/\.(ts|tsx|mjs|js)$/.test(name)) out.push(path);
  }
  return out;
}
const server = [...sources("lib"), ...sources("app"), ...sources("components"), "instrumentation.ts", "proxy.ts", "next.config.ts"];

test("no blocking bridge to PostgreSQL in the server code", () => {
  assert.equal(existsSync(join(root, "lib/db-driver/pg-sync.ts")), false);
  assert.equal(existsSync(join(root, "lib/db-driver/pg-sync-worker.mjs")), false);
  const offending = server.filter((file) => /pg-sync|Atomics\.wait\(|receiveMessageOnPort/.test(readFileSync(join(root, file), "utf8")));
  assert.deepEqual(offending, []);
});

test("the synchronous SQLite statements are used by the SQLite driver only", () => {
  const offending = server.filter(
    (file) => !["lib/db.ts", "lib/db-driver/sqlite.ts"].includes(file) && /\bsqlite(One|All|Run)\b/.test(readFileSync(join(root, file), "utf8")),
  );
  assert.deepEqual(offending, []);
});

test("one/all/run/transaction of lib/db.ts return promises", async () => {
  process.env.FLOWPLAN_DATA_DIR ??= (await import("node:fs")).mkdtempSync(join((await import("node:os")).tmpdir(), "flowplan-tests-"));
  const { one, all, run, transaction } = await import("../lib/db");
  for (const value of [one("SELECT 1 AS n"), all("SELECT 1 AS n"), run("DELETE FROM sessions WHERE token=?", "none"), transaction(async () => 1)])
    assert.ok(value instanceof Promise);
  assert.deepEqual(await one<{ n: number }>("SELECT 1 AS n"), { n: 1 });
});
