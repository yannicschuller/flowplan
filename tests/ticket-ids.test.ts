import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Field, Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-ids-"));
const { id, run, one } = await import("../lib/db");
const { command, database, bootstrap, rows } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { resolveTicket, prefixes, readablePrefixes } = await import("../lib/ticket-refs");
const { computedCells, queryRows } = await import("../lib/database");
const { suggestedPrefix } = await import("../lib/ticket-ids");

async function user(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@test.invalid`);
  return { id: uid, name, email: `${name}@test.invalid`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const owner = await user("owner"),
  stranger = await user("stranger");
const wid = await createWorkspace(owner.id, "Tickets"),
  boot = await bootstrap(owner, wid);
const act = async (body: Record<string, unknown>): Promise<any> => await command(owner, body);
const db = async (title: string) => (await act({ action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, kind: "database", title })).id as string;
const withId = async (pageId: string, prefix?: string) => {
  const fields: Field[] = [...(await database(pageId)).fields.filter((f) => f.type !== "id"), { id: "key", name: "ID", type: "id", prefix }];
  return await act({ action: "database.update", pageId, version: (await database(pageId)).version, fields, views: (await database(pageId)).views });
};

test("records get running numbers, shown with the prefix", async () => {
  const web = await db("Website");
  const a = (await act({ action: "row.create", pageId: web, cells: { title: "A" } })).id;
  const b = (await act({ action: "row.create", pageId: web, cells: { title: "B" } })).id;
  await withId(web, "WEB");
  const fields = (await database(web)).fields;
  const shown = async (rid: string) => {
    const row = await one<any>("SELECT * FROM rows WHERE id=?", rid);
    return computedCells({ ...row, cells: JSON.parse(row.cells) }, fields).key;
  };
  assert.equal(await shown(a), "WEB-1");
  assert.equal(await shown(b), "WEB-2");
  // Deleted and restored: the same number again.
  await act({ action: "row.delete", pageId: web, rowId: b });
  const c = (await act({ action: "row.create", pageId: web, cells: { title: "C" } })).id;
  assert.equal(await shown(c), "WEB-3");
  const trash = await one<{ id: string }>("SELECT id FROM row_trash WHERE id=?", b);
  await act({ action: "row.trash.restore", pageId: web, trashId: trash!.id });
  assert.equal(await shown(b), "WEB-2");
  // The number cannot be edited.
  await assert.rejects(async () => await act({ action: "row.update", pageId: web, rowId: a, version: 1, cells: { key: "X" } }));
  // References resolve for readers only.
  const found = (await resolveTicket(owner, wid, "web-2"))!;
  assert.equal(found.rowId, b);
  assert.equal(found.title, "B");
  assert.equal(await resolveTicket(stranger, wid, "WEB-2"), null);
  assert.equal(await resolveTicket(owner, wid, "WEB-99"), null);
});

test("prefixes are unique in the workspace", async () => {
  const other = await db("Other");
  await assert.rejects(async () => await withId(other, "WEB"), /WEB nutzt schon/);
  await withId(other, "OPS");
  assert.equal(suggestedPrefix("Website Relaunch"), "WR");
  assert.equal(suggestedPrefix("Marketing"), "MARK");
});

test("a copied or restored database gets a free prefix; the original stays editable", async () => {
  const prefixOf = async (pageId: string) => (await database(pageId)).fields.find((f) => f.type === "id")!.prefix;
  const app = await db("App");
  await withId(app, "APP");
  const copy = (await act({ action: "page.duplicate", pageId: app })).id as string;
  assert.equal(await prefixOf(copy), "APP2");
  const again = (await act({ action: "page.duplicate", pageId: app })).id as string;
  assert.equal(await prefixOf(again), "APP3");
  // Schema edits on the original still work.
  const d = await database(app);
  await act({ action: "database.update", pageId: app, version: d.version, fields: d.fields.map((f) => (f.type === "id" ? { ...f, name: "Nummer" } : f)), views: d.views });
  assert.equal((await resolveTicket(owner, wid, "APP2-1")), null);
  // Trashed, its prefix taken meanwhile, restored: a new one.
  const old = await db("Old");
  await withId(old, "OLD");
  await act({ action: "page.delete", pageId: old });
  const newer = await db("Newer");
  await withId(newer, "OLD");
  await act({ action: "page.restore", pageId: old });
  assert.equal(await prefixOf(old), "OLD2");
  assert.equal(await prefixOf(newer), "OLD");
  // Two databases that already share a prefix (older data) stay editable.
  const shared = (await database(old)).fields.map((f) => (f.type === "id" ? { ...f, prefix: "OLD" } : f));
  await run("UPDATE databases SET fields=? WHERE page_id=?", JSON.stringify(shared), old);
  const o = await database(old);
  await act({ action: "database.update", pageId: old, version: o.version, fields: o.fields.map((f) => (f.type === "id" ? { ...f, name: "Nr." } : f)), views: o.views });
  await assert.rejects(async () => await withId(app, "OLD"), /OLD nutzt schon/);
});

test("a database created from a template of a ticket database gets a free prefix", async () => {
  const bugs = await db("Bugs");
  await withId(bugs, "BUG");
  const template = (await act({ action: "template.save", pageId: bugs, name: "Bug-Tracker", spaceId: null })).id as string;
  const made = (await act({ action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, kind: "database", title: "Bugs 2", templateId: template })).id as string;
  assert.equal((await database(made)).fields.find((f) => f.type === "id")!.prefix, "BUG2");
});

test("an ID without a prefix counts up and is left out of references (#313)", async () => {
  const plain = await db("Plain");
  const a = (await act({ action: "row.create", pageId: plain, cells: { title: "A" } })).id;
  await withId(plain);
  const b = (await act({ action: "row.create", pageId: plain, cells: { title: "B" } })).id;
  const c = (await act({ action: "row.create", pageId: plain, cells: { title: "C" } })).id;
  const shown = async () => {
    const fields = (await database(plain)).fields;
    return await Promise.all([a, b, c].map(async (rid) => {
      const row = await one<any>("SELECT * FROM rows WHERE id=?", rid);
      return computedCells({ ...row, cells: JSON.parse(row.cells) }, fields).key;
    }));
  };
  assert.deepEqual(await shown(), ["1", "2", "3"]);
  assert.equal((await database(plain)).fields.find((f) => f.type === "id")!.prefix, undefined);
  // Still one ID property per database.
  const d = await database(plain);
  await assert.rejects(
    async () => await act({ action: "database.update", pageId: plain, version: d.version, fields: [...d.fields, { id: "key2", name: "ID 2", type: "id" }], views: d.views }),
    /höchstens eine ID/,
  );
  // Sorting by the ID goes by number (10 after 9), searching finds "3".
  for (let i = 0; i < 7; i++) await act({ action: "row.create", pageId: plain, cells: { title: "Weitere" } });
  const all = await rows(plain),
    view = { ...d.views[0], filters: [], sorts: [{ field: "key", direction: "desc" as const }] };
  assert.deepEqual(queryRows(all, d.fields, view).slice(0, 3).map((r) => r.cells.key), ["10", "9", "8"]);
  assert.deepEqual(queryRows(all, d.fields, view, "3").map((r) => r.id), [c]);
  // No prefix: nothing to list or resolve, a second plain database is fine.
  assert.ok(!(await prefixes(wid)).some((p) => p.pageId === plain));
  assert.ok(!(await readablePrefixes(owner, wid)).some((p) => p.pageId === plain));
  const second = await db("Plain 2");
  await withId(second);
  // A copy does not get a prefix claimed.
  const copy = (await act({ action: "page.duplicate", pageId: plain })).id as string;
  assert.equal((await database(copy)).fields.find((f) => f.type === "id")!.prefix, undefined);
  // Setting a prefix later keeps the numbers; clearing it again too.
  await withId(plain, "PLN");
  assert.deepEqual(await shown(), ["PLN-1", "PLN-2", "PLN-3"]);
  assert.equal((await resolveTicket(owner, wid, "PLN-2"))!.rowId, b);
  await withId(plain);
  assert.deepEqual(await shown(), ["1", "2", "3"]);
  assert.equal(await resolveTicket(owner, wid, "PLN-2"), null);
});

test("the title cannot become an ID or another computed property (#463)", async () => {
  const pageId = (await act({ action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, kind: "database", title: "Leer 463", databaseKind: "empty" })).id as string;
  const d = await database(pageId);
  const update = async (fields: Field[]) => act({ action: "database.update", pageId, version: (await database(pageId)).version, fields, views: d.views });
  const refused = /Die erste Eigenschaft ist der Titel/;
  // The title's type changed to an ID or "Erstellt am": refused (a formula
  // title is allowed: a title derived from other properties).
  for (const type of ["id", "created_at"] as const)
    await assert.rejects(update([{ ...d.fields[0], type, ...(type === "id" ? { prefix: "TTL" } : {}) }]), refused);
  // A computed property moved to the front, or the title deleted before one.
  const ticket: Field = { id: "nr", name: "Nr.", type: "id", prefix: "TTM" };
  await assert.rejects(update([ticket, d.fields[0]]), refused);
  await assert.rejects(update([ticket]), refused);
  // An ID and a checkbox beside the title are fine; the title stays a text
  // one can type (the steps of #463).
  await update([d.fields[0], ticket, { id: "done", name: "Erledigt", type: "checkbox" }]);
  const rid = (await act({ action: "row.create", pageId, cells: { title: "Neuer Eintrag" } })).id;
  const row = await one<{ version: number }>("SELECT version FROM rows WHERE id=?", rid);
  await act({ action: "row.update", pageId, rowId: rid, version: row!.version, cells: { title: "12345" } });
  const saved = (await rows(pageId)).find((r) => r.id === rid)!;
  assert.equal(saved.cells.title, "12345");
  // A title that already is an ID (saved before #463) may stay one, and can
  // become a text again.
  await run("UPDATE databases SET fields=? WHERE page_id=?", JSON.stringify([{ ...d.fields[0], type: "id", prefix: "TTN" }]), pageId);
  const legacy = (await database(pageId)).fields;
  await update([{ ...legacy[0], name: "Nummer" }]);
  await update([{ ...legacy[0], type: "text" }]);
  assert.equal((await database(pageId)).fields[0].type, "text");
});
