// #104: a change of some properties against an older version of the record
// still applies when exactly those properties are as the person saw them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { patchBase, patchStillApplies, sameCell } from "../lib/row-patch";
import type { Identity } from "../lib/types";

test("cells compare by value; empty values are alike", () => {
  assert.ok(sameCell(undefined, null));
  assert.ok(sameCell("", null));
  assert.ok(sameCell([], undefined));
  assert.ok(sameCell({ start: "2026-11-04", end: "2026-11-05" }, { end: "2026-11-05", start: "2026-11-04" }));
  assert.ok(sameCell(["a", "b"], ["a", "b"]));
  assert.ok(!sameCell(["a", "b"], ["b", "a"]));
  assert.ok(!sameCell("In Arbeit", "Erledigt"));
  assert.ok(!sameCell(0, null));
  assert.ok(!sameCell(false, null));
});

test("a patch applies when its properties are unchanged, not otherwise", () => {
  const stored = { title: "test", status: "In Arbeit" };
  // Saw the old title, changes the priority: the title is not touched.
  assert.ok(patchStillApplies(stored, { priority: null }, { priority: "Hoch" }));
  // Changes the status it saw as "In Arbeit".
  assert.ok(patchStillApplies(stored, { status: "In Arbeit" }, { status: "Erledigt" }));
  // Someone else set the status meanwhile.
  assert.ok(!patchStillApplies(stored, { status: null }, { status: "Erledigt" }));
  // No base, or none for a changed property: a conflict as before.
  assert.ok(!patchStillApplies(stored, undefined, { priority: "Hoch" }));
  assert.ok(!patchStillApplies(stored, {}, { priority: "Hoch" }));
  assert.ok(!patchStillApplies(stored, { priority: null }, { priority: "Hoch", status: "Erledigt" }));
  assert.ok(!patchStillApplies(stored, [], { priority: "Hoch" }));
  assert.ok(!patchStillApplies(stored, { priority: null }, {}));
});

test("the base holds the shown values of the changed properties", () => {
  assert.deepEqual(patchBase({ title: "a", status: "x" }, { status: "y", priority: "Hoch" }), { status: "x", priority: null });
  assert.deepEqual(patchBase(undefined, { status: "y" }), { status: null });
});

test("row.update: answers with the version, applies an untouched patch, refuses a real conflict", async () => {
  process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-row-patch-"));
  const { id, run } = await import("../lib/db");
  const { bootstrap, command, pageData } = await import("../lib/api");
  const { createWorkspace } = await import("../lib/seed");
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, "Alex", "alex@test.invalid");
  const owner: Identity = { id: uid, name: "Alex", email: "alex@test.invalid", groups: [], isAdmin: false, disabled: 0, created_at: "" };
  const wid = createWorkspace(owner.id, "Quick edits");
  const boot = bootstrap(owner, wid);
  const act = (body: Record<string, unknown>) => command(owner, body) as Record<string, unknown>;
  const pageId = act({ action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, title: "Aufgaben", kind: "database" }).id;
  const rowId = act({ action: "row.create", pageId, cells: { title: "Neue Aufgabe" } }).id;
  type Rows = { rows: { id: string; version: number; cells: Record<string, unknown> }[] };
  const row = () => (pageData(owner, pageId as string) as unknown as Rows).rows.find((r) => r.id === rowId)!;
  assert.equal(row().version, 1);

  // The title: the answer says the version after it.
  assert.deepEqual(act({ action: "row.update", pageId, rowId, version: 1, cells: { title: "test" }, base: { title: "Neue Aufgabe" } }), {
    ok: true,
    rowVersion: 2,
  });
  // The status, still on version 1: the title it did not touch changed.
  assert.equal(
    act({ action: "row.update", pageId, rowId, version: 1, cells: { status: "In Arbeit" }, base: { status: null } }).rowVersion,
    3,
  );
  assert.deepEqual([row().cells.title, row().cells.status, row().version], ["test", "In Arbeit", 3]);
  // Without a base an older version stays refused (API clients as before).
  assert.throws(() => act({ action: "row.update", pageId, rowId, version: 1, cells: { priority: "Hoch" } }), /Datensatz wurde geändert/);
  // The status changed since the person saw it: a real conflict.
  assert.throws(
    () => act({ action: "row.update", pageId, rowId, version: 2, cells: { status: "Erledigt" }, base: { status: null } }),
    /Datensatz wurde geändert/,
  );
  assert.equal(row().cells.status, "In Arbeit");
  // Other changes of the record answer with its version too.
  assert.equal(act({ action: "row.appearance", pageId, rowId, version: 3, icon: "Star" }).rowVersion, 4);
});
