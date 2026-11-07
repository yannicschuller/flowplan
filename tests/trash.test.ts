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

function user(name: string, isAdmin = false): Identity {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}-${uid}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, disabled: 0, created_at: "", groups: [], isAdmin };
}
function fixture() {
  const owner = user("Owner"),
    editor = user("Editor"),
    viewer = user("Viewer"),
    stranger = user("Stranger"),
    wid = createWorkspace(owner.id, "Trash");
  run("INSERT INTO members VALUES(?,?,?)", wid, editor.id, "editor");
  run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
  const sid = one<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=?", wid)!.id;
  const page = (title = "Page", parentId?: string, kind = "document", actor = owner, spaceId = sid) =>
    (command(actor, { action: "page.create", workspaceId: wid, spaceId, title, kind, parentId }) as { id: string }).id;
  return { owner, editor, viewer, stranger, wid, sid, page };
}
function file(pageId: string, actor: Identity) {
  const fid = id(),
    dir = join(process.env.FLOWPLAN_DATA_DIR!, "uploads"),
    path = join(dir, fid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, "bytes " + fid);
  run("INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)", fid, pageId, "a.txt", "text/plain", 10, actor.id);
  return { fid, path };
}
const exists = (pageId: string) => !!one("SELECT 1 FROM pages WHERE id=?", pageId);
const count = (sql: string, ...params: string[]) => all(sql, ...params).length;

test("page.purge deletes the trashed page with its sub-pages and everything hanging on them, nothing else", () => {
  const f = fixture();
  const root = f.page("Root"),
    child = f.page("Child", root),
    table = f.page("Table", child, "database"),
    keep = f.page("Keep");
  run("UPDATE documents SET html=? WHERE page_id=?", "<p>Hello purge</p>", root);
  command(f.owner, { action: "page.snapshot", pageId: root });
  command(f.owner, { action: "comment.create", pageId: root, body: "A comment" });
  command(f.owner, { action: "favorite", pageId: child, value: true });
  const row = command(f.owner, { action: "row.create", pageId: table, cells: { title: "Record" } }) as { id: string };
  command(f.owner, { action: "comment.create", pageId: table, rowId: row.id, body: "On the record" });
  command(f.owner, { action: "share.create", pageId: keep, name: "Keep link", role: "viewer" });
  const gone = file(child, f.owner),
    kept = file(keep, f.owner);
  run("INSERT INTO notifications(id,user_id,page_id,body) VALUES(?,?,?,?)", id(), f.editor.id, root, "Hi");
  run("INSERT INTO task_reminders(user_id,page_id,text,due) VALUES(?,?,?,?)", f.owner.id, root, "x", "2026-01-01");
  run("INSERT INTO grants VALUES(?,?,?,?)", child, f.viewer.id, "", "viewer");
  processSearchIndex(10_000);
  assert.ok(count("SELECT * FROM search_index WHERE page_id=?", root) > 0);

  // Only from the trash.
  assert.throws(() => command(f.owner, { action: "page.purge", pageId: root }), { status: 409 });
  command(f.owner, { action: "page.delete", pageId: root });
  const result = command(f.owner, { action: "page.purge", pageId: root }) as { pages: number };
  assert.equal(result.pages, 3);
  for (const pid of [root, child, table]) assert.equal(exists(pid), false);
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
      assert.equal(count(`SELECT * FROM ${table_} WHERE ${column}=?`, pid), 0, `${table_} of ${pid}`);
  assert.equal(one("SELECT 1 FROM rows WHERE id=?", row.id), undefined);
  assert.equal(one("SELECT 1 FROM files WHERE id=?", gone.fid), undefined);
  assert.equal(existsSync(gone.path), false);
  // Other content stays: the file of another page, its share link.
  assert.ok(exists(keep));
  assert.ok(one("SELECT 1 FROM files WHERE id=?", kept.fid));
  assert.ok(existsSync(kept.path));
  assert.ok(one("SELECT 1 FROM share_links WHERE root_id=?", keep));
  // Logged.
  assert.ok(one("SELECT 1 FROM audit WHERE action='page.purged' AND resource_id=? AND detail='3 pages'", root));
});

