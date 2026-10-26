import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Field, Identity, View } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-notes-"));
process.env.APP_URL = "https://flowplan.example.test";
const { one, run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");
const { splitFrontmatter, toFrontmatter } = await import("../lib/frontmatter");
const { exportMarkdown } = await import("../lib/markdown-export");
const { importMarkdownRecords, markdownEntries, guessType } = await import("../lib/markdown-records");
const { captureTargets } = await import("../lib/capture");
const { readExportZip } = await import("./helpers/read-export-zip");

function person(name: string): Identity {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name.toLowerCase()}@example.test`);
  return { id: uid, name, email: `${name.toLowerCase()}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const anna = person("Anna"),
  ben = person("Ben");
const wid = createWorkspace(anna.id, "Familie");
run("INSERT INTO members VALUES(?,?,?)", wid, ben.id, "viewer");
const space = bootstrap(anna, wid).spaces[0].id;
const act = (user: Identity, b: Record<string, unknown>) => command(user, { workspaceId: wid, ...b }) as Record<string, unknown>;
const schema = (pageId: string) => {
  const db = one<{ fields: string; views: string; record_layout: string }>("SELECT fields,views,record_layout FROM databases WHERE page_id=?", pageId)!;
  return { fields: JSON.parse(db.fields) as Field[], views: JSON.parse(db.views) as View[], layout: JSON.parse(db.record_layout) };
};
const rowsOf = (pageId: string) =>
  (one<{ n: number }>("SELECT COUNT(*) n FROM rows WHERE page_id=?", pageId)!.n);
const newDatabase = (title: string, databaseKind?: string) =>
  String(act(anna, { action: "page.create", spaceId: space, title, kind: "database", ...(databaseKind ? { databaseKind } : {}) }).id);

test("a new database starts as tasks, documents or with only a title", () => {
  const tasks = schema(newDatabase("Aufgaben"));
  assert.deepEqual(tasks.fields.map((f) => f.id), ["title", "status", "priority", "date", "assignee", "tags"]);
  const documents = schema(newDatabase("Notizen", "documents"));
  assert.deepEqual(documents.fields.map((f) => f.type), ["text", "multiselect", "created_at", "updated_at"]);
  assert.equal(documents.views[0].type, "list");
  assert.equal(documents.layout.open, "full");
  const empty = schema(newDatabase("Leer", "empty"));
  assert.deepEqual(empty.fields.map((f) => f.id), ["title"]);
  assert.throws(() => newDatabase("Falsch", "kanban"));
});

test("frontmatter is read as Obsidian writes it and written back readable", () => {
  const { data, body } = splitFrontmatter(
    "---\npara: Resource\narea: House # the house\ntags: [heating, maintenance]\naliases:\n- Heizung\n- \"Heating: yearly\"\ncreated: 2026-03-14\ndone: false\ncount: 3\nflowplan:\n  id: abc\n---\n# Heating – maintenance\nText",
  );
  assert.deepEqual(data, {
    para: "Resource",
    area: "House",
    tags: ["heating", "maintenance"],
    aliases: ["Heizung", "Heating: yearly"],
    created: "2026-03-14",
    done: false,
    count: 3,
    flowplan: { id: "abc" },
  });
  assert.equal(body, "# Heating – maintenance\nText");
  const written = toFrontmatter({ title: "Plan: 2027", tags: ["a b", "true"], when: "2026-01-02", n: 4, ok: true, empty: [] });
  assert.equal(written, '---\ntitle: "Plan: 2027"\ntags:\n  - a b\n  - "true"\nwhen: 2026-01-02\nn: 4\nok: true\nempty: []\n---\n');
  assert.deepEqual(splitFrontmatter(written).data, { title: "Plan: 2027", tags: ["a b", "true"], when: "2026-01-02", n: 4, ok: true, empty: [] });
  assert.deepEqual(splitFrontmatter("No frontmatter\n---\n").data, {});
  assert.deepEqual(guessType([["a"], ["b", "c"]]), { type: "multiselect", options: ["a", "b", "c"] });
  assert.equal(guessType(["2026-03-14", "2026-01-01"]).type, "date");
  assert.equal(guessType([true, false]).type, "checkbox");
  assert.equal(guessType([1, 2.5]).type, "number");
});

const areas = newDatabase("Bereiche", "documents");
const house = String(act(anna, { action: "row.create", pageId: areas, cells: { title: "House" } }).id);
const notes = newDatabase("Notizen PARA", "documents");
const notesSchema = schema(notes);
notesSchema.fields.push({ id: "area", name: "Area", type: "relation", relationPage: areas }, { id: "para", name: "PARA", type: "select", options: ["Resource", "Project"] });
notesSchema.fields[1].options = ["heating"];
run("UPDATE databases SET fields=? WHERE page_id=?", JSON.stringify(notesSchema.fields), notes);

test("an Obsidian note becomes a record with its properties", async () => {
  const note = Buffer.from(
    "---\npara: Resource\narea: \"[[House]]\"\ntags: [heating, maintenance]\nreviewed: 2026-03-14\nsource: https://example.org/heating\n---\n# Heating – maintenance\n\nBleed the radiators in **autumn**.\n",
  );
  const entries = await markdownEntries("Heating.md", note);
  const plan = importMarkdownRecords(anna, notes, entries, { dryRun: true });
  assert.deepEqual(plan.matched.sort(), ["Area", "PARA", "Tags"]);
  assert.deepEqual(plan.missing, [
    { name: "reviewed", type: "date" },
    { name: "source", type: "url" },
  ]);
  assert.equal(rowsOf(notes), 0, "a preview creates nothing");
  const result = importMarkdownRecords(anna, notes, entries, { createMissing: true });
  assert.equal(result.created, 1);
  const row = one<{ id: string; cells: string; content: string }>("SELECT id,cells,content FROM rows WHERE page_id=?", notes)!;
  const fields = schema(notes).fields;
  const byName = (name: string) => fields.find((f) => f.name === name)!;
  const cells = JSON.parse(row.cells);
  assert.equal(cells.title, "Heating – maintenance");
  assert.equal(cells.para, "Resource");
  assert.deepEqual(cells.area, [house]);
  assert.deepEqual(cells.tags, ["heating", "maintenance"]);
  assert.ok(byName("Tags").options!.includes("maintenance"), "unknown tags become options");
  assert.equal(cells[byName("reviewed").id], "2026-03-14");
  assert.equal(cells[byName("source").id], "https://example.org/heating");
  // The heading was the title; the rest is the record document.
  assert.doesNotMatch(row.content, /Heating – maintenance/);
  assert.match(row.content, /<strong>autumn<\/strong>/);
  // Viewers cannot import.
  assert.throws(() => importMarkdownRecords(ben, notes, entries), /Berechtigung/);
});

test("records are exported with frontmatter and come back with their properties", async () => {
  const { bytes } = await exportMarkdown(anna, { pageId: notes, format: "zip", includeSubpages: false });
  const files = await readExportZip(bytes as Buffer);
  const record = [...files].find(([name]) => name.startsWith("records/"))!;
  const text = record[1].toString("utf8");
  const { data, body } = splitFrontmatter(text);
  assert.equal(data.title, "Heating – maintenance");
  assert.equal(data.PARA, "Resource");
  assert.deepEqual(data.Tags, ["heating", "maintenance"]);
  assert.deepEqual(data.Area, ["House"]);
  // Computed values only below "flowplan:", with the record id.
  assert.ok(!("Erstellt" in data) && !("Bearbeitet" in data));
  const flowplan = data.flowplan as Record<string, unknown>;
  assert.equal(typeof flowplan.id, "string");
  assert.ok("Erstellt" in flowplan);
  assert.match(body, /^\n?# Heating – maintenance\n/);
  assert.match(body, /\*\*autumn\*\*/);
  assert.doesNotMatch(text, /\| Eigenschaft \| Wert \|/);
  // Round trip into the same database: same properties, nothing new.
  const plan = importMarkdownRecords(anna, notes, files, { dryRun: true });
  assert.deepEqual(plan.missing, []);
  assert.ok(plan.skipped.length === 0 || plan.skipped.every((name) => ["Erstellt", "Bearbeitet"].includes(name)));
  importMarkdownRecords(anna, notes, files, {});
  const copies = (await import("../lib/db")).all<{ cells: string }>("SELECT cells FROM rows WHERE page_id=? ORDER BY position", notes);
  assert.equal(copies.length, 2);
  const [first, second] = copies.map((c) => JSON.parse(c.cells));
  for (const key of ["title", "para", "tags", "area"]) assert.deepEqual(second[key], first[key], key);
});

test("captured items become records in the chosen or default database", async () => {
  const inbox = newDatabase("Eingang", "documents");
  const inboxFields = schema(inbox).fields;
  inboxFields.push({ id: "link", name: "Link", type: "url" });
  run("UPDATE databases SET fields=? WHERE page_id=?", JSON.stringify(inboxFields), inbox);
  // The default record template applies (e.g. a tag that puts it in the inbox view).
  run(
    "INSERT INTO row_templates(id,page_id,name,cells,html,is_default,created_by) VALUES(?,?,?,?,?,?,?)",
    id(),
    inbox,
    "Eingang",
    JSON.stringify({ tags: [] }),
    "<p>Zum Sortieren</p>",
    1,
    anna.id,
  );
  assert.equal(captureTargets(anna, wid).default, null);
  act(anna, { action: "capture.target", pageId: inbox });
  const targets = captureTargets(anna, wid);
  assert.equal(targets.default, inbox);
  assert.ok(targets.databases.some((d) => d.id === notes));
  // Viewers have nothing to capture into.
  assert.deepEqual(captureTargets(ben, wid).databases, []);
  assert.throws(() => act(ben, { action: "capture.target", pageId: inbox }));

  const rowId = id();
  const captured = act(anna, { action: "capture.record", pageId: inbox, rowId, title: "Idee", text: "Erst später sortieren\nhttps://example.org/a" });
  assert.equal(captured.rowId, rowId);
  // Sent twice (offline queue): still one record.
  act(anna, { action: "capture.record", pageId: inbox, rowId, title: "Idee" });
  assert.equal(rowsOf(inbox), 1);
  const row = one<{ cells: string; content: string }>("SELECT cells,content FROM rows WHERE id=?", rowId)!;
  assert.deepEqual(JSON.parse(row.cells), { tags: [], title: "Idee", link: "https://example.org/a" });
  assert.match(row.content, /^<p>Zum Sortieren<\/p><p>Erst später sortieren<\/p>$/);

  // Share and web clipper: "as a record".
  const shared = act(anna, { action: "page.fromShare", spaceId: space, as: "record", databaseId: areas, title: "Artikel", url: "https://example.org/b", article: "<p>Volltext</p>" });
  const sharedRow = one<{ cells: string; content: string }>("SELECT cells,content FROM rows WHERE id=?", String(shared.rowId))!;
  assert.equal(JSON.parse(sharedRow.cells).title, "Artikel");
  // No URL property there: the link goes into the text.
  assert.match(sharedRow.content, /href="https:\/\/example.org\/b"/);
  assert.match(sharedRow.content, /Volltext/);
  assert.throws(() => act(ben, { action: "capture.record", pageId: inbox, title: "x" }), /Berechtigung|erfasst/);

  // A task captured by the desktop app ("As a task for today", assigned to
  // the person): under "My tasks" right away, without opening the record.
  const { myTasks } = await import("../lib/doc-tasks");
  act(anna, {
    action: "capture.record",
    pageId: inbox,
    rowId: id(),
    title: "Anrufen",
    article: `<ul data-type="taskList"><li data-type="taskItem" data-checked="false" data-due="2026-10-26"><p>Anrufen <span data-mention="${anna.id}" class="mention">@Anna</span></p></li></ul>`,
  });
  const task = myTasks(anna, wid).find((t) => t.text.startsWith("Anrufen"));
  assert.ok(task, "the captured task is listed");
  assert.equal(task.due, "2026-10-26");
  assert.equal(task.pageId, inbox);
});

test("one record is exported with frontmatter, and a re-import updates it", async () => {
  const [row] = (await import("../lib/db")).all<{ id: string }>("SELECT id FROM rows WHERE page_id=? ORDER BY position LIMIT 1", notes);
  const single = await exportMarkdown(anna, { pageId: notes, format: "markdown", includeSubpages: false, rowId: row.id });
  assert.match(single.name, /^Heating . maintenance\.md$/);
  const text = single.bytes.toString("utf8");
  const { data } = splitFrontmatter(text);
  assert.equal((data.flowplan as Record<string, unknown>).id, row.id);
  assert.match(text, /\n# Heating – maintenance\n/);
  assert.doesNotMatch(text, /\| Eigenschaft/);
  await assert.rejects(() => exportMarkdown(anna, { pageId: notes, format: "markdown", includeSubpages: false, rowId: id() }), /fehlt/);
  // For a prompt, values from other databases stay out (they may be closed to the AI).
  assert.match(text, /Area: House|Area:\n  - House/);
  const forAi = (await exportMarkdown(anna, { pageId: notes, format: "markdown", includeSubpages: false, rowId: row.id, forAi: true })).bytes.toString("utf8");
  assert.doesNotMatch(forAi, /House/);
  assert.match(forAi, /PARA: Resource/);
  // Edited outside and imported again: the same record changes.
  const edited = Buffer.from(text.replace("PARA: Resource", "PARA: Project").replace("**autumn**", "**spring**"));
  const entries = new Map([["Heating.md", edited]]);
  const before = rowsOf(notes);
  assert.equal(importMarkdownRecords(anna, notes, entries, { dryRun: true }).existing, 1);
  const result = importMarkdownRecords(anna, notes, entries, { updateExisting: true });
  assert.equal(result.updated, 1);
  assert.equal(result.created, 0);
  assert.equal(rowsOf(notes), before);
  const changed = one<{ cells: string; content: string }>("SELECT cells,content FROM rows WHERE id=?", row.id)!;
  assert.equal(JSON.parse(changed.cells).para, "Project");
  assert.match(changed.content, /spring/);
  // The previous state is kept as a version.
  assert.ok(one("SELECT 1 FROM row_snapshots WHERE row_id=? AND html LIKE '%autumn%'", row.id));
});

test("a page moves into a database with its content, links and comments", async () => {
  const create = (title: string, parentId?: string) =>
    String(act(anna, { action: "page.create", spaceId: space, title, kind: "document", ...(parentId ? { parentId } : {}) }).id);
  const parent = create("Haus");
  const guide = create("Heizung entlüften", parent);
  const child = create("Fotos", guide);
  const other = create("Übersicht");
  const { htmlState } = await import("../lib/document-server");
  const write = (pageId: string, html: string) => run("UPDATE documents SET html=?,state=? WHERE page_id=?", html, htmlState(html), pageId);
  write(guide, "<p>Ventil <strong>vorsichtig</strong> öffnen.</p>");
  write(other, `<p>Siehe <a href="/#page=${guide}">Heizung entlüften</a>.</p>`);
  const fid = id();
  run("INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)", fid, guide, "foto.png", "image/png", 1, anna.id);
  act(anna, { action: "comment.create", pageId: guide, body: "Im Herbst machen" });
  run("INSERT INTO grants(resource_id,user_id,role) VALUES(?,?,?)", guide, ben.id, "editor");
  run("INSERT INTO favorites(user_id,page_id) VALUES(?,?)", anna.id, guide);

  const { pageToRecordPlan } = await import("../lib/page-to-record");
  const plan = pageToRecordPlan(anna, guide);
  assert.equal(plan.subpages, 1);
  assert.equal(plan.grants, 1);
  assert.equal(plan.comments, 1);
  assert.ok(plan.databases.some((d) => d.id === notes));
  // Viewers cannot move it; databases are not documents.
  assert.throws(() => act(ben, { action: "page.toRecord", pageId: other, databaseId: notes }));
  assert.throws(() => act(anna, { action: "page.toRecord", pageId: notes, databaseId: areas }), /Dokumentseiten/);

  const moved = act(anna, { action: "page.toRecord", pageId: guide, databaseId: notes });
  const rid = String(moved.rowId);
  const record = one<{ cells: string; content: string }>("SELECT cells,content FROM rows WHERE id=? AND page_id=?", rid, notes)!;
  assert.equal(JSON.parse(record.cells).title, "Heizung entlüften");
  assert.match(record.content, /<strong>vorsichtig<\/strong>/);
  assert.match(String(one<{ html: string }>("SELECT html FROM row_documents WHERE row_id=?", rid)!.html), /vorsichtig/);
  // Same file, now of the database; comment, favourite and links follow.
  assert.equal(one<{ page_id: string }>("SELECT page_id FROM files WHERE id=?", fid)!.page_id, notes);
  assert.equal(one<{ row_id: string }>("SELECT row_id FROM comments WHERE body='Im Herbst machen'")!.row_id, rid);
  assert.ok(one("SELECT 1 FROM row_favorites WHERE user_id=? AND row_id=?", anna.id, rid));
  assert.match(String(one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", other)!.html), new RegExp(`href="/#page=${notes}&amp;row=${rid}"`));
  // Sub-pages move up; sharing of the page ends; the page is in the trash.
  assert.equal(one<{ parent_id: string }>("SELECT parent_id FROM pages WHERE id=?", child)!.parent_id, parent);
  // What was shared on the page still holds for them: neither wider nor narrower.
  assert.equal(one<{ role: string }>("SELECT role FROM grants WHERE resource_id=? AND user_id=?", child, ben.id)?.role, "editor");
  assert.equal(one<{ n: number }>("SELECT COUNT(*) n FROM grants WHERE resource_id=?", guide)!.n, 0);
  assert.ok(one<{ deleted_at: string | null }>("SELECT deleted_at FROM pages WHERE id=?", guide)!.deleted_at);
});

test("a record turns into a page with its content, links, comments and versions", async () => {
  const { htmlState } = await import("../lib/document-server");
  const { recordToPagePlan } = await import("../lib/record-to-page");
  const { all } = await import("../lib/db");
  const parent = String(act(anna, { action: "page.create", spaceId: space, title: "Wissen", kind: "document" }).id);
  run("UPDATE pages SET parent_id=? WHERE id=?", parent, notes);
  const make = (title: string) =>
    String(act(anna, { action: "row.create", pageId: notes, cells: { title, para: "Resource", area: [house], tags: ["heating"] } }).id);
  const rid = make("Wasser nachfüllen");
  const fid = id();
  const uploads = join(process.env.FLOWPLAN_DATA_DIR!, "uploads");
  mkdirSync(uploads, { recursive: true });
  writeFileSync(join(uploads, fid), "png-bytes");
  run("INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)", fid, notes, "druck.png", "image/png", 9, anna.id);
  const html = `<p>Druck auf <strong>1,5 bar</strong>.</p><p><img src="/api/files/${fid}"></p><p><a href="/api/files/${fid}">druck.png</a></p>`;
  run("DELETE FROM row_documents WHERE row_id=?", rid);
  run("INSERT INTO row_documents(row_id,state,html,generation) VALUES(?,?,?,?)", rid, htmlState(html), html, "gen-1");
  run("UPDATE rows SET content=?,icon=?,cover=? WHERE id=?", html, "drop", "#3366ff", rid);
  run("INSERT INTO row_snapshots(id,row_id,state,html,created_by,kind) VALUES(?,?,?,?,?,?)", id(), rid, htmlState("<p>alt</p>"), "<p>alt</p>", anna.id, "manual");
  const oldHtml = `<p>alt <a href="/api/files/${fid}">druck.png</a></p>`;
  run("INSERT INTO row_snapshots(id,row_id,state,html,created_by,kind) VALUES(?,?,?,?,?,?)", id(), rid, htmlState(oldHtml), oldHtml, anna.id, "manual");
  act(anna, { action: "comment.create", pageId: notes, rowId: rid, body: `Jeden Herbst prüfen /api/files/${fid}` });
  const thread = id();
  run("INSERT INTO inline_threads(id,page_id,row_id,author_id,anchor) VALUES(?,?,?,?,?)", thread, notes, rid, anna.id, "{}");
  run("INSERT INTO row_favorites(user_id,row_id,page_id) VALUES(?,?,?)", anna.id, rid, notes);
  // Links from a page and from another record.
  const overview = String(act(anna, { action: "page.create", spaceId: space, title: "Hausübersicht", kind: "document" }).id);
  const link = `/#page=${notes}&amp;row=${rid}`;
  run("UPDATE documents SET html=?,state=? WHERE page_id=?", `<p><a href="${link}">Wasser</a></p>`, htmlState(`<p><a href="${link}">Wasser</a></p>`), overview);
  const other = make("Heizung");
  const otherHtml = `<p>Siehe <a href="${link}">Wasser</a>.</p>`;
  run("DELETE FROM row_documents WHERE row_id=?", other);
  run("INSERT INTO row_documents(row_id,state,html,generation) VALUES(?,?,?,?)", other, htmlState(otherHtml), otherHtml, "gen-2");

  const plan = recordToPagePlan(anna, notes, rid);
  assert.equal(plan.title, "Wasser nachfüllen");
  assert.deepEqual(plan.target, { spaceId: space, parentId: parent }, "by default where the database is");
  assert.equal(plan.comments, 1);
  assert.equal(plan.versions, 2);
  assert.deepEqual(
    plan.properties.map((p) => `${p.name}: ${p.text}`),
    ["Tags: heating", "Area: House", "PARA: Resource"],
  );
  // Viewers cannot turn records into pages, nor go to a place they cannot write.
  assert.throws(() => act(ben, { action: "record.toPage", pageId: notes, rowId: rid, spaceId: space, parentId: null }), /Berechtigung/);
  assert.throws(() => recordToPagePlan(ben, notes, rid), /Berechtigung/);
  assert.throws(() => act(anna, { action: "record.toPage", pageId: notes, rowId: rid, spaceId: space, parentId: notes }), /diesen Ort/);

  const moved = act(anna, { action: "record.toPage", pageId: notes, rowId: rid, spaceId: space, parentId: parent });
  const pageId = String(moved.id);
  const page = one<{ title: string; icon: string; cover: string; parent_id: string; kind: string }>("SELECT title,icon,cover,parent_id,kind FROM pages WHERE id=?", pageId)!;
  assert.deepEqual({ ...page }, { title: "Wasser nachfüllen", icon: "drop", cover: "#3366ff", parent_id: parent, kind: "document" });
  const doc = one<{ html: string; generation: string }>("SELECT html,generation FROM documents WHERE page_id=?", pageId)!;
  assert.match(doc.html, /<strong>1,5 bar<\/strong>/);
  assert.equal(doc.generation, "gen-1", "text comments keep their anchors");
  // Properties as a list at the top, with a link to the related record.
  assert.match(doc.html, /^<ul><li><p><strong>Tags:<\/strong> heating<\/p><\/li>/);
  assert.match(doc.html, new RegExp(`<strong>Area:</strong> <a [^>]*href="/#page=${areas}&amp;row=${house}"`));
  const md = (await exportMarkdown(anna, { pageId, format: "markdown", includeSubpages: false })).bytes.toString("utf8");
  assert.match(md, /- \*\*PARA:\*\* Resource/);
  // The page refers to its own copy of the file (image, link, comment and
  // version alike); the original stays with the database, so the record in
  // the trash keeps it. Comments, text comments, versions and favourites follow.
  assert.equal(one<{ page_id: string }>("SELECT page_id FROM files WHERE id=?", fid)!.page_id, notes, "the record's file stays with the database");
  const copy = one<{ id: string; name: string; mime: string; size: number }>("SELECT id,name,mime,size FROM files WHERE page_id=?", pageId);
  assert.ok(copy && copy.id !== fid, "the page gets a copy");
  assert.deepEqual({ name: copy.name, mime: copy.mime, size: copy.size }, { name: "druck.png", mime: "image/png", size: 9 });
  assert.equal(readFileSync(join(uploads, copy.id), "utf8"), "png-bytes");
  assert.doesNotMatch(doc.html, new RegExp(fid));
  assert.match(doc.html, new RegExp(`<img src="/api/files/${copy.id}"`));
  assert.match(doc.html, new RegExp(`<a [^>]*href="/api/files/${copy.id}"[^>]*>druck.png</a>`));
  const comment = one<{ page_id: string; row_id: string | null; body: string }>("SELECT page_id,row_id,body FROM comments WHERE body LIKE 'Jeden Herbst prüfen%'")!;
  assert.deepEqual({ ...comment }, { page_id: pageId, row_id: null, body: `Jeden Herbst prüfen /api/files/${copy.id}` });
  assert.equal(one<{ page_id: string }>("SELECT page_id FROM inline_threads WHERE id=?", thread)!.page_id, pageId);
  assert.equal(all("SELECT 1 FROM snapshots WHERE page_id=? AND html='<p>alt</p>'", pageId).length, 1);
  const version = one<{ html: string; state: Uint8Array }>("SELECT html,state FROM snapshots WHERE page_id=? AND html LIKE '%druck.png%'", pageId)!;
  assert.match(version.html, new RegExp(`href="/api/files/${copy.id}"`));
  assert.ok(Buffer.from(version.state).toString("latin1").includes(copy.id), "the version's state refers to the copy too");
  assert.ok(one("SELECT 1 FROM favorites WHERE user_id=? AND page_id=?", anna.id, pageId));
  // Links point to the page now, from pages and records.
  assert.match(one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", overview)!.html, new RegExp(`href="/#page=${pageId}"`));
  assert.match(one<{ html: string }>("SELECT html FROM row_documents WHERE row_id=?", other)!.html, new RegExp(`href="/#page=${pageId}"`));
  // The record is in the trash and can come back.
  assert.equal(one("SELECT 1 FROM rows WHERE id=?", rid), undefined);
  act(anna, { action: "row.trash.restore", trashId: rid });
  assert.ok(one("SELECT 1 FROM rows WHERE id=? AND page_id=?", rid, notes));
  // Back from the trash, the record still has its file and its original text.
  assert.match(one<{ content: string }>("SELECT content FROM rows WHERE id=?", rid)!.content, new RegExp(`/api/files/${fid}`));
  assert.equal(one<{ page_id: string }>("SELECT page_id FROM files WHERE id=?", fid)!.page_id, notes);
  assert.equal(readFileSync(join(uploads, fid), "utf8"), "png-bytes");

  // Without properties: the content stays as it is; the top of the space works too.
  const plain = make("Ohne Eigenschaften");
  const bare = String(act(anna, { action: "record.toPage", pageId: notes, rowId: plain, spaceId: space, parentId: null, keepProperties: false }).id);
  assert.doesNotMatch(one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", bare)!.html, /PARA/);
  assert.equal(one<{ parent_id: string | null }>("SELECT parent_id FROM pages WHERE id=?", bare)!.parent_id, null);
});
