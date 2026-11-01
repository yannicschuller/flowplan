// AFFiNE import (#65): the workspace file (SQLite, versions 2 and 1) and
// the snapshot ZIP, built in tests/helpers/affine-fixture.ts the way AFFiNE
// writes them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-affine-"));
const { all, one, run, id } = await import("../lib/db");
const { createWorkspace, createPage } = await import("../lib/seed");
const { bootstrap } = await import("../lib/api");
const { writeZip } = await import("../lib/archive");
const { importFromSource, parseImport, detectSource } = await import("../lib/importers");
const { AFFINE_LIMITS, affineLimitsFor } = await import("../lib/importers/affine-read");
const { keepWorkspacePage } = await import("../lib/importers/affine");
const upload = await import("../lib/importers/upload");
const { saveInstanceSettings } = await import("../lib/instance-settings");
const { setUserLimits } = await import("../lib/user-limits");
const { englishMessage } = await import("../lib/i18n-errors");
const { parseLinkedAttributes } = await import("../lib/linked-views");
const { whiteboardItems } = await import("../lib/whiteboard");
const { affineFileV1, affineFileV2, note, page, para, sqlite, text, PNG } = await import("./helpers/affine-fixture");
const { sampleWorkspace, IDS } = await import("./helpers/affine-sample");

