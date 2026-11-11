import { nowText } from "../lib/db-driver/dialect";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity, Page } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-trash-"));
const { one, all, run, id } = await import("../lib/db");
const { command, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { processSearchIndex } = await import("../lib/search-index");
const { expireTrash, trashCounts, trashDays } = await import("../lib/trash");
const { saveInstanceSettings } = await import("../lib/instance-settings");
const { listRowTrash } = await import("../lib/row-trash");

async function user(name: string, isAdmin = false): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}-${uid}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, disabled: 0, created_at: "", groups: [], isAdmin };
}
async function fixture() {
  const owner = await user("Owner"),
    editor = await user("Editor"),
    viewer = await user("Viewer"),
    stranger = await user("Stranger"),
    wid = await createWorkspace(owner.id, "Trash");
  await run("INSERT INTO members VALUES(?,?,?)", wid, editor.id, "editor");
  await run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
  const sid = (await one<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=?", wid))!.id;
  const page = async (title = "Page", parentId?: string, kind = "document", actor = owner, spaceId = sid) =>
    ((await command(actor, { action: "page.create", workspaceId: wid, spaceId, title, kind, parentId })) as { id: string }).id;
  return { owner, editor, viewer, stranger, wid, sid, page };
}
async function file(pageId: string, actor: Identity) {
  const fid = id(),
    dir = join(process.env.FLOWPLAN_DATA_DIR!, "uploads"),
    path = join(dir, fid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, "bytes " + fid);
  await run("INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)", fid, pageId, "a.txt", "text/plain", 10, actor.id);
  return { fid, path };
}
const exists = async (pageId: string) => !!(await one("SELECT 1 FROM pages WHERE id=?", pageId));
const count = async (sql: string, ...params: string[]) => (await all(sql, ...params)).length;

test("page.purge deletes the trashed page with its sub-pages and everything hanging on them, nothing else", async () => {
  const f = await fixture();
  const root = await f.page("Root"),
    child = await f.page("Child", root),
    table = await f.page("Table", child, "database"),
    keep = await f.page("Keep");
  await run("UPDATE documents SET html=? WHERE page_id=?", "<p>Hello purge</p>", root);
  await command(f.owner, { action: "page.snapshot", pageId: root });
  await command(f.owner, { action: "comment.create", pageId: root, body: "A comment" });
  await command(f.owner, { action: "favorite", pageId: child, value: true });
  const row = (await command(f.owner, { action: "row.create", pageId: table, cells: { title: "Record" } })) as { id: string };
  await command(f.owner, { action: "comment.create", pageId: table, rowId: row.id, body: "On the record" });
  await command(f.owner, { action: "share.create", pageId: keep, name: "Keep link", role: "viewer" });
  const gone = await file(child, f.owner),
    kept = await file(keep, f.owner);
  await run("INSERT INTO notifications(id,user_id,page_id,body) VALUES(?,?,?,?)", id(), f.editor.id, root, "Hi");
  await run("INSERT INTO task_reminders(user_id,page_id,text,due) VALUES(?,?,?,?)", f.owner.id, root, "x", "2026-01-01");
  await run("INSERT INTO grants(resource_id,user_id,group_id,role) VALUES(?,?,?,?)", child, f.viewer.id, "", "viewer");
  await processSearchIndex(10_000);
  assert.ok((await count("SELECT * FROM search_index WHERE page_id=?", root)) > 0);

  // Only from the trash.
  await assert.rejects(async () => await command(f.owner, { action: "page.purge", pageId: root }), { status: 409 });
  await command(f.owner, { action: "page.delete", pageId: root });
  const result = (await command(f.owner, { action: "page.purge", pageId: root })) as { pages: number };
  assert.equal(result.pages, 3);
  for (const pid of [root, child, table]) assert.equal(await exists(pid), false);
  for (const [table_, column] of [
    ["documents", "page_id"],
    ["snapshots", "page_id"],
    ["comments", "page_id"],
    ["favorites", "page_id"],
    ["databases", "page_id"],
    ["rows", "page_id"],
    ["notifications", "page_id"],
    ["task_reminders", "page_id"],
    ["search_index", "page_id"],
    ["grants", "resource_id"],
  ])
    for (const pid of [root, child, table])
      assert.equal(await count(`SELECT * FROM ${table_} WHERE ${column}=?`, pid), 0, `${table_} of ${pid}`);
  assert.equal(await one("SELECT 1 FROM rows WHERE id=?", row.id), undefined);
  assert.equal(await one("SELECT 1 FROM files WHERE id=?", gone.fid), undefined);
  assert.equal(existsSync(gone.path), false);
  // Other content stays: the file of another page, its share link.
  assert.ok(await exists(keep));
  assert.ok(await one("SELECT 1 FROM files WHERE id=?", kept.fid));
  assert.ok(existsSync(kept.path));
  assert.ok(await one("SELECT 1 FROM share_links WHERE root_id=?", keep));
  // Logged.
  assert.ok(await one("SELECT 1 FROM audit WHERE action='page.purged' AND resource_id=? AND detail='3 pages'", root));
});

test("only who may delete the page purges it; restore works until then", async () => {
  const f = await fixture();
  const root = await f.page("Root"),
    child = await f.page("Child", root);
  await command(f.owner, { action: "page.delete", pageId: root });
  await assert.rejects(async () => await command(f.viewer, { action: "page.purge", pageId: root }), { status: 403 });
  await assert.rejects(async () => await command(f.stranger, { action: "page.purge", pageId: root }), { status: 404 });
  // Read-only API token.
  await assert.rejects(async () => await command({ ...f.owner, apiScope: "read" } as Identity, { action: "page.purge", pageId: root }), { status: 403 });
  await command(f.owner, { action: "page.restore", pageId: root });
  assert.equal((await one<Page>("SELECT * FROM pages WHERE id=?", child))!.deleted_at, null);
  // Private space of the owner: the editor sees nothing of it.
  const priv = ((await command(f.owner, { action: "space.create", workspaceId: f.wid, name: "Mine", private: true })) as { id: string }).id;
  const secret = await f.page("Secret", undefined, "document", f.owner, priv);
  await command(f.owner, { action: "page.delete", pageId: secret });
  await assert.rejects(async () => await command(f.editor, { action: "page.purge", pageId: secret }), { status: 404 });
  assert.ok(await exists(secret));
  // Editors may delete what they may edit.
  await command(f.owner, { action: "page.delete", pageId: root });
  await command(f.editor, { action: "page.purge", pageId: root });
  assert.equal(await exists(root), false);
  assert.equal(await exists(child), false);
});

test("a sub-page someone may not edit stays in the trash on its own", async () => {
  const f = await fixture();
  const root = await f.page("Root"),
    child = await f.page("Child", root);
  // The editor may edit the root (a grant), but not the child (viewer grant).
  await run("INSERT INTO grants(resource_id,user_id,group_id,role) VALUES(?,?,?,?)", child, f.editor.id, "", "viewer");
  await command(f.owner, { action: "page.delete", pageId: root });
  await command(f.editor, { action: "page.purge", pageId: root });
  assert.equal(await exists(root), false);
  const rest = (await one<Page>("SELECT * FROM pages WHERE id=?", child))!;
  assert.ok(rest.deleted_at);
  assert.equal(rest.parent_id, null);
});

test("trash.empty deletes only what this person may delete, records included", async () => {
  const f = await fixture();
  const mine = await f.page("Mine"),
    readOnly = await f.page("Read only"),
    table = await f.page("Table", undefined, "database");
  await run("INSERT INTO grants(resource_id,user_id,group_id,role) VALUES(?,?,?,?)", readOnly, f.editor.id, "", "viewer");
  const priv = ((await command(f.owner, { action: "space.create", workspaceId: f.wid, name: "Mine", private: true })) as { id: string }).id;
  const secret = await f.page("Secret", undefined, "document", f.owner, priv);
  const row = (await command(f.owner, { action: "row.create", pageId: table, cells: { title: "Gone" } })) as { id: string };
  await command(f.owner, { action: "row.delete", pageId: table, rowId: row.id });
  for (const pid of [mine, readOnly, secret]) await command(f.owner, { action: "page.delete", pageId: pid });
  // A space of the editor in the trash, and one of the owner.
  const editorSpace = ((await command(f.editor, { action: "space.create", workspaceId: f.wid, name: "Editor area" })) as { id: string }).id;
  const ownerSpace = ((await command(f.owner, { action: "space.create", workspaceId: f.wid, name: "Owner area" })) as { id: string }).id;
  for (const [actor, sid, name] of [[f.editor, editorSpace, "Editor area"], [f.owner, ownerSpace, "Owner area"]] as const)
    await command(actor, { action: "space.delete", spaceId: sid, version: (await one<{ version: number }>("SELECT version FROM spaces WHERE id=?", sid))!.version, confirmName: name });

  assert.deepEqual(await trashCounts(f.editor, f.wid), { pages: 1, spaces: 1, records: 1, files: 0 });
  await assert.rejects(async () => await command(f.viewer, { action: "trash.empty", workspaceId: f.wid }), { status: 403 });
  const result = (await command(f.editor, { action: "trash.empty", workspaceId: f.wid })) as Record<string, number>;
  assert.deepEqual({ pages: result.pages, spaces: result.spaces, records: result.records }, { pages: 1, spaces: 1, records: 1 });
  assert.equal(await exists(mine), false);
  assert.ok(await exists(readOnly));
  assert.ok(await exists(secret));
  assert.equal(await one("SELECT 1 FROM spaces WHERE id=?", editorSpace), undefined);
  assert.ok(await one("SELECT 1 FROM spaces WHERE id=?", ownerSpace));
  assert.deepEqual(await listRowTrash(f.owner, f.wid), []);
  // The owner empties the rest.
  await command(f.owner, { action: "trash.empty", workspaceId: f.wid });
  assert.equal(await exists(readOnly), false);
  assert.equal(await exists(secret), false);
  assert.equal(await one("SELECT 1 FROM spaces WHERE id=?", ownerSpace), undefined);
  assert.ok(await exists(table));
  assert.equal((await bootstrap(f.owner, f.wid)).trashDays, 30);
});

test("the trash is emptied automatically after the set days; 0 keeps everything", async () => {
  const f = await fixture();
  const old = await f.page("Old"),
    oldChild = await f.page("Old child", old),
    recent = await f.page("Recent"),
    table = await f.page("Table", undefined, "database");
  const row = (await command(f.owner, { action: "row.create", pageId: table, cells: { title: "Old record" } })) as { id: string };
  await command(f.owner, { action: "row.delete", pageId: table, rowId: row.id });
  for (const pid of [old, recent]) await command(f.owner, { action: "page.delete", pageId: pid });
  const area = ((await command(f.owner, { action: "space.create", workspaceId: f.wid, name: "Old area" })) as { id: string }).id;
  const inArea = await f.page("In area", undefined, "document", f.owner, area);
  await command(f.owner, { action: "space.delete", spaceId: area, version: (await one<{ version: number }>("SELECT version FROM spaces WHERE id=?", area))!.version, confirmName: "Old area" });
  await run("UPDATE pages SET deleted_at=? WHERE id IN (?,?,?)", nowText(Date.now() - 3_456_000_000), old, oldChild, inArea);
  await run("UPDATE pages SET deleted_at=? WHERE id=?", nowText(Date.now() - 864_000_000), recent);
  await run("UPDATE spaces SET deleted_at=? WHERE id=?", nowText(Date.now() - 3_456_000_000), area);
  await run("UPDATE row_trash SET deleted_at=? WHERE id=?", nowText(Date.now() - 3_456_000_000), row.id);

  await saveInstanceSettings({ trashDays: 0 });
  assert.equal(await trashDays(), 0);
  assert.deepEqual(await expireTrash(), { pages: 0, spaces: 0, records: 0, templates: 0, files: 0 });
  assert.ok(await exists(old));

  await saveInstanceSettings({ trashDays: 30 });
  const result = await expireTrash();
  assert.ok(result.pages >= 2 && result.spaces >= 1 && result.records >= 1);
  for (const pid of [old, oldChild, inArea]) assert.equal(await exists(pid), false);
  assert.equal(await one("SELECT 1 FROM spaces WHERE id=?", area), undefined);
  assert.equal(await one("SELECT 1 FROM row_trash WHERE id=?", row.id), undefined);
  // Not yet due: still restorable.
  assert.ok(await exists(recent));
  await command(f.owner, { action: "page.restore", pageId: recent });
  assert.equal((await one<Page>("SELECT * FROM pages WHERE id=?", recent))!.deleted_at, null);
  await assert.rejects(async () => await saveInstanceSettings({ trashDays: 4000 }));
});

test("templates: deleted for good one by one, by emptying the template trash, and after the trash period", async () => {
  const f = await fixture();
  const source = await f.page("Source");
  const save = async (actor: Identity, name: string, visibility = "workspace") => {
    const tid = ((await command(actor, { action: "template.save", pageId: source, name })) as { id: string }).id;
    if (visibility !== "workspace") await run("UPDATE templates SET visibility=? WHERE id=?", visibility, tid);
    return tid;
  };
  const trash = async (actor: Identity, tid: string) =>
    await command(actor, { action: "template.delete", workspaceId: f.wid, templateId: tid, version: (await one<{ version: number }>("SELECT version FROM templates WHERE id=?", tid))!.version });
  const a = await save(f.editor, "A"),
    b = await save(f.owner, "B"),
    c = await save(f.editor, "C"),
    hidden = await save(f.owner, "Hidden", "private"),
    old = await save(f.editor, "Old");
  await run("INSERT INTO template_files(id,template_id,original_id,name,mime,data) VALUES(?,?,?,?,?,?)", id(), a, id(), "x", "text/plain", Buffer.from("x"));
  // Not in the trash yet.
  await assert.rejects(async () => await command(f.editor, { action: "template.purge", workspaceId: f.wid, templateId: a }), { status: 409 });
  for (const [actor, tid] of [[f.editor, a], [f.owner, b], [f.editor, c], [f.owner, hidden], [f.editor, old]] as const) await trash(actor, tid);
  // Someone else's template: only its creator or an owner.
  await assert.rejects(async () => await command(f.editor, { action: "template.purge", workspaceId: f.wid, templateId: b }), { status: 403 });
  await assert.rejects(async () => await command(f.editor, { action: "template.purge", workspaceId: f.wid, templateId: hidden }), { status: 404 });
  await command(f.editor, { action: "template.purge", workspaceId: f.wid, templateId: a });
  assert.equal(await one("SELECT 1 FROM templates WHERE id=?", a), undefined);
  assert.equal(await count("SELECT * FROM template_files WHERE template_id=?", a), 0);
  // Emptying the template trash as the editor: only their own.
  await run("UPDATE templates SET deleted_at=? WHERE id=?", nowText(Date.now() - 86_400_000), old);
  const emptied = (await command(f.editor, { action: "trash.empty", workspaceId: f.wid, scope: "templates" })) as { templates: number };
  assert.equal(emptied.templates, 2);
  assert.equal(await one("SELECT 1 FROM templates WHERE id=?", c), undefined);
  assert.ok(await one("SELECT 1 FROM templates WHERE id=?", b));
  assert.ok(await one("SELECT 1 FROM templates WHERE id=?", hidden));
  // After the trash period.
  await run("UPDATE templates SET deleted_at=? WHERE id=?", nowText(Date.now() - 2_678_400_000), b);
  await expireTrash(30);
  assert.equal(await one("SELECT 1 FROM templates WHERE id=?", b), undefined);
  assert.ok(await one("SELECT 1 FROM templates WHERE id=?", hidden));
});

test("a sub-page trashed before its parent keeps its date and stays in the trash when the parent is restored", async () => {
  const f = await fixture();
  const parent = await f.page("Parent"),
    early = await f.page("Early", parent),
    along = await f.page("Along", parent);
  await command(f.owner, { action: "page.delete", pageId: early });
  const earlier = nowText(Date.now() - 3_600_000);
  await run("UPDATE pages SET deleted_at=? WHERE id=?", earlier, early);
  await command(f.owner, { action: "page.delete", pageId: parent });
  const deletedAt = async (pageId: string) => (await one<Page>("SELECT * FROM pages WHERE id=?", pageId))!.deleted_at;
  assert.equal(await deletedAt(early), earlier);
  assert.ok(await deletedAt(along));
  await command(f.owner, { action: "page.restore", pageId: parent });
  assert.equal(await deletedAt(parent), null);
  assert.equal(await deletedAt(along), null);
  assert.equal(await deletedAt(early), earlier);
});
