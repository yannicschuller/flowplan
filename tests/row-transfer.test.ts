import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";

const dir = mkdtempSync(join(tmpdir(), "flowplan-transfer-"));
process.env.FLOWPLAN_DATA_DIR = dir;
const { id, run, one, all } = await import("../lib/db");
const { command, database, bootstrap, rows } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");

async function user(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@test.invalid`);
  return { id: uid, name, email: `${name}@test.invalid`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const owner = await user("owner");
const wid = await createWorkspace(owner.id, "Move"),
  boot = await bootstrap(owner, wid);
const act = async (body: Record<string, unknown>): Promise<any> => await command(owner, body);
const db = async (title: string, fields: unknown[]) => {
  const pageId = (await act({ action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, kind: "database", title })).id as string;
  await act({ action: "database.update", pageId, version: (await database(pageId)).version, fields, views: (await database(pageId)).views });
  return pageId;
};
const inbox = await db("Inbox", [
  { id: "title", name: "Title", type: "text" },
  { id: "status", name: "Status", type: "select", options: ["New", "Waiting"] },
  { id: "mail", name: "Contact", type: "email" },
  { id: "tags", name: "Tags", type: "multiselect", options: ["a", "b"] },
  { id: "est", name: "Estimate", type: "number" },
  { id: "doc", name: "Attachment", type: "files" },
]);
const project = await db("Project", [
  { id: "name", name: "Task", type: "text" },
  { id: "state", name: "Status", type: "select", options: ["New", "Done"] },
  { id: "contact", name: "Contact", type: "text" },
  { id: "tag", name: "Tags", type: "select", options: ["a"] },
  { id: "key", name: "ID", type: "id", prefix: "PRJ" },
]);
// A file belonging to the inbox.
const fileId = id();
mkdirSync(join(dir, "uploads"), { recursive: true });
writeFileSync(join(dir, "uploads", fileId), "pdf");
await run("INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)", fileId, inbox, "a.pdf", "application/pdf", 3, owner.id);
const a = (await act({ action: "row.create", pageId: inbox, cells: { title: "Call back", status: "Waiting", mail: "x@y.de", tags: ["b"], est: 2, doc: [`/api/files/${fileId}`] } })).id;
await act({ action: "comment.create", pageId: inbox, rowId: a, body: "Hello" });

test("copy: properties matched by name, choices and missing properties added, files duplicated", async () => {
  const result = await act({ action: "rows.transfer", pageId: inbox, rowIds: [a], targetPageId: project, mode: "copy" });
  assert.deepEqual(result.created.sort(), ["Attachment", "Estimate"]);
  const fields = (await database(project)).fields;
  const copy = (await rows(project)).find((r) => r.id === result.ids[0])!;
  assert.equal(copy.cells.name, "Call back");
  assert.equal(copy.cells.state, "Waiting");
  assert.ok(fields.find((f) => f.id === "state")!.options!.includes("Waiting"));
  assert.equal(copy.cells.contact, "x@y.de");
  assert.equal(copy.cells.tag, "b");
  const attachment = fields.find((f) => f.name === "Attachment")!;
  const url = (copy.cells[attachment.id] as string[])[0];
  assert.notEqual(url, `/api/files/${fileId}`);
  const copied = url.split("/").pop()!;
  assert.equal((await one<{ page_id: string }>("SELECT page_id FROM files WHERE id=?", copied))!.page_id, project);
  assert.ok(existsSync(join(dir, "uploads", copied)));
  // The original stays.
  assert.equal((await rows(inbox)).length, 1);
});

test("move: the record keeps its id, comments and files, and gets a new number", async () => {
  const result = await act({ action: "rows.transfer", pageId: inbox, rowIds: [a], targetPageId: project, mode: "move", addMissing: false });
  assert.deepEqual(result.ids, [a]);
  assert.equal((await rows(inbox)).length, 0);
  const moved = (await one<{ page_id: string; number: number }>("SELECT page_id,number FROM rows WHERE id=?", a))!;
  assert.equal(moved.page_id, project);
  assert.equal(moved.number, 2);
  assert.equal((await all("SELECT 1 FROM comments WHERE row_id=? AND page_id=?", a, project)).length, 1);
  assert.equal((await one<{ page_id: string }>("SELECT page_id FROM files WHERE id=?", fileId))!.page_id, project);
  await assert.rejects(async () => await act({ action: "rows.transfer", pageId: project, rowIds: [a], targetPageId: project, mode: "move" }), /andere Datenbank/);
});
