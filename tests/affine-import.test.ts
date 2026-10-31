// AFFiNE import (#65): the workspace file (SQLite, versions 2 and 1) and
// the snapshot ZIP, built in tests/helpers/affine-fixture.ts the way AFFiNE
// writes them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
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
const { AFFINE_LIMITS } = await import("../lib/importers/affine-read");
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
