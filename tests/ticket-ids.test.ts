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
const { resolveTicket } = await import("../lib/ticket-refs");
const { computedCells } = await import("../lib/database");
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

test("prefixes are required and unique in the workspace", async () => {
  const other = await db("Other");
  await assert.rejects(async () => await withId(other), /Präfix/);
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
