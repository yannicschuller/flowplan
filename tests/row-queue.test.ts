// Quick edits of one record (#104): they run in order and the later one
// carries the version the earlier save produced.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRowChanges, createRowQueue, currentVersion, rowVersionKey } from "../lib/row-queue";

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
  assert.equal(await run("a", async () => "ok"), "ok");
});

test("the newer version of the record wins, never an older one", () => {
  assert.equal(currentVersion(3, 4), 4);
  assert.equal(currentVersion(3, 3), 3);
  assert.equal(currentVersion(3, 2), 3);
  assert.equal(currentVersion(3, undefined), 3);
});

test("the newest of several known versions wins", () => {
  assert.equal(currentVersion(3, 2, 5), 5);
  assert.equal(currentVersion(3, undefined, undefined), 3);
});

test("which property of a command holds the record's version", () => {
  assert.equal(rowVersionKey({ action: "row.update", rowId: "a", version: 1 }), "version");
  // row.move and row.schedule carry the database's version in `version`.
  assert.equal(rowVersionKey({ action: "row.move", rowId: "a", version: 9, rowVersion: 1 }), "rowVersion");
  assert.equal(rowVersionKey({ action: "row.schedule", rowId: "a", version: 9, rowVersion: 1 }), "rowVersion");
  assert.equal(rowVersionKey({ action: "row.move", rowId: "a", version: 9 }), null);
  assert.equal(rowVersionKey({ action: "comment.create", rowId: "a" }), null);
  assert.equal(rowVersionKey({ action: "row.update", version: 1 }), null);
});

// #104: the title is saved, the status follows at once – before the page
// was reloaded, or with a reload that answered late with the old record.
test("a change carries the version the server answered the previous one with", async () => {
  const changes = createRowChanges();
  const sent: Record<string, unknown>[] = [];
  let server = 1;
  const send = async (body: Record<string, unknown>) => {
    sent.push(body);
    await new Promise((r) => setTimeout(r, 5));
    if (body.version !== server) throw new Error("Datensatz wurde geändert.");
    return { ok: true, rowVersion: ++server };
  };
  // The shown data stays at version 1 the whole time.
  const shown = () => 1;
  const title = changes.run({ action: "row.update", rowId: "r", version: 1, cells: { title: "test" } }, shown, send);
  const status = changes.run({ action: "row.update", rowId: "r", version: 1, cells: { status: "In Arbeit" } }, shown, send);
  assert.deepEqual(await Promise.all([title, status]), [
    { ok: true, rowVersion: 2 },
    { ok: true, rowVersion: 3 },
  ]);
  // Later, with nothing waiting any more, still the answered version.
  await changes.run({ action: "row.update", rowId: "r", version: 1, cells: { priority: "Hoch" } }, shown, send);
  assert.deepEqual(
    sent.map((b) => b.version),
    [1, 2, 3],
  );
  assert.equal(changes.known("r"), 4);
});

test("row.move keeps the database's version and gets the record's", async () => {
  const changes = createRowChanges();
  const sent: Record<string, unknown>[] = [];
  const send = async (body: Record<string, unknown>) => {
    sent.push(body);
    return { ok: true, rowVersion: ((body.action === "row.move" ? body.rowVersion : body.version) as number) + 1 };
  };
  await changes.run({ action: "row.update", rowId: "r", version: 4, cells: {} }, () => 4, send);
  await changes.run({ action: "row.move", rowId: "r", version: 17, rowVersion: 4, viewId: "v" }, () => 4, send);
  assert.deepEqual(sent[1], { action: "row.move", rowId: "r", version: 17, rowVersion: 5, viewId: "v" });
});

test("the shown data wins once it caught up or moved on, not when it is older", async () => {
  const changes = createRowChanges();
  const sent: unknown[] = [];
  const send = async (body: Record<string, unknown>) => {
    sent.push(body.version);
    return { ok: true, rowVersion: (body.version as number) + 1 };
  };
  await changes.run({ action: "row.update", rowId: "r", version: 1, cells: {} }, () => 1, send);
  assert.equal(changes.known("r"), 2);
  // Someone else changed the record twice since: the reload shows 4.
  await changes.run({ action: "row.update", rowId: "r", version: 4, cells: {} }, () => 4, send);
  // A late reload shows the record as it was before: the answer wins.
  await changes.run({ action: "row.update", rowId: "r", version: 2, cells: {} }, () => 2, send);
  assert.deepEqual(sent, [1, 4, 5]);
});

// E.g. a restored version of the database took the record back.
test("after a refusal the next change starts from the shown data", async () => {
  const changes = createRowChanges();
  const sent: unknown[] = [];
  const send = async (body: Record<string, unknown>) => {
    sent.push(body.version);
    if (body.cells && (body.cells as { fail?: boolean }).fail) throw new Error("no");
    return { ok: true, rowVersion: 9 };
  };
  await changes.run({ action: "row.update", rowId: "r", version: 1, cells: {} }, () => 1, send);
  await assert.rejects(changes.run({ action: "row.update", rowId: "r", version: 1, cells: { fail: true } }, () => 1, send));
  assert.equal(changes.known("r"), undefined);
  await changes.run({ action: "row.update", rowId: "r", version: 1, cells: {} }, () => 1, send);
  assert.deepEqual(sent, [1, 9, 1]);
});

test("commands of other kinds pass unchanged and unqueued", async () => {
  const changes = createRowChanges();
  const body = { action: "comment.create", rowId: "r", body: "Hallo" };
  let got: unknown;
  await changes.run(body, () => 1, async (b) => (got = b));
  assert.equal(got, body);
});