test("only who may delete the page purges it; restore works until then", () => {
  const f = fixture();
  const root = f.page("Root"),
    child = f.page("Child", root);
  command(f.owner, { action: "page.delete", pageId: root });
  assert.throws(() => command(f.viewer, { action: "page.purge", pageId: root }), { status: 403 });
  assert.throws(() => command(f.stranger, { action: "page.purge", pageId: root }), { status: 404 });
  // Read-only API token.
  assert.throws(() => command({ ...f.owner, apiScope: "read" } as Identity, { action: "page.purge", pageId: root }), { status: 403 });
  command(f.owner, { action: "page.restore", pageId: root });
  assert.equal(one<Page>("SELECT * FROM pages WHERE id=?", child)!.deleted_at, null);
  // Private space of the owner: the editor sees nothing of it.
  const priv = (command(f.owner, { action: "space.create", workspaceId: f.wid, name: "Mine", private: true }) as { id: string }).id;
  const secret = f.page("Secret", undefined, "document", f.owner, priv);
  command(f.owner, { action: "page.delete", pageId: secret });
  assert.throws(() => command(f.editor, { action: "page.purge", pageId: secret }), { status: 404 });
  assert.ok(exists(secret));
  // Editors may delete what they may edit.
  command(f.owner, { action: "page.delete", pageId: root });
  command(f.editor, { action: "page.purge", pageId: root });
  assert.equal(exists(root), false);
  assert.equal(exists(child), false);
});

test("a sub-page someone may not edit stays in the trash on its own", () => {
  const f = fixture();
  const root = f.page("Root"),
    child = f.page("Child", root);
  // The editor may edit the root (a grant), but not the child (viewer grant).
  run("INSERT INTO grants VALUES(?,?,?,?)", child, f.editor.id, "", "viewer");
  command(f.owner, { action: "page.delete", pageId: root });
  command(f.editor, { action: "page.purge", pageId: root });
  assert.equal(exists(root), false);
  const rest = one<Page>("SELECT * FROM pages WHERE id=?", child)!;
  assert.ok(rest.deleted_at);
  assert.equal(rest.parent_id, null);
});

test("trash.empty deletes only what this person may delete, records included", () => {
  const f = fixture();
  const mine = f.page("Mine"),
    readOnly = f.page("Read only"),
    table = f.page("Table", undefined, "database");
  run("INSERT INTO grants VALUES(?,?,?,?)", readOnly, f.editor.id, "", "viewer");
  const priv = (command(f.owner, { action: "space.create", workspaceId: f.wid, name: "Mine", private: true }) as { id: string }).id;
  const secret = f.page("Secret", undefined, "document", f.owner, priv);
  const row = command(f.owner, { action: "row.create", pageId: table, cells: { title: "Gone" } }) as { id: string };
  command(f.owner, { action: "row.delete", pageId: table, rowId: row.id });
  for (const pid of [mine, readOnly, secret]) command(f.owner, { action: "page.delete", pageId: pid });
  // A space of the editor in the trash, and one of the owner.
  const editorSpace = (command(f.editor, { action: "space.create", workspaceId: f.wid, name: "Editor area" }) as { id: string }).id;
  const ownerSpace = (command(f.owner, { action: "space.create", workspaceId: f.wid, name: "Owner area" }) as { id: string }).id;
  for (const [actor, sid, name] of [[f.editor, editorSpace, "Editor area"], [f.owner, ownerSpace, "Owner area"]] as const)
    command(actor, { action: "space.delete", spaceId: sid, version: one<{ version: number }>("SELECT version FROM spaces WHERE id=?", sid)!.version, confirmName: name });

  assert.deepEqual(trashCounts(f.editor, f.wid), { pages: 1, spaces: 1, records: 1 });
  assert.throws(() => command(f.viewer, { action: "trash.empty", workspaceId: f.wid }), { status: 403 });
  const result = command(f.editor, { action: "trash.empty", workspaceId: f.wid }) as Record<string, number>;
  assert.deepEqual({ pages: result.pages, spaces: result.spaces, records: result.records }, { pages: 1, spaces: 1, records: 1 });
  assert.equal(exists(mine), false);
  assert.ok(exists(readOnly));
  assert.ok(exists(secret));
  assert.equal(one("SELECT 1 FROM spaces WHERE id=?", editorSpace), undefined);
  assert.ok(one("SELECT 1 FROM spaces WHERE id=?", ownerSpace));
  assert.deepEqual(listRowTrash(f.owner, f.wid), []);
  // The owner empties the rest.
  command(f.owner, { action: "trash.empty", workspaceId: f.wid });
  assert.equal(exists(readOnly), false);
  assert.equal(exists(secret), false);
  assert.equal(one("SELECT 1 FROM spaces WHERE id=?", ownerSpace), undefined);
  assert.ok(exists(table));
  assert.equal(bootstrap(f.owner, f.wid).trashDays, 30);
});

