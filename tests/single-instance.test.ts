// Two instances against one PostgreSQL database without cluster mode
// (lib/cluster/single-instance.ts): the one without the lock warns – in the
// log and in Administration on every instance – keeps running, and the
// warning ends once it gets the lock. SQLite: not applicable.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { onPostgres } from "./helpers/backend";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-single-instance-"));
process.env.FLOWPLAN_INSTANCE_ID = "second-one";
const guard = await import("../lib/cluster/single-instance");
const { systemOverview } = await import("../lib/cluster/system");
const { postgresSessionUrl } = await import("../lib/db-driver/context");
const { closeSession } = await import("../lib/cluster/pg-session");
after(async () => {
  await closeSession();
});

test("SQLite, or cluster mode: no lock, no warning", { skip: onPostgres && "PostgreSQL" }, async () => {
  assert.equal(guard.singleInstanceGuarded(), false);
  assert.deepEqual(await guard.secondInstances(), []);
  assert.deepEqual((await systemOverview()).secondInstances, []);
  guard.startSingleInstanceGuard();
  assert.equal(guard.singleInstanceHeld(), false);
});

test("PostgreSQL without cluster mode: the second instance warns until the first one stops", { skip: !onPostgres && "needs PostgreSQL" }, async () => {
  assert.equal(guard.singleInstanceGuarded(), true);
  process.env.FLOWPLAN_CLUSTER = "1";
  assert.equal(guard.singleInstanceGuarded(), false, "cluster mode has its leader instead");
  delete process.env.FLOWPLAN_CLUSTER;
  // The first instance: another session holding the lock.
  const first = new pg.Client({ connectionString: postgresSessionUrl()! });
  await first.connect();
  try {
    await first.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [guard.singleInstanceLockKey()]);
    const errors: string[] = [];
    const error = console.error;
    console.error = (line: string) => void errors.push(String(line));
    let held: boolean;
    try {
      held = await guard.checkSingleInstance();
    } finally {
      console.error = error;
    }
    assert.equal(held, false);
    assert.match(errors.join("\n"), /ANOTHER FLOWPLAN INSTANCE IS RUNNING AGAINST THIS DATABASE WITHOUT CLUSTER MODE/);
    assert.match(errors.join("\n"), /FLOWPLAN_CLUSTER=1/);
    // Every instance sees it: the record is in the database.
    const seen = await guard.secondInstances();
    assert.equal(seen.length, 1);
    assert.equal(seen[0].instance, "second-one");
    assert.deepEqual((await systemOverview()).secondInstances.map((i) => i.instance), ["second-one"]);
    const since = seen[0].since;
    // Checked again: still waiting, the same start, logged only once.
    console.error = (line: string) => void errors.push(String(line));
    const before = errors.length;
    try {
      assert.equal(await guard.checkSingleInstance(), false);
    } finally {
      console.error = error;
    }
    assert.equal(errors.length, before, "not logged on every check");
    assert.equal((await guard.secondInstances())[0].since, since);
    // A record not renewed for two minutes is of an instance that is gone.
    assert.deepEqual(await guard.secondInstances(Date.now() + guard.SINGLE_INSTANCE_STALE_MS + 1000), []);
    // The first instance stops: the lock is taken, the warning ends.
    await first.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [guard.singleInstanceLockKey()]);
    const log = console.log;
    console.log = () => {};
    try {
      assert.equal(await guard.checkSingleInstance(), true);
    } finally {
      console.log = log;
    }
    assert.equal(guard.singleInstanceHeld(), true);
    assert.deepEqual(await guard.secondInstances(), []);
    // Now the other one cannot get it …
    assert.equal((await first.query("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS ok", [guard.singleInstanceLockKey()])).rows[0].ok ? 1 : 0, 0);
    // … until this one stops.
    await guard.releaseSingleInstance();
    assert.equal((await first.query("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS ok", [guard.singleInstanceLockKey()])).rows[0].ok ? 1 : 0, 1);
  } finally {
    await first.end();
  }
});
