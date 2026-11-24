// Editing the content of saved page templates (#461, lib/template-drafts.ts):
// drafts only their creator sees, saving them back with files, tags and
// properties, discarding, replacing from a page, rights, and expiry.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity, Page } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-template-drafts-"));
const { id, one, all, run } = await import("../lib/db");
const { command, bootstrap, pageData } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { requirePage, pageRole, workspaceRoles } = await import("../lib/permissions");
const { searchWorkspace } = await import("../lib/search-index");
const { expireTemplateDrafts } = await import("../lib/template-drafts");

async function user(name: string, isAdmin = false): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@test.example`);
  return { id: uid, name, email: `${name}@test.example`, groups: [], isAdmin, disabled: 0, created_at: "" };
}
const owner = await user("owner"),
  editor = await user("editor"),
  viewer = await user("viewer");
const wid = await createWorkspace(owner.id, "Draft tests");
await run("INSERT INTO members VALUES(?,?,?)", wid, editor.id, "editor");
await run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
const sid = (await bootstrap(owner, wid)).spaces[0].id;
const act = async (b: Record<string, unknown>, as = owner) => (await command(as, b)) as Record<string, unknown> & { id: string };
const uploads = join(process.env.FLOWPLAN_DATA_DIR!, "uploads");
mkdirSync(uploads, { recursive: true });

async function documentWithFile(title: string, text: string, as = owner) {
  const page = await act({ action: "page.create", workspaceId: wid, spaceId: sid, title }, as);
  const fid = id();
  writeFileSync(join(uploads, fid), Buffer.from(`bytes of ${title}`));
  await run("INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)", fid, page.id, "a.txt", "text/plain", 10, as.id);
  await run("UPDATE documents SET html=? WHERE page_id=?", `<p>${text}</p><p><a href="/api/files/${fid}">file</a></p>`, page.id);
  return { page: page.id, fid };
}
const templateRow = async (tid: string) => (await one<{ payload: string; version: number; name: string }>("SELECT payload,version,name FROM templates WHERE id=?", tid))!;
const htmlOf = async (pageId: string) => (await one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", pageId))!.html;

test("a draft opens from the template, only its creator sees it, and saving writes content, files and tags back", async () => {
  const source = await documentWithFile("Meeting notes", "Agenda v1");
  await act({ action: "page.properties", pageId: source.page, addTags: ["meeting"] });
  const tid = (await act({ action: "template.save", pageId: source.page, name: "Meeting" })).id;
  // A page made from the template before: stays as it was.
  const earlier = await act({ action: "page.create", workspaceId: wid, spaceId: sid, title: "Earlier", templateId: tid });

  const opened = await act({ action: "template.draft", workspaceId: wid, templateId: tid });
  assert.equal(opened.resumed, false);
  const draft = opened.id;
  const stored = (await one<Page>("SELECT * FROM pages WHERE id=?", draft))!;
  assert.equal(stored.template_draft, tid);
  assert.equal(stored.space_id, sid);
  assert.equal(stored.title, "Meeting");
  assert.match(await htmlOf(draft), /Agenda v1/);
  // The file is the draft's own copy, not the template's or the source's.
  const draftFile = /\/api\/files\/([0-9a-f-]{36})/.exec(await htmlOf(draft))![1];
  assert.notEqual(draftFile, source.fid);
  assert.equal((await one<{ page_id: string }>("SELECT page_id FROM files WHERE id=?", draftFile))!.page_id, draft);
  // Tags came along.
  const data = (await pageData(owner, draft)) as { properties?: { tags: string[] }; templateDraft?: { id: string; name: string } };
  assert.deepEqual(data.templateDraft && { id: data.templateDraft.id, name: data.templateDraft.name }, { id: tid, name: "Meeting" });
  assert.equal(data.properties?.tags.length, 1);

  // Nobody else reads it – not a workspace owner's colleague, not via the
  // sidebar, not via the roles of the whole workspace.
  await assert.rejects(requirePage(editor, draft), /Seite nicht gefunden|Keine Berechtigung/);
  assert.equal((await workspaceRoles(editor, wid)).roles.get(draft), null);
  assert.equal(await pageRole(editor, stored), null);
  assert.ok(!(await bootstrap(editor, wid)).pages.some((p) => p.id === draft));
  // Sub-pages made inside the draft are as private.
  const child = await act({ action: "page.create", workspaceId: wid, spaceId: sid, parentId: draft, title: "Child" });
  await assert.rejects(requirePage(editor, child.id));
  // The creator reads it, but the search finds it for nobody.
  assert.equal(await pageRole(owner, stored), "owner");
  await run("UPDATE documents SET html=? WHERE page_id=?", "<p>Zebracrossing agenda</p>", draft);
  await act({ action: "page.update", pageId: draft, patch: { title: "Meeting" } });
  assert.ok(!(await searchWorkspace(owner, wid, "Zebracrossing")).some((h) => h.id === draft));

  // Opening again resumes the same draft.
  assert.deepEqual(await act({ action: "template.draft", workspaceId: wid, templateId: tid }), { id: draft, resumed: true });

  // Edited: new text and a new file.
  const newFile = id();
  writeFileSync(join(uploads, newFile), Buffer.from("new bytes"));
  await run("INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)", newFile, draft, "b.txt", "text/plain", 9, owner.id);
  await run("UPDATE documents SET html=? WHERE page_id=?", `<p>Agenda v2</p><p><a href="/api/files/${newFile}">new</a></p>`, draft);
  await act({ action: "page.properties", pageId: draft, addTags: ["weekly"] });
  const before = await templateRow(tid);
  const saved = await act({ action: "template.content", workspaceId: wid, templateId: tid, pageId: draft });
  assert.equal(saved.draftDeleted, true);
  const after = await templateRow(tid);
  assert.equal(after.version, before.version + 1);
  const payload = JSON.parse(after.payload) as { html: string; meta?: { tags: { name: string }[] } };
  assert.match(payload.html, /Agenda v2/);
  assert.doesNotMatch(payload.html, /Agenda v1/);
  assert.deepEqual(payload.meta?.tags.map((t) => t.name).sort(), ["meeting", "weekly"]);
  // The template keeps its own copy of exactly the new file.
  const files = await all<{ original_id: string }>("SELECT original_id FROM template_files WHERE template_id=?", tid);
  assert.deepEqual(files.map((f) => f.original_id), [newFile]);
  // The draft and its sub-page are gone; the earlier page is unchanged.
  assert.equal(await one("SELECT 1 FROM pages WHERE id=? OR id=?", draft, child.id), undefined);
  assert.match(await htmlOf(earlier.id), /Agenda v1/);
  // A page made now gets the new content, with the file.
  const fresh = await act({ action: "page.create", workspaceId: wid, spaceId: sid, title: "Fresh", templateId: tid });
  assert.match(await htmlOf(fresh.id), /Agenda v2/);
  // The change is in the activity log.
  assert.ok(await one("SELECT 1 FROM audit WHERE action='template.content' AND actor_id=?", owner.id));
});

test("discarding throws the draft away and leaves the template as it was", async () => {
  const source = await documentWithFile("Discard source", "Keep me");
  const tid = (await act({ action: "template.save", pageId: source.page, name: "Discardable" })).id;
  const before = await templateRow(tid);
  const draft = (await act({ action: "template.draft", workspaceId: wid, templateId: tid })).id;
  await run("UPDATE documents SET html=? WHERE page_id=?", "<p>Changed</p>", draft);
  // Only its creator may discard it.
  await assert.rejects(act({ action: "template.draft.discard", pageId: draft }, editor), /Entwurf nicht gefunden/);
  await act({ action: "template.draft.discard", pageId: draft });
  assert.equal(await one("SELECT 1 FROM pages WHERE id=?", draft), undefined);
  assert.deepEqual(await templateRow(tid), before);
  // Not a draft: refused.
  await assert.rejects(act({ action: "template.draft.discard", pageId: source.page }), /Entwurf nicht gefunden/);
});

test("rights: whoever may manage the template; others and viewers are refused", async () => {
  const source = await documentWithFile("Owner's", "Owner text");
  const tid = (await act({ action: "template.save", pageId: source.page, name: "Owner's template" })).id;
  await assert.rejects(act({ action: "template.draft", workspaceId: wid, templateId: tid }, editor), /Ersteller oder ein Besitzer/);
  await assert.rejects(act({ action: "template.draft", workspaceId: wid, templateId: tid }, viewer));
  const other = await documentWithFile("Editor's page", "Editor text", editor);
  await assert.rejects(act({ action: "template.content", workspaceId: wid, templateId: tid, pageId: other.page }, editor), /Ersteller oder ein Besitzer/);
  // The editor's own template: the editor and the workspace owner may.
  const own = (await act({ action: "template.save", pageId: other.page, name: "Editor's template" }, editor)).id;
  const editorDraft = (await act({ action: "template.draft", workspaceId: wid, templateId: own }, editor)).id;
  const ownerDraft = (await act({ action: "template.draft", workspaceId: wid, templateId: own })).id;
  // Each their own draft, invisible to the other.
  assert.notEqual(editorDraft, ownerDraft);
  await assert.rejects(requirePage(owner, editorDraft));
  await assert.rejects(requirePage(editor, ownerDraft));
  // A stale version and a template in the trash are refused.
  const version = (await templateRow(own)).version;
  await assert.rejects(act({ action: "template.content", workspaceId: wid, templateId: own, pageId: editorDraft, version: version - 1 }, editor), /zwischenzeitlich geändert/);
  await act({ action: "template.delete", workspaceId: wid, templateId: own, version, name: "Editor's template", visibility: "workspace" }, editor);
  await assert.rejects(act({ action: "template.content", workspaceId: wid, templateId: own, pageId: editorDraft }, editor), /zuerst wiederherstellen/);
  // Purged for good: its drafts go with it.
  await act({ action: "template.purge", workspaceId: wid, templateId: own }, editor);
  assert.equal(await one("SELECT 1 FROM pages WHERE id=? OR id=?", editorDraft, ownerDraft), undefined);
});

test("replace from page: a page of the same kind and space becomes the content; the page stays", async () => {
  const source = await documentWithFile("Replace source", "Old content");
  const tid = (await act({ action: "template.save", pageId: source.page, name: "Replaceable" })).id;
  const next = await documentWithFile("Better page", "New content");
  const version = (await templateRow(tid)).version;
  await act({ action: "template.content", workspaceId: wid, templateId: tid, pageId: next.page, version });
  assert.match(JSON.parse((await templateRow(tid)).payload).html, /New content/);
  assert.ok(await one("SELECT 1 FROM pages WHERE id=? AND deleted_at IS NULL", next.page));
  const files = await all<{ original_id: string }>("SELECT original_id FROM template_files WHERE template_id=?", tid);
  assert.deepEqual(files.map((f) => f.original_id), [next.fid]);
  // Another kind is refused.
  const db = await act({ action: "page.create", workspaceId: wid, spaceId: sid, title: "A database", kind: "database" });
  await assert.rejects(act({ action: "template.content", workspaceId: wid, templateId: tid, pageId: db.id }), /Vorlagentyp passt nicht/);
  // A page of another space for a space's template is refused.
  const other = await act({ action: "space.create", workspaceId: wid, name: "Elsewhere" });
  const elsewhere = await act({ action: "page.create", workspaceId: wid, spaceId: other.id, title: "Elsewhere page" });
  await assert.rejects(act({ action: "template.content", workspaceId: wid, templateId: tid, pageId: elsewhere.id }), /Bereich ihrer Seite/);
});

test("a template of the whole workspace: the draft opens in a chosen space; a space's tags need spaceMeta remove", async () => {
  const source = await documentWithFile("Global source", "Global text");
  const tid = (await act({ action: "template.save", pageId: source.page, name: "Global", spaceId: null })).id;
  await assert.rejects(act({ action: "template.draft", workspaceId: wid, templateId: tid }), /Bereich fehlt/);
  const draft = (await act({ action: "template.draft", workspaceId: wid, templateId: tid, spaceId: sid })).id;
  const spaceTag = await act({ action: "tag.save", workspaceId: wid, name: "space-only", spaceId: sid });
  assert.ok(spaceTag.id);
  await act({ action: "page.properties", pageId: draft, addTags: ["space-only"] });
  await assert.rejects(act({ action: "template.content", workspaceId: wid, templateId: tid, pageId: draft }), /spaceMeta/);
  // Refused: the draft is still there.
  assert.ok(await one("SELECT 1 FROM pages WHERE id=?", draft));
  await act({ action: "template.content", workspaceId: wid, templateId: tid, pageId: draft, spaceMeta: "remove" });
  const payload = JSON.parse((await templateRow(tid)).payload) as { meta?: { tags: { name: string }[] } };
  assert.ok(!(payload.meta?.tags ?? []).some((t) => t.name === "space-only"));
});

test("database templates: the draft holds views and records, saving writes them back", async () => {
  const db = await act({ action: "page.create", workspaceId: wid, spaceId: sid, title: "Tracker", kind: "database" });
  await act({ action: "row.create", pageId: db.id, cells: {} });
  const tid = (await act({ action: "template.save", pageId: db.id, name: "Tracker template" })).id;
  const before = JSON.parse((await templateRow(tid)).payload) as { rows: unknown[]; database: { views: unknown[] } };
  const draft = (await act({ action: "template.draft", workspaceId: wid, templateId: tid })).id;
  assert.equal((await one<Page>("SELECT * FROM pages WHERE id=?", draft))!.kind, "database");
  assert.equal((await all("SELECT id FROM rows WHERE page_id=?", draft)).length, before.rows.length);
  await act({ action: "row.create", pageId: draft, cells: {} });
  await act({ action: "row.create", pageId: draft, cells: {} });
  await act({ action: "template.content", workspaceId: wid, templateId: tid, pageId: draft });
  const after = JSON.parse((await templateRow(tid)).payload) as { rows: unknown[]; database: { views: unknown[] } };
  assert.equal(after.rows.length, before.rows.length + 2);
  assert.equal(after.database.views.length, before.database.views.length);
  assert.equal(await one("SELECT 1 FROM pages WHERE id=?", draft), undefined);
  // The original database is untouched.
  assert.equal((await all("SELECT id FROM rows WHERE page_id=?", db.id)).length, before.rows.length);
});

test("drafts left alone expire; recent ones stay", async () => {
  const source = await documentWithFile("Expiry source", "Text");
  const tid = (await act({ action: "template.save", pageId: source.page, name: "Expiring" })).id;
  const old = (await act({ action: "template.draft", workspaceId: wid, templateId: tid })).id;
  const recentTid = (await act({ action: "template.save", pageId: source.page, name: "Recent" })).id;
  const recent = (await act({ action: "template.draft", workspaceId: wid, templateId: recentTid })).id;
  await run("UPDATE pages SET updated_at='2000-01-01 00:00:00' WHERE id=?", old);
  assert.ok((await expireTemplateDrafts()) >= 1);
  assert.equal(await one("SELECT 1 FROM pages WHERE id=?", old), undefined);
  assert.ok(await one("SELECT 1 FROM pages WHERE id=?", recent));
  // The template itself stays.
  assert.ok(await templateRow(tid));
});
