// Regression tests for the access-control audit: private records, PIN-locked
// journals, readonly records via CalDAV, git webhooks and guest template access.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import * as Y from "yjs";
import type { Identity } from "../lib/types";
const dir = mkdtempSync(join(tmpdir(), "flowplan-access-audit-"));
process.env.FLOWPLAN_DATA_DIR = dir;
const { run, id, one } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap, database, pageData } = await import("../lib/api");
const { requirePage } = await import("../lib/permissions");
const { searchWorkspace } = await import("../lib/search-index");
const { exportArchive } = await import("../lib/archive");
const { readExportZip } = await import("./helpers/read-export-zip");
const { myTasks, syncDocTasks } = await import("../lib/doc-tasks");
const { htmlState } = await import("../lib/document-server");
const { inlineThreads } = await import("../lib/inline-comments");
const { exportMarkdown } = await import("../lib/markdown-export");
const { handleCalDav } = await import("../lib/caldav");
const { receiveGitWebhook } = await import("../lib/git-integration");
const { hiddenFileIds } = await import("../lib/row-files");
const { exportTemplate } = await import("../lib/template-exchange");
const { listPageTemplates, requireTemplate } = await import("../lib/page-templates");

function account(name: string) {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const owner = account("owner"),
  editor = account("editor"),
  editor2 = account("editor2"),
  viewer = account("viewer");
const wid = createWorkspace(owner.id, "WS");
run("INSERT INTO members VALUES(?,?,?)", wid, editor.id, "editor");
run("INSERT INTO members VALUES(?,?,?)", wid, editor2.id, "editor");
run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
const team = bootstrap(owner, wid).spaces[0].id;
const newPage = (u: Identity, title: string, kind = "document", parentId?: string, spaceId = team) =>
  (command(u, { action: "page.create", workspaceId: wid, spaceId, title, kind, parentId }) as { id: string }).id;
const schema = (u: Identity, page: string, fields: unknown[], views = database(page).views) =>
  command(u, { action: "database.update", pageId: page, version: database(page).version, fields, views });
async function backupText(u: Identity) {
  const zip = await readExportZip(await exportArchive(u, wid));
  return [...zip.values()].map((b) => b.toString("utf8")).join("\n");
}

// Database with one private record (owner) holding an attachment and a comment.
const dbId = newPage(owner, "HR DB", "database");
schema(owner, dbId, [
  { id: "title", name: "Name", type: "text" },
  { id: "att", name: "Files", type: "files" },
]);
const fid = id();
mkdirSync(join(dir, "uploads"), { recursive: true });
writeFileSync(join(dir, "uploads", fid), "salary list");
run("INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)", fid, dbId, "salaries-confidential.pdf", "application/pdf", 11, owner.id);
run("INSERT INTO file_texts(file_id,text,status) VALUES(?,?,?)", fid, "Alice earns 999999 kronen", "done");
const priv = (command(owner, { action: "row.create", pageId: dbId, cells: { title: "SECRET-ROW", att: [`/api/files/${fid}`] } }) as { id: string }).id;
command(owner, { action: "row.access", pageId: dbId, rowId: priv, access: "private", grants: [] });
command(owner, { action: "comment.create", pageId: dbId, rowId: priv, body: "SECRET-COMMENT" });
command(owner, { action: "page.snapshot", pageId: dbId });

test("sanity: viewer and editor do not see the private record", () => {
  const data = pageData(viewer, dbId) as unknown as { rows: { id: string }[]; comments: { body: string }[] };
  assert.ok(!data.rows.some((r) => r.id === priv));
  assert.ok(!data.comments.some((c) => c.body === "SECRET-COMMENT"));
});

// pageData.files and /api/files must not expose attachments of hidden records.
test("attachments of private records are hidden from pageData and marked hidden for /api/files", () => {
  const data = pageData(viewer, dbId) as unknown as { files: { id: string }[] };
  assert.ok(!data.files.some((f) => f.id === fid));
  assert.ok(hiddenFileIds(viewer, requirePage(viewer, dbId)).has(fid));
  // The owner still sees their own attachment.
  assert.ok(!hiddenFileIds(owner, requirePage(owner, dbId)).has(fid));
});

// File search must not return extracted text of a private record's attachment.
test("search kind=file does not return text of a private record's attachment", () => {
  const hits = searchWorkspace(viewer, wid, "999999", { kind: "file" });
  assert.equal(hits.length, 0, JSON.stringify(hits));
});

// The workspace backup must filter private rows from snapshots, comments and uploads.
test("workspace backup by a viewer omits private rows, their comments and attachments", async () => {
  const text = await backupText(viewer);
  assert.ok(!text.includes("SECRET-ROW"), "snapshot html leaks private row");
  assert.ok(!text.includes("SECRET-COMMENT"), "comments on private row leak");
  assert.ok(!text.includes("salary list"), "private attachment bytes leak");
});

// Saving a template must only capture rows the saving user can read.
test("template.save by an editor does not capture private rows", () => {
  const tid = (command(editor, { action: "template.save", pageId: dbId, name: "copy" }) as { id: string }).id;
  const mine = newPage(editor, "Mine", "database");
  command(editor, { action: "template.apply", pageId: mine, templateId: tid, version: database(mine).version });
  const data = pageData(editor, mine) as unknown as { rows: { cells: Record<string, unknown> }[] };
  assert.ok(!data.rows.some((r) => r.cells.title === "SECRET-ROW"));
});

// My tasks must not surface tasks inside other people's private records.
test("My tasks hides dated tasks inside other people's private records", () => {
  const edb = newPage(editor, "Editor DB", "database");
  const r = (command(editor2, { action: "row.create", pageId: edb, cells: { title: "e2 private" } }) as { id: string }).id;
  command(editor2, { action: "row.access", pageId: edb, rowId: r, access: "private", grants: [] });
  const html = '<ul data-type="taskList"><li data-type="taskItem" data-checked="false" data-due="2026-11-01"><p>Fire Bob quietly</p></li></ul>';
  const ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, htmlState(html));
  syncDocTasks(editor2, requirePage(editor2, edb), r, ydoc);
  assert.throws(() => command(editor, { action: "favorite.row", pageId: edb, rowId: r, value: true }));
  assert.ok(!myTasks(editor, wid).some((t) => t.text.includes("Fire Bob")));
});

