// Audit (Nov 2026): record templates carried values of properties hidden
// from a person out of the database – row.template.save on someone's record
// stored every cell, and the workspace archive, page templates and page
// copies handed them back; row.create with a template wrote values into
// properties the person may not change; and template placeholders filled
// formulas derived from a hidden property.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-template-fields-"));
const { run, id, one, all } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const api = await import("../lib/api");
const { exportArchive } = await import("../lib/archive");
const { readExportZip } = await import("./helpers/read-export-zip");
const { replaceRowDocument, rowDocumentData } = await import("../lib/row-documents");

async function account(name: string) {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
type Result = { id: string } & Record<string, unknown>;
const owner = await account("Olga"),
  editor = await account("Eddi");
const wid = await createWorkspace(owner.id, "Firma");
await run("INSERT INTO members VALUES(?,?,?)", wid, editor.id, "editor");
const act = async (input: Record<string, unknown>, as = owner) => (await api.command(as, input)) as Result;
const team = (await act({ action: "space.create", workspaceId: wid, name: "Team" })).id;
const db = (await act({ action: "page.create", workspaceId: wid, spaceId: team, title: "Personal", kind: "database", databaseKind: "empty" })).id;
const d = await api.database(db);
const title = d.fields[0];
await act({
  action: "database.update",
  pageId: db,
  version: d.version,
  views: d.views,
  fields: [
    title,
    { id: "salary", name: "Gehalt", type: "number", access: { read: "owners", write: "owners" } },
    { id: "level", name: "Stufe", type: "text", access: { write: "owners" } },
    { id: "band", name: "Band", type: "formula", formula: 'prop("Gehalt")' },
  ],
});
const alice = (await act({ action: "row.create", pageId: db, cells: { [title.id]: "Alice", salary: 98765, level: "L7" } })).id;
const templateCells = async (tid: string) => JSON.parse((await one<{ cells: string }>("SELECT cells FROM row_templates WHERE id=?", tid))!.cells);
const cellsOf = async (rid: string) => JSON.parse((await one<{ cells: string }>("SELECT cells FROM rows WHERE id=?", rid))!.cells);

test("row.template.save keeps hidden and read-only values out of the template", async () => {
  const tid = (await act({ action: "row.template.save", pageId: db, rowId: alice, name: "Kopie" }, editor)).id;
  assert.deepEqual(await templateCells(tid), { [title.id]: "Alice" });
  // The owner's own template keeps what the owner may change.
  const own = (await act({ action: "row.template.save", pageId: db, rowId: alice, name: "Vorgabe" })).id;
  assert.deepEqual(await templateCells(own), { [title.id]: "Alice", salary: 98765, level: "L7" });
  // An editor replacing the owner's template keeps those values as they were.
  await act({ action: "row.template.save", pageId: db, rowId: alice, name: "Vorgabe", replaceId: own }, editor);
  assert.deepEqual(await templateCells(own), { [title.id]: "Alice", salary: 98765, level: "L7" });
});

test("archive, page templates and page copies leave hidden template values out", async () => {
  const zip = await exportArchive(editor, wid);
  const text = [...(await readExportZip(zip)).values()].map((b) => b.toString("utf8")).join("\n");
  assert.equal(text.includes("98765"), false);
  const tpl = (await act({ action: "template.save", pageId: db, name: "Personalvorlage" }, editor)).id;
  const payload = (await one<{ payload: string }>("SELECT payload FROM templates WHERE id=?", tpl))!.payload;
  assert.equal(payload.includes("98765"), false);
  const copy = (await act({ action: "page.duplicate", pageId: db }, editor)) as Result;
  const copyId = String(copy.id ?? copy.pageId ?? (copy as { ids?: string[] }).ids?.[0]);
  const copied = await all<{ cells: string }>("SELECT cells FROM row_templates WHERE page_id=?", copyId);
  assert.ok(copied.length > 0);
  assert.equal(copied.some((t) => t.cells.includes("98765")), false);
});

test("row.create with a template fills only properties the person may change", async () => {
  const own = (await one<{ id: string }>("SELECT id FROM row_templates WHERE page_id=? AND name='Vorgabe'", db))!.id;
  const byEditor = (await act({ action: "row.create", pageId: db, templateId: own }, editor)).id;
  assert.equal((await cellsOf(byEditor)).salary, undefined);
  assert.equal((await cellsOf(byEditor)).level, undefined);
  const byOwner = (await act({ action: "row.create", pageId: db, templateId: own })).id;
  assert.equal((await cellsOf(byOwner)).salary, 98765);
  assert.equal((await cellsOf(byOwner)).level, "L7");
});

test("placeholders of formulas derived from a hidden property stay empty", async () => {
  const mine = (await act({ action: "row.create", pageId: db, cells: { [title.id]: "Vorlage" } }, editor)).id;
  await replaceRowDocument(mine, "<p>Band: {{Band}} / direct: {{Gehalt}} / name: {{Name}}</p>", editor.id);
  const tid = (await act({ action: "row.template.save", pageId: db, rowId: mine, name: "Leak" }, editor)).id;
  await act({ action: "row.template.apply", pageId: db, rowId: alice, templateId: tid, mode: "append" }, editor);
  const html = ((await rowDocumentData(editor, db, alice)) as { html: string }).html;
  assert.equal(html.includes("98"), false, html);
  assert.match(html, /name: Alice/);
});
