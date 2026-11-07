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