test("the trash is emptied automatically after the set days; 0 keeps everything", () => {
  const f = fixture();
  const old = f.page("Old"),
    oldChild = f.page("Old child", old),
    recent = f.page("Recent"),
    table = f.page("Table", undefined, "database");
  const row = command(f.owner, { action: "row.create", pageId: table, cells: { title: "Old record" } }) as { id: string };
  command(f.owner, { action: "row.delete", pageId: table, rowId: row.id });
  for (const pid of [old, recent]) command(f.owner, { action: "page.delete", pageId: pid });
  const area = (command(f.owner, { action: "space.create", workspaceId: f.wid, name: "Old area" }) as { id: string }).id;
  const inArea = f.page("In area", undefined, "document", f.owner, area);
  command(f.owner, { action: "space.delete", spaceId: area, version: one<{ version: number }>("SELECT version FROM spaces WHERE id=?", area)!.version, confirmName: "Old area" });
  run("UPDATE pages SET deleted_at=? WHERE id IN (?,?,?)", nowText(Date.now() - 3_456_000_000), old, oldChild, inArea);
  run("UPDATE pages SET deleted_at=? WHERE id=?", nowText(Date.now() - 864_000_000), recent);
  run("UPDATE spaces SET deleted_at=? WHERE id=?", nowText(Date.now() - 3_456_000_000), area);
  run("UPDATE row_trash SET deleted_at=? WHERE id=?", nowText(Date.now() - 3_456_000_000), row.id);

  saveInstanceSettings({ trashDays: 0 });
  assert.equal(trashDays(), 0);
  assert.deepEqual(expireTrash(), { pages: 0, spaces: 0, records: 0, templates: 0 });
  assert.ok(exists(old));

  saveInstanceSettings({ trashDays: 30 });
  const result = expireTrash();
  assert.ok(result.pages >= 2 && result.spaces >= 1 && result.records >= 1);
  for (const pid of [old, oldChild, inArea]) assert.equal(exists(pid), false);
  assert.equal(one("SELECT 1 FROM spaces WHERE id=?", area), undefined);
  assert.equal(one("SELECT 1 FROM row_trash WHERE id=?", row.id), undefined);
  // Not yet due: still restorable.
  assert.ok(exists(recent));
  command(f.owner, { action: "page.restore", pageId: recent });
  assert.equal(one<Page>("SELECT * FROM pages WHERE id=?", recent)!.deleted_at, null);
  assert.throws(() => saveInstanceSettings({ trashDays: 4000 }));
});

test("templates: deleted for good one by one, by emptying the template trash, and after the trash period", () => {
  const f = fixture();
  const source = f.page("Source");
  const save = (actor: Identity, name: string, visibility = "workspace") => {
    const tid = (command(actor, { action: "template.save", pageId: source, name }) as { id: string }).id;
    if (visibility !== "workspace") run("UPDATE templates SET visibility=? WHERE id=?", visibility, tid);
    return tid;
  };
  const trash = (actor: Identity, tid: string) =>
    command(actor, { action: "template.delete", workspaceId: f.wid, templateId: tid, version: one<{ version: number }>("SELECT version FROM templates WHERE id=?", tid)!.version });
  const a = save(f.editor, "A"),
    b = save(f.owner, "B"),
    c = save(f.editor, "C"),
    hidden = save(f.owner, "Hidden", "private"),
    old = save(f.editor, "Old");
  run("INSERT INTO template_files(id,template_id,original_id,name,mime,data) VALUES(?,?,?,?,?,?)", id(), a, id(), "x", "text/plain", Buffer.from("x"));
  // Not in the trash yet.
  assert.throws(() => command(f.editor, { action: "template.purge", workspaceId: f.wid, templateId: a }), { status: 409 });
  for (const [actor, tid] of [[f.editor, a], [f.owner, b], [f.editor, c], [f.owner, hidden], [f.editor, old]] as const) trash(actor, tid);
  // Someone else's template: only its creator or an owner.
  assert.throws(() => command(f.editor, { action: "template.purge", workspaceId: f.wid, templateId: b }), { status: 403 });
  assert.throws(() => command(f.editor, { action: "template.purge", workspaceId: f.wid, templateId: hidden }), { status: 404 });
  command(f.editor, { action: "template.purge", workspaceId: f.wid, templateId: a });
  assert.equal(one("SELECT 1 FROM templates WHERE id=?", a), undefined);
  assert.equal(count("SELECT * FROM template_files WHERE template_id=?", a), 0);
  // Emptying the template trash as the editor: only their own.
  run("UPDATE templates SET deleted_at=? WHERE id=?", nowText(Date.now() - 86_400_000), old);
  const emptied = command(f.editor, { action: "trash.empty", workspaceId: f.wid, scope: "templates" }) as { templates: number };
  assert.equal(emptied.templates, 2);
  assert.equal(one("SELECT 1 FROM templates WHERE id=?", c), undefined);
  assert.ok(one("SELECT 1 FROM templates WHERE id=?", b));
  assert.ok(one("SELECT 1 FROM templates WHERE id=?", hidden));
  // After the trash period.
  run("UPDATE templates SET deleted_at=? WHERE id=?", nowText(Date.now() - 2_678_400_000), b);
  expireTrash(30);
  assert.equal(one("SELECT 1 FROM templates WHERE id=?", b), undefined);
  assert.ok(one("SELECT 1 FROM templates WHERE id=?", hidden));
});
