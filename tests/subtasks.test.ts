import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Field, Identity, Row } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-subtasks-"));
const { id, run, one } = await import("../lib/db");
const { command, database, bootstrap, rows } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { computedCells } = await import("../lib/database");
const { treeOrder } = await import("../lib/subtasks");

async function user(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@test.invalid`);
  return { id: uid, name, email: `${name}@test.invalid`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const owner = await user("owner");
const wid = await createWorkspace(owner.id, "Tree"),
  boot = await bootstrap(owner, wid);
const act = async (body: Record<string, unknown>): Promise<any> => await command(owner, body);
const pageId = (await act({ action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, kind: "database", title: "Plan" })).id as string;
const fields: Field[] = [
  { id: "title", name: "Title", type: "text" },
  { id: "status", name: "Status", type: "select", options: ["Open", "Done"] },
  { id: "parent", name: "Parent", type: "relation", parent: true, relationPage: "ignored" },
  { id: "progress", name: "Progress", type: "progress" },
];
await act({ action: "database.update", pageId, version: (await database(pageId)).version, fields, views: (await database(pageId)).views });
const create = async (title: string, parent?: string, status = "Open") =>
  (await act({ action: "row.create", pageId, cells: { title, status, ...(parent ? { parent: [parent] } : {}) } })).id as string;
const version = async (rid: string) => (await one<{ version: number }>("SELECT version FROM rows WHERE id=?", rid))!.version;

test("the parent relation points to the own database; progress gets the done rule", async () => {
  const stored = (await database(pageId)).fields;
  assert.equal(stored.find((f) => f.id === "parent")!.relationPage, pageId);
  const progress = stored.find((f) => f.id === "progress")!;
  assert.equal(progress.parentField, "parent");
  assert.deepEqual([progress.doneField, progress.doneValues], ["status", ["Done"]]);
});

test("progress rolls up through levels; loops are refused", async () => {
  const epic = await create("Epic");
  const story = await create("Story", epic);
  await create("Task 1", story, "Done");
  await create("Task 2", story);
  await create("Story 2", epic, "Done");
  const all = await rows(pageId);
  const related = { [pageId]: all };
  const progress = async (rid: string) => computedCells(all.find((r) => r.id === rid)!, (await database(pageId)).fields, related).progress;
  assert.equal(await progress(story), 0.5);
  assert.equal(await progress(epic), 0.75);
  await assert.rejects(
    async () => await act({ action: "row.update", pageId, rowId: epic, version: await version(epic), cells: { parent: [story] } }),
    /nicht unter sich selbst/,
  );
  await assert.rejects(async () => await act({ action: "row.update", pageId, rowId: epic, version: await version(epic), cells: { parent: [story, epic] } }), /höchstens einen/);
  const tree = treeOrder(all, (await database(pageId)).fields.find((f) => f.id === "parent")!);
  assert.deepEqual(
    tree.map((x) => [x.row.cells.title, x.depth]),
    [["Epic", 0], ["Story", 1], ["Task 1", 2], ["Task 2", 2], ["Story 2", 1]],
  );
  const folded = treeOrder(all, (await database(pageId)).fields.find((f) => f.id === "parent")!, new Set([epic]));
  assert.deepEqual(folded.map((x) => x.row.cells.title), ["Epic"]);
});

test("the done rule set later reaches the progress property", async () => {
  await act({ action: "database.settings", pageId, settings: { done: { field: "status", values: ["Open"] } } });
  assert.deepEqual((await database(pageId)).fields.find((f) => f.id === "progress")!.doneValues, ["Open"]);
  void ({} as Row);
});