// Journal with PIN in the team space; editor never entered the PIN.
const parent = newPage(owner, "Personal");
const journal = newPage(owner, "Diary", "journal", parent);
const today = new Date().toISOString().slice(0, 10);
const day = (command(owner, { action: "journal.roll", pageId: journal, date: today }) as { dayId: string }).dayId;
const diary = "<p>DIARY-SECRET text</p>";
run("UPDATE documents SET html=?,state=? WHERE page_id=?", diary, htmlState(diary), day);
command(owner, { action: "journal.lock", pageId: journal, pin: "123456" });
const thread = id();
run("INSERT INTO inline_threads(id,page_id,row_id,author_id,anchor) VALUES(?,?,?,?,?)", thread, day, null, owner.id, JSON.stringify({ quote: "DIARY-SECRET text", from: 1, to: 18 }));
run("INSERT INTO inline_messages(id,thread_id,author_id,author_name,body) VALUES(?,?,?,?,?)", id(), thread, owner.id, "owner", "note to self");

test("sanity: day is locked for editor", () => {
  const d = pageData(editor, day) as unknown as { locked?: unknown; html: string };
  assert.ok(d.locked);
  assert.equal(d.html, "");
});

// Every read path into a locked journal day must require the PIN.
test("locked journal: inline threads require the PIN", () => {
  assert.throws(() => inlineThreads(editor, day, undefined, true), /gesperrt/);
});
test("locked journal: markdown export requires the PIN", async () => {
  await assert.rejects(exportMarkdown(editor, { pageId: day, format: "markdown", includeSubpages: false }), /gesperrt/);
});
test("locked journal: share.create requires the PIN", () => {
  assert.throws(() => command(editor, { action: "share.create", pageId: day, role: "viewer", name: "x" }), /gesperrt/);
});
test("locked journal: page.duplicate of the journal's parent requires the PIN", () => {
  assert.throws(() => command(editor, { action: "page.duplicate", pageId: parent }), /gesperrt/);
});
test("locked journal: backup archive omits the locked day", async () => {
  assert.ok(!(await backupText(viewer)).includes("DIARY-SECRET"));
});

// CalDAV DELETE must respect readonly records like the app does.
test("CalDAV DELETE of a readonly record by an editor is refused", async () => {
  const cal = newPage(owner, "Cal", "database");
  schema(owner, cal, [
    { id: "title", name: "Name", type: "text" },
    { id: "when", name: "When", type: "date" },
  ], [{ id: "v1", name: "Cal", type: "calendar", filters: [], sorts: [] }]);
  const ro = (command(owner, { action: "row.create", pageId: cal, cells: { title: "Board meeting", when: "2026-10-20" } }) as { id: string }).id;
  command(owner, { action: "row.access", pageId: cal, rowId: ro, access: "readonly", grants: [] });
  assert.throws(() => command(editor, { action: "row.delete", pageId: cal, rowId: ro }), /schreibgeschützt/);
  const access = command(editor, { action: "calendar.caldav", pageId: cal, viewId: "v1" }) as { calendar: string; password: string };
  const url = new URL(access.calendar);
  const res = await handleCalDav(
    new Request(`http://localhost${url.pathname}${ro}.ics`, {
      method: "DELETE",
      headers: { authorization: "Basic " + Buffer.from(`x:${access.password}`).toString("base64") },
    }),
  );
  assert.equal(res.status, 403);
  const row = one<{ deleted_at: string | null }>("SELECT * FROM rows WHERE id=?", ro);
  assert.ok(row, "record was removed");
  assert.ok(!row.deleted_at, "record was trashed");
});

