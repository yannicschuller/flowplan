// The order of the properties on the record page (#305): one order per
// database (database.recordLayout → order), validated on the server, kept
// apart from the views' column order and followed by shared records and
// the export of a single record.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-record-order-"));
const { id, run, all } = await import("../lib/db");
const { command, database, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { orderRecordFields, cleanRecordOrder, moveRecordField } = await import("../lib/record-layout");
const { recordScope } = await import("../lib/record-share");
const { collectExportContent } = await import("../lib/export-content");
const { commandOverlay } = await import("../lib/optimistic-commands");

async function user(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@test.invalid`);
  return { id: uid, name, email: `${name}@test.invalid`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const me = await user("me"),
  reader = await user("reader");
const wid = await createWorkspace(me.id, "Order"),
  boot = await bootstrap(me, wid);
await run("INSERT INTO members VALUES(?,?,?)", wid, reader.id, "viewer");
const act = async (body: Record<string, unknown>): Promise<any> => await command(me, body);
const fields = [
  { id: "title", name: "Title", type: "text" },
  { id: "status", name: "Status", type: "select", options: ["Open", "Done"] },
  { id: "note", name: "Note", type: "text" },
  { id: "due", name: "Due", type: "date" },
];
const pageId = (await act({ action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, kind: "database", title: "Tasks" })).id as string;
await act({ action: "database.update", pageId, version: (await database(pageId)).version, fields, views: (await database(pageId)).views });
const layout = async () => (await database(pageId)).recordLayout!;

test("ordering keeps the title first, listed properties next and new ones at the end", () => {
  const ids = (order?: string[]) => orderRecordFields(fields, order).map((f) => f.id);
  assert.deepEqual(ids(), ["title", "status", "note", "due"]);
  assert.deepEqual(ids([]), ["title", "status", "note", "due"]);
  assert.deepEqual(ids(["due", "status"]), ["title", "due", "status", "note"]);
  // Unknown ids, duplicates and the title in the list change nothing.
  assert.deepEqual(ids(["gone", "note", "note", "title", "due"]), ["title", "note", "due", "status"]);
  assert.deepEqual(cleanRecordOrder(["gone", "note", "note", "title"], fields), ["note"]);
  assert.equal(cleanRecordOrder(["gone", "title"], fields), undefined);
  assert.deepEqual(moveRecordField(fields, undefined, "due", "status", "before"), ["due", "status", "note"]);
  assert.deepEqual(moveRecordField(fields, ["due", "status", "note"], "due", "note", "after"), ["status", "note", "due"]);
  assert.equal(moveRecordField(fields, undefined, "status", "note", "before"), null);
  assert.equal(moveRecordField(fields, undefined, "status", "gone", "before"), null);
  assert.equal(moveRecordField(fields, undefined, "title", "note", "after"), null);
});

test("the server keeps known properties once, bounds the list and leaves the views alone", async () => {
  const views = JSON.stringify((await database(pageId)).views);
  const saved = await act({
    action: "database.recordLayout",
    pageId,
    layout: { ...(await layout()), order: ["due", "gone", "due", "title", "note"] },
  });
  assert.deepEqual(saved.order, ["due", "note"]);
  assert.deepEqual((await layout()).order, ["due", "note"]);
  assert.deepEqual(orderRecordFields(fields, (await layout()).order).map((f) => f.id), ["title", "due", "note", "status"]);
  // The views' columns are not the record's order.
  assert.equal(JSON.stringify((await database(pageId)).views), views);
  assert.deepEqual((await database(pageId)).fields.map((f) => f.id), ["title", "status", "note", "due"]);
  // Too long, or not a list of ids: refused, the stored order stays.
  await assert.rejects(async () => await act({ action: "database.recordLayout", pageId, layout: { order: Array.from({ length: 501 }, (_, i) => `f${i}`) } }));
  await assert.rejects(async () => await act({ action: "database.recordLayout", pageId, layout: { order: "due" } }));
  await assert.rejects(async () => await act({ action: "database.recordLayout", pageId, layout: { order: [""] } }));
  assert.deepEqual((await layout()).order, ["due", "note"]);
  // An order of nothing known: none stored, the database's order again.
  const cleared = await act({ action: "database.recordLayout", pageId, layout: { ...(await layout()), order: ["gone"] } });
  assert.equal("order" in cleared, false);
  assert.equal((await layout()).order, undefined);
});

test("readers cannot change the order; the change is audited and kept in the versions", async () => {
  await act({ action: "database.recordLayout", pageId, layout: { ...(await layout()), order: ["note", "status"] } });
  await assert.rejects(
    async () => await command(reader, { action: "database.recordLayout", pageId, layout: { order: ["due"] } }),
    (e: { status?: number }) => e.status === 403,
  );
  assert.deepEqual((await layout()).order, ["note", "status"]);
  const audited = await all<{ action: string }>("SELECT action FROM audit WHERE action='database.recordLayout' AND resource_id=?", pageId);
  assert.ok(audited.length >= 1);
  // The first change after a quiet while keeps the previous order as a version.
  await run("DELETE FROM snapshots WHERE page_id=?", pageId);
  await run("UPDATE pages SET updated_at='2000-01-01 00:00:00' WHERE id=?", pageId);
  await run("UPDATE rows SET updated_at='2000-01-01 00:00:00' WHERE page_id=?", pageId);
  await act({ action: "database.recordLayout", pageId, layout: { ...(await layout()), order: ["due"] } });
  const snapshots = await all<{ html: string }>("SELECT html FROM snapshots WHERE page_id=?", pageId);
  assert.deepEqual(snapshots.map((s) => JSON.parse(s.html).database.recordLayout.order), [["note", "status"]]);
});

test("a shared record and the export of a single record list the properties in that order", async () => {
  await act({ action: "database.recordLayout", pageId, layout: { ...(await layout()), order: ["due", "note", "status"] } });
  const row = (await act({ action: "row.create", pageId, cells: { title: "Plan", status: "Open", note: "Hello", due: "2026-11-20" } })) as { id: string };
  const { token } = (await act({ action: "record.share.create", pageId, rowId: row.id, role: "viewer", name: "Link" })) as { token: string };
  const scope = (await recordScope(token))!;
  assert.equal(scope.titleField?.id, "title");
  assert.deepEqual(scope.shown.map((f) => f.id), ["due", "note", "status"]);
  const exported = await collectExportContent(me, { pageId, rowId: row.id, children: false, maxPages: 1, format: "PDF" });
  const html = exported.pages[0].html;
  const at = (text: string) => html.indexOf(`<td>${text}</td>`);
  assert.ok(at("Due") > 0 && at("Due") < at("Note") && at("Note") < at("Status"), html);
});

test("the optimistic layer shows the new order before the server answers", () => {
  const data = { page: { id: pageId }, database: { fields, views: [], version: 1, recordLayout: { open: "center", properties: "top", hideEmpty: false, hidden: [] } } } as any;
  const overlay = commandOverlay({ action: "database.recordLayout", pageId, layout: { ...data.database.recordLayout, order: ["note"] } }, { userId: me.id, userName: "me" });
  assert.deepEqual(overlay?.page?.(data).database?.recordLayout?.order, ["note"]);
});
