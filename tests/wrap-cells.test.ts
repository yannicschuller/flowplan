// "Zellen umbrechen" (#638): a table view's wrapCells setting – validated
// by the view schema, stored with the view through database.update, read
// back by everyone who sees the database and described in the API.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity, View } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-wrap-cells-"));
const { run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap, database, pageData } = await import("../lib/api");
const { view: viewSchema } = await import("../lib/database-schema");
const { openApiDocument } = await import("../lib/openapi");

async function user(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const owner = await user("owner"),
  viewer = await user("viewer"),
  wid = await createWorkspace(owner.id, "Wrap cells"),
  space = (await bootstrap(owner, wid)).spaces[0].id;
await run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
const base: View = { id: "v", name: "Table", type: "table", filters: [], sorts: [] };

test("the view schema accepts wrapCells as a boolean and refuses other values", () => {
  assert.equal(viewSchema.safeParse(base).success, true, "unset: one line, as before");
  for (const wrapCells of [true, false]) {
    const parsed = viewSchema.safeParse({ ...base, wrapCells });
    assert.equal(parsed.success, true);
    assert.equal(parsed.data?.wrapCells, wrapCells);
  }
  for (const wrapCells of ["yes", 1, null, {}])
    assert.equal(viewSchema.safeParse({ ...base, wrapCells }).success, false, String(wrapCells));
});

test("wrapCells is stored with the view, seen by everyone, and dropped when switched off", async () => {
  const pageId = ((await command(owner, { action: "page.create", workspaceId: wid, spaceId: space, title: "Notes", kind: "database" })) as { id: string }).id;
  const before = await database(pageId);
  const table = before.views.find((v) => v.type === "table")!;
  assert.equal(table.wrapCells, undefined, "off by default");
  const save = async (views: View[]) =>
    await command(owner, { action: "database.update", pageId, version: (await database(pageId)).version, fields: before.fields, views });
  await save(before.views.map((v) => (v.id === table.id ? { ...v, wrapCells: true } : v)));
  assert.equal((await database(pageId)).views.find((v) => v.id === table.id)?.wrapCells, true);
  // Other views keep their own setting.
  for (const v of (await database(pageId)).views.filter((v) => v.id !== table.id)) assert.equal(v.wrapCells, undefined, v.name);
  // A viewer sees the view as it was saved.
  const seen = (await pageData(viewer, pageId)) as { database: { views: View[] } };
  assert.equal(seen.database.views.find((v) => v.id === table.id)?.wrapCells, true);
  // A wrong value is refused and changes nothing.
  await assert.rejects(async () => await save((await database(pageId)).views.map((v) => (v.id === table.id ? { ...v, wrapCells: "yes" as never } : v))));
  assert.equal((await database(pageId)).views.find((v) => v.id === table.id)?.wrapCells, true);
  // Switched off, the interface leaves the field out.
  await save((await database(pageId)).views.map((v) => (v.id === table.id ? { ...v, wrapCells: undefined } : v)));
  assert.equal((await database(pageId)).views.find((v) => v.id === table.id)?.wrapCells, undefined);
});

test("the API document describes wrapCells on View", () => {
  const doc = openApiDocument() as { components: { schemas: { View: { properties: Record<string, { type?: string }> } } } };
  assert.equal(doc.components.schemas.View.properties.wrapCells?.type, "boolean");
});