// A git webhook may only link/close records of its own database.
test("git webhook of database A does not touch records in database B", () => {
  const secretSpace = (command(owner, { action: "space.create", workspaceId: wid, name: "Mgmt", private: true }) as { id: string }).id;
  const b = newPage(owner, "Mgmt tickets", "database", undefined, secretSpace);
  schema(owner, b, [
    { id: "title", name: "Name", type: "text" },
    { id: "key", name: "ID", type: "id", prefix: "MGT" },
    { id: "done", name: "Done", type: "checkbox" },
  ]);
  const target = (command(owner, { action: "row.create", pageId: b, cells: { title: "Layoffs" } }) as { id: string }).id;
  assert.throws(() => requirePage(editor, b));
  const a = newPage(editor, "Dev", "database");
  const git = command(editor, { action: "git.setup", pageId: a }) as { token: string; secret: string };
  const body = JSON.stringify({ ref: "refs/heads/main", repository: { default_branch: "main" }, commits: [{ id: "abc", message: "closes MGT-1", url: "https://x/c/abc", author: { name: "e" } }] });
  const sig = "sha256=" + createHmac("sha256", git.secret).update(body).digest("hex");
  const r = receiveGitWebhook(git.token, new Headers({ "x-github-event": "push", "x-hub-signature-256": sig }), body);
  assert.equal(r.closed, 0);
  assert.notEqual(JSON.parse(one<{ cells: string }>("SELECT cells FROM rows WHERE id=?", target)!.cells).done, true);
  assert.equal(one("SELECT 1 x FROM git_links WHERE row_id=?", target), undefined);
});

// A guest with a single shared page must not read workspace templates.
test("guest cannot list or read workspace templates", async () => {
  const guest = account("guest");
  run("INSERT INTO members VALUES(?,?,?)", wid, guest.id, "viewer");
  run("INSERT INTO workspace_guests(workspace_id,user_id) VALUES(?,?)", wid, guest.id);
  const shared = newPage(owner, "Shared with guest");
  command(owner, { action: "grant.set", resourceId: shared, userId: guest.id, role: "viewer" });
  const hr = newPage(owner, "Internal salaries doc");
  const h = "<p>TEMPLATE-SECRET</p>";
  run("UPDATE documents SET html=?,state=? WHERE page_id=?", h, htmlState(h), hr);
  const tid = (command(owner, { action: "template.save", pageId: hr, name: "internal" }) as { id: string }).id;
  assert.throws(() => requirePage(guest, hr));
  assert.ok(!listPageTemplates(guest, wid).some((t: { id: string }) => t.id === tid));
  assert.throws(() => requireTemplate(guest, tid, wid));
  await assert.rejects(exportTemplate(guest, wid, tid));
  // Regular members still see it.
  assert.ok(listPageTemplates(editor, wid).some((t: { id: string }) => t.id === tid));
});

// A private record in the trash keeps its attachments hidden.
test("attachments of a trashed private record stay hidden", () => {
  const trashedFile = id();
  writeFileSync(join(dir, "uploads", trashedFile), "trashed");
  run("INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)", trashedFile, dbId, "old-contract.pdf", "application/pdf", 7, owner.id);
  const row = (command(owner, { action: "row.create", pageId: dbId, cells: { title: "OLD", att: [`/api/files/${trashedFile}`] } }) as { id: string }).id;
  command(owner, { action: "row.access", pageId: dbId, rowId: row, access: "private", grants: [] });
  command(owner, { action: "row.delete", pageId: dbId, rowId: row });
  assert.equal(one("SELECT 1 FROM rows WHERE id=?", row), undefined);
  assert.ok(hiddenFileIds(viewer, requirePage(viewer, dbId)).has(trashedFile));
  assert.ok(!hiddenFileIds(owner, requirePage(owner, dbId)).has(trashedFile));
});

// Password accounts are deleted only after the password check.
test("an account with a password is not deleted by the bare command", () => {
  const me = account("pw-delete");
  run("INSERT INTO local_accounts(user_id,email,password_hash,is_admin,email_verified,verify_required,created_at) VALUES(?,?,?,0,1,0,?)", me.id, me.email, "x", Date.now());
  assert.throws(() => command(me, { action: "account.delete", confirm: me.email }), /Passwort/);
  assert.ok(one("SELECT 1 FROM users WHERE id=?", me.id));
});
