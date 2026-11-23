// Where a record's sub-pages sit (#449): recordLayout.subpages, "bottom"
// (below the document, as before) or "top" (above it). Validated on the
// server and kept by everything that copies a database's layout: versions,
// duplicating, templates (also exported and imported), the workspace
// archive and the JSON backup; shared records follow it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-subpages-place-"));
const { id, run, one } = await import("../lib/db");
const { command, database, rows, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { recordLayoutSchema, parseRecordLayout, defaultRecordLayout, cleanRecordLayout } = await import("../lib/record-layout");
const { exportArchive, importArchive } = await import("../lib/archive");
const { exportTemplate, importTemplate } = await import("../lib/template-exchange");
const { recordSubPagesPlace } = await import("../lib/record-share");

async function user(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@test.invalid`);
  return { id: uid, name, email: `${name}@test.invalid`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const me = await user("me");
const wid = await createWorkspace(me.id, "Sub-pages"),
  boot = await bootstrap(me, wid);
const act = async (body: Record<string, unknown>): Promise<any> => await command(me, body);
const create = async (title: string, extra: Record<string, unknown> = {}) =>
  (await act({ action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, kind: "database", title, ...extra })).id as string;
const layout = async (pageId: string) => (await database(pageId)).recordLayout!;

test("the schema defaults to bottom, takes top and bottom and refuses anything else", () => {
  assert.equal(defaultRecordLayout.subpages, "bottom");
  assert.equal(recordLayoutSchema.parse({}).subpages, "bottom");
  // A layout stored before #449 reads as before.
  assert.equal(parseRecordLayout(JSON.stringify({ open: "side", properties: "side", hideEmpty: true, hidden: [] })).subpages, "bottom");
  assert.equal(recordLayoutSchema.parse({ subpages: "top" }).subpages, "top");
  assert.equal(recordLayoutSchema.parse({ subpages: "bottom" }).subpages, "bottom");
  for (const bad of ["side", "TOP", "", 1, null, true]) assert.equal(recordLayoutSchema.safeParse({ subpages: bad }).success, false, String(bad));
  // A broken stored value never breaks the record page.
  assert.equal(parseRecordLayout(JSON.stringify({ subpages: "middle" })).subpages, "bottom");
  // Round trip through JSON, and the cleaning keeps it.
  const top = recordLayoutSchema.parse({ subpages: "top", hidden: ["gone"] });
  assert.deepEqual(parseRecordLayout(JSON.stringify(top)), top);
  const cleaned = cleanRecordLayout(top, [{ id: "title" }]);
  assert.equal(cleaned.subpages, "top");
  assert.deepEqual(cleaned.hidden, []);
});

test("the server stores it, refuses unknown values and copies keep it", async () => {
  const pageId = await create("Projects");
  assert.equal((await layout(pageId)).subpages, "bottom");
  assert.equal(await recordSubPagesPlace(pageId), "bottom");
  const saved = await act({ action: "database.recordLayout", pageId, layout: { ...(await layout(pageId)), subpages: "top" } });
  assert.equal(saved.subpages, "top");
  assert.equal((await layout(pageId)).subpages, "top");
  // Shared and published records follow the database's layout.
  assert.equal(await recordSubPagesPlace(pageId), "top");
  await assert.rejects(async () => await act({ action: "database.recordLayout", pageId, layout: { ...(await layout(pageId)), subpages: "left" } }));
  assert.equal((await layout(pageId)).subpages, "top");
  // Other settings stay what they were when only this one changes.
  await act({ action: "database.recordLayout", pageId, layout: { ...(await layout(pageId)), open: "full", hideEmpty: true } });
  assert.deepEqual({ ...(await layout(pageId)) }, { ...defaultRecordLayout, open: "full", hideEmpty: true, subpages: "top" });
  await act({ action: "row.create", pageId, cells: { [(await database(pageId)).fields[0].id]: "Launch" } });

  // Duplicating the database.
  const copy = (await act({ action: "page.duplicate", pageId })).id as string;
  assert.equal((await layout(copy)).subpages, "top");

  // A version of the database brings it back.
  await act({ action: "page.snapshot", pageId });
  const version = (await one<{ id: string }>("SELECT id FROM snapshots WHERE page_id=? ORDER BY created_at DESC LIMIT 1", pageId))!.id;
  await act({ action: "database.recordLayout", pageId, layout: { ...(await layout(pageId)), subpages: "bottom" } });
  assert.equal((await layout(pageId)).subpages, "bottom");
  await act({ action: "snapshot.restore", pageId, snapshotId: version });
  assert.equal((await layout(pageId)).subpages, "top");

  // A saved template, used for a new database, and exported and imported.
  const templateName = `Projects ${id()}`;
  const template = (await act({ action: "template.save", pageId, name: templateName })).id as string;
  const fromTemplate = await create("From template", { templateId: template });
  assert.equal((await layout(fromTemplate)).subpages, "top");
  assert.equal((await layout(fromTemplate)).open, "full");
  const exported = await exportTemplate(me, wid, template);
  const imported = await importTemplate(me, wid, exported.zip, "private");
  const fromImported = await create("From imported template", { templateId: imported.id });
  assert.equal((await layout(fromImported)).subpages, "top");

  // The JSON backup (flowplan-1) and the workspace archive.
  const json = (await act({
    action: "workspace.import",
    workspaceId: wid,
    spaceId: boot.spaces[0].id,
    backup: {
      format: "flowplan-1",
      pages: [{ id: pageId, parent_id: null, title: "Backup copy", kind: "database", data: { database: await database(pageId), rows: await rows(pageId) } }],
    },
  })).pageIds[pageId] as string;
  assert.equal((await layout(json)).subpages, "top");
  const dest = await createWorkspace(me.id, "Restored");
  const restored = (await importArchive(me, dest, await exportArchive(me, wid))).pageIds[pageId];
  assert.equal((await layout(restored)).subpages, "top");
});

test("a template without a record layout keeps the database's", async () => {
  const pageId = await create("Plain");
  const template = (await act({ action: "template.save", pageId, name: `Plain ${id()}` })).id as string;
  // As saved before templates carried the layout.
  const stored = JSON.parse((await one<{ payload: string }>("SELECT payload FROM templates WHERE id=?", template))!.payload);
  delete stored.database.recordLayout;
  await run("UPDATE templates SET payload=? WHERE id=?", JSON.stringify(stored), template);
  const target = await create("Target");
  await act({ action: "database.recordLayout", pageId: target, layout: { ...(await layout(target)), subpages: "top" } });
  await act({ action: "template.apply", pageId: target, templateId: template, version: (await database(target)).version });
  assert.equal((await layout(target)).subpages, "top");
});