function account(name: string) {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const owner = account("affine-owner");
const wid = createWorkspace(owner.id, "AFFiNE-Import");
const space = bootstrap(owner, wid).spaces[0].id;
type PageRow = { id: string; parent_id: string | null; kind: string; title: string; journal_date: string | null };
const pageByTitle = (title: string) =>
  one<PageRow>("SELECT id,parent_id,kind,title,journal_date FROM pages WHERE workspace_id=? AND title=? AND deleted_at IS NULL ORDER BY rowid DESC LIMIT 1", wid, title)!;
const html = (pageId: string) => one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", pageId)!.html;
const link = (pageId: string) => `/#page=${pageId}`;

test("the formats are recognised", async () => {
  const file = affineFileV2(sampleWorkspace());
  assert.equal(detectSource("Mein Wissen_ws1.affine", file), "affine");
  assert.equal(detectSource("export.db", file), "affine");
  assert.equal(detectSource("export.affine", Buffer.from("SQLite format 3\0" + "x".repeat(200))), "affine");
  const zip = await writeZip(new Map([["Notiz-abc.snapshot.json", Buffer.from("{}")]]));
  const { zipEntries } = await import("../lib/importers");
  assert.equal(detectSource("snapshot.zip", zip, await zipEntries(zip)), "affine");
});

test("workspace file: folders, links, tags, collections, database, files, whiteboards and journal days", async () => {
  // A journal with the second day already written in.
  const journal = createPage(wid, space, owner.id, "Journal", "journal");
  const existingDay = createPage(wid, space, owner.id, "2. Oktober 2026", "document", journal);
  run("UPDATE pages SET journal_date='2026-10-02' WHERE id=?", existingDay);
  const { htmlState } = await import("../lib/document-server");
  run("UPDATE documents SET html=?,state=? WHERE page_id=?", "<p>Schon da</p>", htmlState("<p>Schon da</p>"), existingDay);

  const bytes = affineFileV2(sampleWorkspace());
  const preview = await importFromSource(owner, wid, space, { name: "Mein Wissen_ws1.affine", bytes }, { dryRun: true });
  assert.equal(preview.source, "affine");
  assert.equal(preview.title, "Mein Wissen");
  assert.equal(preview.whiteboards, 2);
  assert.equal(preview.databases, 1);
  assert.equal(preview.journalDays, 2);
  assert.equal(preview.collections, 4);
  assert.equal(preview.files, 2);
  assert.equal(preview.tags, 2);
  // Several top-level items: everything below the workspace page, which is
  // named apart and not counted as a folder (Projekte, Archiv; #77).
  assert.equal(preview.wrapper, "Mein Wissen");
  assert.equal(preview.folders, 2);
  assert.ok(preview.warnings.some((w) => /1 Dokumente im Papierkorb/.test(w)));
  assert.ok(preview.warnings.some((w) => /Elemente auf Whiteboards konnten nicht übernommen werden/.test(w)));
  assert.ok(preview.warnings.some((w) => /HTML-Einbettungen/.test(w)));
  assert.ok(preview.warnings.some((w) => /1 Bilder oder Anhänge fehlen/.test(w)));
  assert.equal(all("SELECT id FROM pages WHERE title='Projektplan'").length, 0, "the preview writes nothing");

  const result = await importFromSource(owner, wid, space, { name: "Mein Wissen_ws1.affine", bytes });
  const root = pageByTitle("Mein Wissen");
  assert.ok(result.rootIds.includes(root.id));
  // Folders as pages, documents in their first folder.
  const projects = pageByTitle("Projekte"),
    archive = pageByTitle("Archiv");
  assert.equal(projects.parent_id, root.id);
  assert.equal(archive.parent_id, projects.id);
  const plan = pageByTitle("Projektplan"),
    notes = pageByTitle("Notizen"),
    sketch = pageByTitle("Skizze");
  assert.equal(plan.parent_id, projects.id);
  assert.equal(notes.parent_id, archive.id);
  assert.equal(sketch.parent_id, root.id, "documents outside folders go below the workspace page");
  assert.ok(html(archive.id).includes(link(plan.id)), "a second folder links to the document");
  assert.match(html(archive.id), /#projekt/);
  assert.equal(all("SELECT id FROM pages WHERE workspace_id=? AND title='Kreis A'", wid).length, 0, "folders in a cycle (not reachable in AFFiNE) are skipped without hanging");
  assert.equal(all("SELECT id FROM pages WHERE workspace_id=? AND title='Weg damit'", wid).length, 0, "the trash stays behind");

  // Rich text, links and tags.
  const planHtml = html(plan.id);
  assert.match(planHtml, /#projekt/);
  assert.match(planHtml, /<h1>Ziele<\/h1>/);
  assert.match(planHtml, /<strong>Fett<\/strong>/);
  assert.match(planHtml, /<em>kursiv<\/em>/);
  assert.match(planHtml, /href="https:\/\/example\.com\/a"/);
  assert.ok(planHtml.includes(`href="${link(notes.id)}"`), "inline reference and linked-doc card point to the page");
  assert.match(planHtml, /data-math="a\^2\+b\^2"/);
  assert.match(planHtml, /color: ?#e03131/);
  assert.match(planHtml, /<mark[^>]*>markiert<\/mark>/);
  assert.match(planHtml, /data-type="taskList"/);
  assert.match(planHtml, /data-checked="true"/);
  assert.match(planHtml, /<details/);
  assert.match(planHtml, /<blockquote>/);
  assert.match(planHtml, /<pre><code class="language-typescript">/);
  assert.match(planHtml, /<hr/);
  assert.match(planHtml, /data-callout="caution"/);
  assert.match(planHtml, /<table/);
  assert.match(planHtml, /<img src="\/api\/files\/[0-9a-f-]{36}"/);
  assert.match(planHtml, /<a href="\/api\/files\/[0-9a-f-]{36}"[^>]*>Bericht\.pdf<\/a>/);
  assert.match(planHtml, /href="https:\/\/example\.org\/artikel"/);
  // Hostile input stays text.
  assert.doesNotMatch(planHtml, /javascript:|<script|<img src=x/);
  assert.match(planHtml, /&lt;img src=x/);
  assert.ok(html(notes.id).includes(`href="${link(plan.id)}"`));
  assert.ok(html(notes.id).includes(`href="${link(sketch.id)}"`), "AFFiNE app links to imported documents point to the page");

  // The database below its document, embedded where it was.
  const db = pageByTitle("Aufgaben");
  assert.equal(db.kind, "database");
  assert.equal(db.parent_id, plan.id);
  const embedded = /data-linked-database="([^"]+)" data-linked-source="([^"]+)" data-linked-views="([^"]+)"/.exec(planHtml);
  assert.ok(embedded, "the document embeds the database");
  assert.equal(embedded![2], db.id);
  const attrs = parseLinkedAttributes({ id: embedded![1], source: embedded![2], version: "1", views: embedded![3].replaceAll("&quot;", '"') });
  assert.equal(attrs.views[0].type, "table");
  const { fields, views } = one<{ fields: string; views: string }>("SELECT fields,views FROM databases WHERE page_id=?", db.id)!;
  const byName = Object.fromEntries((JSON.parse(fields) as { id: string; name: string; type: string; format?: string }[]).map((f) => [f.name, f]));
  assert.equal(byName.Aufgabe.id, "title");
  assert.equal(byName.Stunden.type, "number");
  assert.equal(byName.Status.type, "select");
  assert.equal(byName.Labels.type, "multiselect");
  assert.equal(byName["Fällig"].type, "date");
  assert.equal(byName.Fertig.type, "checkbox");
  assert.equal(byName.Link.type, "url");
  assert.equal(byName.Fortschritt.format, "percent");
  assert.equal(byName.Bild, undefined, "image columns are left out");
  assert.deepEqual((JSON.parse(views) as { type: string }[]).map((v) => v.type), ["table", "board"]);
  const rows = all<{ cells: string; content: string; id: string }>("SELECT id,cells,content FROM rows WHERE page_id=? ORDER BY position", db.id);
  assert.equal(rows.length, 2);
  const first = JSON.parse(rows[0].cells);
  assert.equal(first.title, "Erste Aufgabe");
  assert.equal(first[byName.Stunden.id], 3.5);
  assert.equal(first[byName.Status.id], "Erledigt");
  assert.deepEqual(first[byName.Labels.id], ["A", "B"]);
  assert.equal(first[byName["Fällig"].id], "2026-10-15");
  assert.equal(first[byName.Fertig.id], true);
  assert.equal(first[byName.Link.id], undefined, "javascript: links are dropped");
  assert.equal(first[byName.Fortschritt.id], 0.4);
  assert.match(rows[0].content, /Inhalt der ersten Aufgabe/);
  assert.ok(one("SELECT 1 FROM row_documents WHERE row_id=?", rows[0].id));
  assert.equal(JSON.parse(rows[1].cells)[byName.Link.id], "https://example.com/r2");
  assert.equal(result.rows, 2);

  // Edgeless: a whiteboard next to the document, linked both ways.
  const board = pageByTitle("Skizze – Whiteboard");
  assert.equal(board.kind, "whiteboard");
  assert.equal(board.parent_id, sketch.parent_id);
  assert.ok(html(sketch.id).includes(link(board.id)), "the document links to its whiteboard");
  const state = one<{ state: Uint8Array }>("SELECT state FROM whiteboards WHERE page_id=?", board.id)!.state;
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  const items = whiteboardItems(doc);
  const types = items.map((i) => i.type);
  assert.ok(items.some((i) => i.type === "card" && i.pageId === sketch.id), "a card links back to the document");
  for (const type of ["frame", "shape", "connector", "text", "pen", "image", "sticky"]) assert.ok(types.includes(type as never), type);
  assert.ok(items.some((i) => i.type === "shape" && i.text === "Start <b>" && i.shape === "rounded"));
  const bound = items.find((i) => i.type === "connector" && i.text === "weiter")!;
  const shapeIds = new Set(items.filter((i) => i.type === "shape").map((i) => i.id));
  assert.ok(bound.from?.id && shapeIds.has(bound.from.id) && bound.to?.id && shapeIds.has(bound.to.id), "connectors stay attached");
  assert.equal(bound.route, "elbow");
  assert.ok(items.some((i) => i.type === "sticky" && i.text === "Nur auf dem Whiteboard"));
  assert.ok(items.filter((i) => i.groups?.length).length >= 2, "groups are kept");
  assert.ok(items.some((i) => i.type === "image" && i.src?.startsWith("/api/files/")));
  doc.destroy();
  // A document that opens as edgeless gets a whiteboard even without more.
  assert.equal(pageByTitle("Leinwand – Whiteboard").kind, "whiteboard");

  // Collections: one page each, the documents as of the import.
  const collection = pageByTitle("Sammlung: Wichtig");
  assert.equal(collection.parent_id, projects.id, "a collection in a folder lives there");
  assert.ok(html(collection.id).includes(link(plan.id)) && html(collection.id).includes(link(notes.id)));
  assert.match(html(collection.id), /Tags enthält eines von projekt/);
  assert.ok(html(pageByTitle("Sammlung: Favoriten").id).includes(link(plan.id)));
  const unclear = html(pageByTitle("Sammlung: Unklar").id);
  assert.ok(unclear.includes(link(sketch.id)));
  assert.match(unclear, /Nicht alle Regeln/);
  assert.ok(html(pageByTitle("Sammlung: Alt").id).includes(link(plan.id)), "old filter lists are understood");

  // Journal: a new day, and text appended to the existing one.
  const day1 = one<PageRow>("SELECT id,parent_id,kind,title,journal_date FROM pages WHERE parent_id=? AND journal_date='2026-10-01' AND deleted_at IS NULL", journal)!;
  assert.ok(day1, "the day was created in the journal");
  assert.match(html(day1.id), /Heute: Import gebaut\./);
  const day2 = one<{ html: string; state: Uint8Array }>("SELECT html,state FROM documents WHERE page_id=?", existingDay)!;
  const { stateHtml } = await import("../lib/document-server");
  const ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, day2.state);
  const appended = stateHtml(ydoc);
  ydoc.destroy();
  assert.match(appended, /Schon da/);
  assert.match(appended, /Nachtrag aus AFFiNE/);
  assert.equal(all("SELECT id FROM pages WHERE parent_id=? AND journal_date='2026-10-02' AND deleted_at IS NULL", journal).length, 1, "no second day");
  assert.equal(all("SELECT id FROM pages WHERE title IN ('Tagebuch 1','Oct 1, 2026') AND workspace_id=?", wid).length, 0, "journal documents are no pages of their own");
});

test("documents are their snapshot plus later updates; version 1 files and sub-document guids", async () => {
  const ws = sampleWorkspace();
  // A later edit of the notes document (stored as an update after the snapshot).
  const entry = ws.docs.find((d) => d.id === IDS.notes)!;
  const notesDoc = entry.doc;
  const snapshotDoc = new Y.Doc();
  Y.applyUpdate(snapshotDoc, Y.encodeStateAsUpdate(notesDoc));
  const before = Y.encodeStateVector(notesDoc);
  const blocks = notesDoc.getMap<Y.Map<unknown>>("blocks");
  const noteBlock = [...blocks.values()].find((b) => b.get("sys:flavour") === "affine:note")!;
  const added = new Y.Map<unknown>();
  blocks.set("late", added);
  added.set("sys:id", "late");
  added.set("sys:flavour", "affine:paragraph");
  added.set("sys:children", new Y.Array());
  added.set("prop:type", "text");
  const t = new Y.Text();
  added.set("prop:text", t);
  t.insert(0, "Später ergänzt");
  (noteBlock.get("sys:children") as Y.Array<string>).push(["late"]);
  const update = Y.encodeStateAsUpdate(notesDoc, before);
  // The snapshot is the state before the edit.
  entry.doc = snapshotDoc;
  const tree = await parseImport("x.affine", affineFileV2(ws, { [IDS.notes]: [update] }));
  assert.match(tree.pages.find((p) => p.key === `doc:${IDS.notes}`)!.html, /Später ergänzt/);

  const v1 = await parseImport("old.affine", affineFileV1(sampleWorkspace(), { [IDS.plan]: "guid-of-plan" }));
  const plan = v1.pages.find((p) => p.key === `doc:${IDS.plan}`)!;
  assert.match(plan.html, /<h1>Ziele<\/h1>/, "documents under their sub-document guid are found");
  assert.ok(v1.files.has("blobPng"));
  assert.equal(v1.files.get("blobPng")!.mime, "image/png", "version 1 blobs get their type from the content");
});

test("snapshot ZIP: documents, links, tags from info.json and assets", async () => {
  const snapshot = (id: string, title: string, children: unknown[]) => ({
    type: "page",
    meta: { id, title, createDate: 1, tags: ["t1"] },
    blocks: {
      type: "block",
      id: `${id}-root`,
      flavour: "affine:page",
      props: { title: { "$blocksuite:internal:text$": true, delta: [{ insert: title }] } },
      children: [
        { type: "block", id: `${id}-surface`, flavour: "affine:surface", props: { elements: { "$blocksuite:internal:native$": true, value: {} } }, children: [] },
        { type: "block", id: `${id}-note`, flavour: "affine:note", props: { xywh: "[0,0,800,95]", displayMode: "both" }, children },
      ],
    },
  });
  const para = (delta: unknown[]) => ({ type: "block", id: `p${Math.random()}`, flavour: "affine:paragraph", props: { type: "text", text: { "$blocksuite:internal:text$": true, delta } }, children: [] });
  const zip = await writeZip(
    new Map([
      ["info.json", Buffer.from(JSON.stringify({ type: "info", id: "ws", properties: { tags: { options: [{ id: "t1", value: "aus-zip", color: "x" }] } } }))],
      ["Eins-aaa.snapshot.json", Buffer.from(JSON.stringify(snapshot("aaa", "Eins", [para([{ insert: "Zu " }, { insert: " ", attributes: { reference: { type: "LinkedPage", pageId: "bbb" } } }])])))],
      [
        "Zwei-bbb.snapshot.json",
        Buffer.from(JSON.stringify(snapshot("bbb", "Zwei", [{ type: "block", id: "img", flavour: "affine:image", props: { sourceId: "pic" }, children: [] }, para([{ insert: "x", attributes: { __proto__: { polluted: true } } }])]))),
      ],
      ["assets/pic.png", PNG],
    ]),
  );
  const result = await importFromSource(owner, wid, space, { name: "snapshot.zip", bytes: zip });
  assert.equal(result.source, "affine");
  assert.ok(result.warnings.some((w) => /nur die Arbeitsbereichsdatei/.test(w)));
  const eins = one<{ id: string }>("SELECT id FROM pages WHERE workspace_id=? AND title='Eins' ORDER BY rowid DESC", wid)!;
  const zwei = one<{ id: string }>("SELECT id FROM pages WHERE workspace_id=? AND title='Zwei' ORDER BY rowid DESC", wid)!;
  assert.ok(html(eins.id).includes(link(zwei.id)));
  assert.match(html(eins.id), /#aus-zip/);
  // No empty page named after the file above the documents (#77).
  assert.equal(one<{ parent_id: string | null }>("SELECT parent_id FROM pages WHERE id=?", eins.id)!.parent_id, null);
  assert.equal(one<{ parent_id: string | null }>("SELECT parent_id FROM pages WHERE id=?", zwei.id)!.parent_id, null);
  assert.equal(all("SELECT id FROM pages WHERE workspace_id=? AND title='snapshot'", wid).length, 0);
  assert.equal(result.folders, 0);
  assert.equal(result.wrapper, undefined);
  assert.deepEqual(new Set(result.rootIds), new Set([eins.id, zwei.id]));
  assert.match(html(zwei.id), /<img src="\/api\/files\//);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test("hostile files: not a workspace, views instead of tables, broken and oversized documents", async () => {
  await assert.rejects(parseImport("x.affine", Buffer.from("SQLite format 3\0" + "\0".repeat(500))), /AFFiNE-Datei kann nicht gelesen werden/);
  await assert.rejects(parseImport("x.affine", sqlite("CREATE TABLE notes(id INTEGER);")), /keine AFFiNE-Arbeitsbereichsdatei/);
  // A view never runs: only real tables count.
  const view = sqlite(`
    CREATE TABLE "meta" (space_id VARCHAR);
    CREATE TABLE "snapshots" (doc_id VARCHAR, data BLOB, updated_at TIMESTAMP);
    CREATE TABLE "blobs" (key VARCHAR, data BLOB, mime VARCHAR, deleted_at TIMESTAMP);
    CREATE VIEW "updates" AS WITH RECURSIVE r(doc_id, created_at, data) AS (SELECT 'a', 0, x'00' UNION ALL SELECT doc_id, created_at + 1, data FROM r) SELECT * FROM r;
  `);
  await assert.rejects(parseImport("x.affine", view), /keine AFFiNE-Arbeitsbereichsdatei/);

  // A document with broken Yjs data is skipped, the others come along.
  const ws = sampleWorkspace();
  ws.docs = ws.docs.filter((d) => d.id === IDS.notes || d.id === IDS.plan);
  ws.docs.push({ id: "broken", title: "Kaputt", doc: page("x", "x", [note([para("x")])]) });
  ws.extra = { broken: new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x01, 0x02]) };
  const file = affineFileV2(ws);
  const tree = await parseImport("x.affine", file);
  assert.ok(tree.pages.some((p) => p.key === `doc:${IDS.plan}` && /Ziele/.test(p.html)));
  assert.ok(tree.warnings.some((w) => /konnte nicht gelesen werden|ohne Inhalt/.test(w)));

  // Oversized documents are never read.
  const limit = AFFINE_LIMITS.docBytes;
  AFFINE_LIMITS.docBytes = Y.encodeStateAsUpdate(ws.docs.find((d) => d.id === IDS.plan)!.doc).length - 1;
  try {
    const small = await parseImport("x.affine", file);
    assert.ok(small.pages.some((p) => p.key === `doc:${IDS.plan}` && p.html === ""), "too large: title only");
  } finally {
    AFFINE_LIMITS.docBytes = limit;
  }

  // Deeply nested blocks and hostile keys stay harmless.
  let deep = para("Boden");
  for (let i = 0; i < 200; i++) deep = { ...para(`Ebene ${i}`), children: [deep] };
  const nested = sampleWorkspace();
  nested.docs = [{ id: "deep", title: "Tief", doc: page("deep", "Tief", [note([deep, { id: "evil", flavour: "affine:paragraph", props: { type: "h1\"><script>", text: text("x") } }])]) }];
  const deepTree = await parseImport("x.affine", affineFileV2(nested));
  const deepHtml = deepTree.pages.find((p) => p.key === "doc:deep")!.html;
  assert.doesNotMatch(deepHtml, /<script/);
  assert.match(deepHtml, /Ebene 199/);
});

test("the workspace page only when it carries structure (#77)", async () => {
  const ROOT = "affine:root";
  assert.equal(keepWorkspacePage("snapshot", [{ parent: ROOT }, { parent: ROOT }]), false, "a snapshot never gets one");
  assert.equal(keepWorkspacePage("sqlite-v2", [{ parent: ROOT }]), false, "one item at the top");
  assert.equal(keepWorkspacePage("sqlite-v2", [{ parent: ROOT }, { parent: ROOT, kind: "whiteboard" }]), false, "a whiteboard belongs to its document");
  assert.equal(keepWorkspacePage("sqlite-v2", [{ parent: ROOT }, { parent: "folder:x" }, { parent: null }]), false, "journal days and nested pages do not count");
  assert.equal(keepWorkspacePage("sqlite-v1", [{ parent: ROOT }, { parent: ROOT }]), true);

  // A workspace file with a single document (and its whiteboard): straight
  // into the space.
  const ws = sampleWorkspace();
  ws.docs = ws.docs.filter((d) => d.id === IDS.sketch);
  ws.folders = [];
  ws.collections = [];
  ws.docProperties = {};
  const bytes = affineFileV2(ws);
  const tree = await parseImport("Einzeln.affine", bytes);
  assert.ok(!tree.pages.some((p) => p.key === ROOT));
  assert.equal(tree.pages.find((p) => p.key === `doc:${IDS.sketch}`)!.parent, null);
  const preview = await importFromSource(owner, wid, space, { name: "Einzeln.affine", bytes }, { dryRun: true });
  assert.equal(preview.folders, 0);
  assert.equal(preview.wrapper, undefined);
  const result = await importFromSource(owner, wid, space, { name: "Einzeln.affine", bytes });
  const sketch = one<PageRow>("SELECT id,parent_id,kind,title,journal_date FROM pages WHERE id IN (" + result.rootIds.map(() => "?").join(",") + ") AND kind='document'", ...result.rootIds)!;
  assert.equal(sketch.title, "Skizze");
  assert.equal(sketch.parent_id, null, "no empty page above the document");
  assert.equal(all("SELECT id FROM pages WHERE workspace_id=? AND title='Mein Wissen' AND id IN (" + result.rootIds.map(() => "?").join(",") + ")", wid, ...result.rootIds).length, 0);
  const board = one<PageRow>("SELECT id,parent_id,kind,title,journal_date FROM pages WHERE workspace_id=? AND title='Skizze – Whiteboard' ORDER BY rowid DESC", wid)!;
  assert.equal(board.parent_id, null, "the whiteboard sits next to its document");

  // Database mode is unchanged by it.
  const asDb = await importFromSource(owner, wid, space, { name: "Einzeln.affine", bytes }, { mode: "database" });
  assert.equal(asDb.rows, 1);
});

test("the import limit follows the upload limit, at least 100 MB; FLOWPLAN_IMPORT_MAX_MB replaces it (#76)", () => {
  assert.equal(upload.importLimitMb(10, null), 100);
  assert.equal(upload.importLimitMb(100, null), 100);
  assert.equal(upload.importLimitMb(512, null), 512);
  assert.equal(upload.importLimitMb(512, 300), 300);
  assert.equal(upload.importLimitMb(10, 50), 50, "the variable may also lower it");
  assert.equal(upload.importEnvMb(undefined), null);
  assert.equal(upload.importEnvMb(""), null);
  assert.equal(upload.importEnvMb("abc"), null);
  assert.equal(upload.importEnvMb("0"), null);
  assert.equal(upload.importEnvMb("1.5"), null);
  assert.equal(upload.importEnvMb(" 250 "), 250);
  assert.equal(upload.importEnvMb("999999"), 20480);

  const person = account("affine-limits");
  const admin = { ...account("affine-admin"), isAdmin: true };
  const env = process.env.FLOWPLAN_IMPORT_MAX_MB;
  delete process.env.FLOWPLAN_IMPORT_MAX_MB;
  try {
    saveInstanceSettings({ maxUploadMb: 10 });
    assert.equal(upload.importLimitFor(person), 100);
    saveInstanceSettings({ maxUploadMb: 400 });
    assert.equal(upload.importLimitFor(person), 400, "raising the upload limit raises the import limit");
    assert.equal(upload.importLimitFor(admin), 400);
    setUserLimits(person.id, { uploadMb: 600 });
    assert.equal(upload.importLimitFor(person), 600, "a person's own upload limit counts");
    process.env.FLOWPLAN_IMPORT_MAX_MB = "250";
    assert.equal(upload.importLimitFor(person), 250);
  } finally {
    if (env === undefined) delete process.env.FLOWPLAN_IMPORT_MAX_MB;
    else process.env.FLOWPLAN_IMPORT_MAX_MB = env;
    saveInstanceSettings({ maxUploadMb: 10 });
  }
  // The refusal names the limit and where to change it, in every language.
  const refusal = upload.importTooLarge(512, null);
  assert.equal(refusal.status, 413);
  assert.match(refusal.message, /512 MB.*Administration → Grenzen & Aufbewahrung/);
  assert.match(englishMessage(refusal.message), /512 MB.*Largest upload.*Administration → Limits & retention/);
  assert.match(englishMessage(upload.importTooLarge(300, 300).message), /300 MB \(FLOWPLAN_IMPORT_MAX_MB\)/);

  // Internal limits grow with the file, never below their base values.
  assert.deepEqual(affineLimitsFor(1000), { totalDocBytes: AFFINE_LIMITS.totalDocBytes, blobBytes: AFFINE_LIMITS.blobBytes });
  const big = affineLimitsFor(600 * 1024 * 1024);
  assert.equal(big.totalDocBytes, 600 * 1024 * 1024);
  assert.equal(big.blobBytes, 600 * 1024 * 1024);
  assert.equal(affineLimitsFor(5000 * 1024 * 1024).totalDocBytes, 1024 * 1024 * 1024, "documents in memory stay below 1 GB");
});

test("large uploads: streamed to disk, the workspace file read in place, files read when written (#76)", async () => {
  const stream = (...chunks: Buffer[]) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk));
        controller.close();
      },
    });
  const ws = sampleWorkspace();
  const big = Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024, 7)]);
  ws.blobs = [...(ws.blobs || []), { key: "bigPng", data: big, mime: "image/png" }];
  const planDoc = ws.docs.find((d) => d.id === IDS.plan)!;
  planDoc.doc = page(IDS.plan, "Projektplan", [note([para("Groß"), { id: "bigImg", flavour: "affine:image", props: { sourceId: "bigPng", caption: "Groß" } }])]);
  const bytes = affineFileV2(ws);

  // Refused beyond the limit; nothing stays behind.
  const tooLarge = () => upload.importTooLarge(1, null);
  await assert.rejects(upload.saveImportUpload(owner.id, stream(bytes, Buffer.alloc(1024 * 1024)), bytes.length, tooLarge), /höchstens 1 MB/);
  const dir = join(process.env.FLOWPLAN_DATA_DIR!, "tmp", "imports");
  assert.deepEqual(existsSync(dir) ? readdirSync(dir) : [], []);

  const saved = await upload.saveImportUpload(owner.id, stream(bytes.subarray(0, 1000), bytes.subarray(1000)), bytes.length, tooLarge);
  assert.equal(saved.size, bytes.length);
  // Only its owner can name it again.
  assert.equal(upload.importUploadPath(owner.id, saved.id), saved.path);
  const other = account("affine-other");
  assert.throws(() => upload.importUploadPath(other.id, saved.id), /nicht mehr vorhanden/);
  assert.throws(() => upload.importUploadPath(owner.id, "../../etc"), /Ungültige Eingabe/);

  // Read from disk: files are not in memory, only read when written.
  const tree = await parseImport("Gross.affine", { path: saved.path });
  const file = tree.files.get("bigPng")!;
  assert.ok(file && !("data" in file) && "read" in file, "files of a workspace on disk are read lazily");
  assert.equal(file.size, big.length);
  assert.equal(file.mime, "image/png");
  tree.close?.();

  const preview = await importFromSource(owner, wid, space, { name: "Gross.affine", path: saved.path }, { dryRun: true });
  assert.ok(preview.bytes >= big.length);
  const result = await importFromSource(owner, wid, space, { name: "Gross.affine", path: saved.path });
  assert.equal(result.files, preview.files);
  const stored = one<{ id: string; size: number }>("SELECT f.id,f.size FROM files f JOIN pages p ON p.id=f.page_id WHERE p.workspace_id=? AND f.size=?", wid, big.length);
  assert.ok(stored, "the large file was written");
  const { readFileSync } = await import("node:fs");
  assert.ok(readFileSync(join(process.env.FLOWPLAN_DATA_DIR!, "uploads", stored!.id)).equals(big));
  // The workspace file was closed after the import; the upload goes.
  upload.discardImportUpload(owner.id, saved.id);
  assert.ok(!existsSync(saved.path));

  // Other exports from disk stay within the ZIP limit (a sparse file).
  const zipDir = mkdtempSync(join(tmpdir(), "flowplan-bigzip-"));
  try {
    const zipPath = join(zipDir, "big.zip");
    writeFileSync(zipPath, Buffer.from("PK\u0003\u0004"));
    truncateSync(zipPath, 101 * 1024 * 1024);
    await assert.rejects(parseImport("big.zip", { path: zipPath }), /höchstens 100 MB/);
  } finally {
    rmSync(zipDir, { recursive: true, force: true });
  }

  // Uploads that were never imported go after six hours.
  const old = await upload.saveImportUpload(owner.id, stream(Buffer.from("x")), 10, tooLarge);
  const folder = join(dir, readdirSync(dir).find((n) => n.endsWith(old.id))!);
  utimesSync(folder, new Date(Date.now() - 7 * 3600e3), new Date(Date.now() - 7 * 3600e3));
  upload.sweepImportUploads();
  assert.ok(!existsSync(old.path));
});
