// Quick edits of one record (#104): they run in order and the later one
// carries the version the earlier save produced.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRowQueue, currentVersion } from "../lib/row-queue";

test("changes of one record run one after the other and know they follow", async () => {
  const run = createRowQueue();
  const log: string[] = [];
  const slow = run("a", async (fresh) => {
    log.push(`start1 ${fresh}`);
    await new Promise((r) => setTimeout(r, 20));
    log.push("end1");
    return 1;
  });
  const next = run("a", async (fresh) => {
    log.push(`start2 ${fresh}`);
    return 2;
  });
  const other = run("b", async (fresh) => {
    log.push(`other ${fresh}`);
    return 3;
  });
  assert.deepEqual(await Promise.all([slow, next, other]), [1, 2, 3]);
  assert.deepEqual(log, ["start1 false", "other false", "end1", "start2 true"]);
});

test("a failed change does not block the next one", async () => {
  const run = createRowQueue();
  const failed = run("a", async () => {
    throw new Error("no");
  });
  await assert.rejects(failed);
  assert.equal(await run("a", async (fresh) => fresh), true);
});

test("the newer version of the record wins, never an older one", () => {
  assert.equal(currentVersion(3, 4), 4);
  assert.equal(currentVersion(3, 3), 3);
  assert.equal(currentVersion(3, 2), 3);
  assert.equal(currentVersion(3, undefined), 3);
});
