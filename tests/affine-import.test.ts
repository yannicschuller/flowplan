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
const { keepWorkspacePage, rowDocRef } = await import("../lib/importers/affine");
const upload = await import("../lib/importers/upload");
const { saveInstanceSettings } = await import("../lib/instance-settings");
const { setUserLimits } = await import("../lib/user-limits");
const { englishMessage } = await import("../lib/i18n-errors");
const { parseLinkedAttributes } = await import("../lib/linked-views");
const { whiteboardItems } = await import("../lib/whiteboard");
const { portableMeta } = await import("../lib/page-properties-server");
const { affineFileV1, affineFileV2, note, page, para, sqlite, text, uid, PNG, PDF } = await import("./helpers/affine-fixture");
import type { BlockSpec, Workspace } from "./helpers/affine-fixture";
const { readAffineFile } = await import("../lib/importers/affine-read");
const { importZip } = await import("../lib/zip-import");
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
// The names of a page's tags (#70: importers set real tags).
const tagsOf = (pageId: string) =>
  all<{ name: string }>("SELECT t.name FROM page_tag_links l JOIN page_tags t ON t.id=l.tag_id WHERE l.page_id=? ORDER BY l.position", pageId).map((t) => t.name);


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
  assert.equal(preview.files, 5);
  assert.equal(preview.tags, 2);
  // Properties of documents and emoji icons (#82).
  assert.equal(preview.properties, 4);
  assert.equal(preview.icons, 3);
  assert.ok(preview.warnings.some((w) => /1 Symbole aus AFFiNEs Symbolbibliothek/.test(w)));
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
  assert.ok(tagsOf(plan.id).includes("projekt"));
  assert.doesNotMatch(planHtml, /#projekt/);
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
  // Its emoji is the callout's own symbol (issue #72).
  assert.match(planHtml, /data-callout="caution" data-callout-icon="💡"/);
  assert.match(planHtml, /<table/);
  assert.match(planHtml, /<img src="\/api\/files\/[0-9a-f-]{36}"/);
  assert.match(planHtml, /<a href="\/api\/files\/[0-9a-f-]{36}"[^>]*>Bericht\.pdf<\/a>/);
  // Attachments are the blocks an upload in the editor creates (#82): the
  // PDF with its preview, audio and video with a player, others a link.
  assert.match(planHtml, /<div data-pdf="\/api\/files\/[0-9a-f-]{36}" data-title="Bericht\.pdf"/);
  assert.match(planHtml, /<audio src="\/api\/files\/[0-9a-f-]{36}" controls/);
  assert.match(planHtml, /<video src="\/api\/files\/[0-9a-f-]{36}" controls/);
  assert.match(planHtml, /<p><a href="\/api\/files\/[0-9a-f-]{36}"[^>]*>Daten\.zip<\/a><\/p>/);
  assert.match(planHtml, /<p>Fehlt\.pdf<\/p>/, "a missing file stays its name");
  assert.doesNotMatch(planHtml, /data-import-file|fp-import:/);
  {
    // As the editor reads them: media nodes, like an upload.
    const { htmlState } = await import("../lib/document-server");
    const state = new Y.Doc();
    Y.applyUpdate(state, htmlState(planHtml));
    const kinds = state.getXmlFragment("default").toString();
    state.destroy();
    for (const kind of ["pdf", "audio", "video"]) assert.match(kinds, new RegExp(`kind="${kind}"`), kind);
    const mimes = all<{ name: string; mime: string }>("SELECT name,mime FROM files WHERE page_id=? ORDER BY name", plan.id);
    assert.deepEqual(
      mimes.filter((f) => /Bericht|Ton|Film/.test(f.name)).map((f) => f.mime),
      ["application/pdf", "video/mp4", "audio/mpeg"],
    );
  }
  // Icons: an emoji of a document, folder or collection; never anything else.
  const iconOf = (pageId: string) => one<{ icon: string }>("SELECT icon FROM pages WHERE id=?", pageId)!.icon;
  assert.equal(iconOf(plan.id), "🚀");
  assert.equal(iconOf(projects.id), "📁");
  assert.equal(iconOf(pageByTitle("Sammlung: Wichtig").id), "⭐");
  // Otherwise the default icon of a new page.
  assert.equal(iconOf(notes.id), iconOf(archive.id), "AFFiNE's own symbols have no counterpart");
  assert.equal(iconOf(sketch.id), iconOf(archive.id), "no links as icons");
  // Properties as page properties (#70) with their types.
  const meta = portableMeta(plan.id)!;
  const props = Object.fromEntries((meta.properties || []).map((p) => [p.name, { type: p.type, value: p.value }]));
  assert.deepEqual(props.Phase, { type: "text", value: "Planung" });
  assert.deepEqual(props.Budget, { type: "number", value: 1200.5 });
  assert.deepEqual(props.Freigegeben, { type: "checkbox", value: true });
  assert.deepEqual(props.Abgabe, { type: "date", value: "2026-12-01" });
  assert.equal(props["Gelöscht"], undefined, "deleted properties stay behind");
  assert.equal(props.Termin, undefined, "a date that is none is left out");
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
  // The columns in AFFiNE's order, not the order of creation (#82): the
  // view's, then the others in the database's order; hidden ones and
  // widths kept (within Flowplan's 80–800 px).
  const viewList = JSON.parse(views) as { fieldOrder?: string[]; hiddenFields?: string[]; columnWidths?: Record<string, number> }[];
  const named = (ids: string[] = []) => ids.map((fid) => (JSON.parse(fields) as { id: string; name: string }[]).find((f) => f.id === fid)!.name);
  assert.deepEqual(named(viewList[0].fieldOrder), ["Status", "Aufgabe", "Stunden", "Notiz", "Labels", "Fällig", "Fertig", "Link", "Fortschritt"]);
  assert.deepEqual(named(viewList[0].hiddenFields), ["Stunden"]);
  assert.deepEqual(viewList[0].columnWidths, { [byName.Status.id]: 240, title: 320, [byName.Stunden.id]: 100, [byName.Notiz.id]: 800 });
  assert.deepEqual(
    (JSON.parse(fields) as { name: string }[]).map((f) => f.name),
    ["Aufgabe", "Status", "Stunden", "Notiz", "Labels", "Fällig", "Fertig", "Link", "Fortschritt"],
    "the title first, the others in the view's order",
  );
  assert.deepEqual(named(viewList[1].fieldOrder).slice(0, 2), ["Fällig", "Labels"]);
  assert.deepEqual(named(viewList[1].hiddenFields), ["Labels"]);
  assert.equal(viewList[1].columnWidths, undefined);
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
  assert.ok(tagsOf(eins.id).includes("aus-zip"));
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

// A snapshot ZIP as AFFiNE writes it (blocksuite/affine/widgets/linked-doc/
// src/transformers/zip.ts): "<title>-<id>.snapshot.json" per document,
// "assets/<blob id>.<ext>" (a blob id with "/" makes a sub-folder), before
// 2025 an info.json with the workspace's tags.
function snapshotDoc(id: string, title: string, children: unknown[], tags: string[] = []) {
  return {
    type: "page",
    meta: { id, title, createDate: 1717384163413, tags },
    blocks: {
      type: "block",
      id: `${id}-root`,
      flavour: "affine:page",
      version: 2,
      props: { title: { "$blocksuite:internal:text$": true, delta: [{ insert: title }] } },
      children: [
        { type: "block", id: `${id}-surface`, flavour: "affine:surface", version: 5, props: { elements: {} }, children: [] },
        { type: "block", id: `${id}-note`, flavour: "affine:note", version: 1, props: { xywh: "[0,0,800,95]", displayMode: "both" }, children },
      ],
    },
  };
}

test("snapshot ZIP: attachments as blocks, nested assets, tag colours; what only the workspace file has is named (#82)", async () => {
  const children = [
    { type: "block", id: "img", flavour: "affine:image", version: 1, props: { sourceId: "FwBs2WApEGkiFmu1XR4fHZ/7fOlSsSBdYEyGs2lDeLk=", caption: "Bild" }, children: [] },
    { type: "block", id: "att", flavour: "affine:attachment", version: 1, props: { sourceId: "pdf-1", name: "Vertrag.pdf", type: "application/pdf", size: PDF.length, embed: false }, children: [] },
  ];
  const info = {
    type: "info",
    id: "9d803d4f",
    pageVersion: 2,
    workspaceVersion: 2,
    properties: { tags: { options: [{ id: "IFKrGsidLRHUP0TOoQMo4", value: "WebClips", color: "var(--affine-palette-line-magenta)", createDate: 1, updateDate: 1 }] } },
  };
  const old = await writeZip(
    new Map([
      ["info.json", Buffer.from(JSON.stringify(info))],
      ["Alt-oldDoc1.snapshot.json", Buffer.from(JSON.stringify(snapshotDoc("oldDoc1", "Alter Snapshot", children, ["IFKrGsidLRHUP0TOoQMo4"])))],
      ["assets/FwBs2WApEGkiFmu1XR4fHZ/7fOlSsSBdYEyGs2lDeLk=.png", PNG],
      ["assets/pdf-1.pdf", PDF],
    ]),
  );
  const preview = await importFromSource(owner, wid, space, { name: "alt.zip", bytes: old }, { dryRun: true });
  assert.equal(preview.files, 2, "a blob id with a slash is found in its sub-folder");
  assert.equal(preview.tags, 1);
  assert.ok(preview.warnings.some((w) => /^Ordner, Sammlungen, Journale, Eigenschaften und Symbole von Dokumenten enthält nur die Arbeitsbereichsdatei/.test(w)));
  await importFromSource(owner, wid, space, { name: "alt.zip", bytes: old });
  const doc = pageByTitle("Alter Snapshot");
  assert.match(html(doc.id), /<img src="\/api\/files\//);
  assert.match(html(doc.id), /<div data-pdf="\/api\/files\/[0-9a-f-]{36}" data-title="Vertrag\.pdf"/);
  assert.deepEqual(tagsOf(doc.id), ["WebClips"]);
  assert.equal(one<{ color: string }>("SELECT color FROM page_tags WHERE workspace_id=? AND name='WebClips'", wid)!.color, "purple", "the tag keeps its colour");

  // Since 2025 a snapshot has no tags (meta.tags is empty, no info.json):
  // the preview says where they are.
  const current = await writeZip(new Map([["Neu-newDoc1.snapshot.json", Buffer.from(JSON.stringify(snapshotDoc("newDoc1", "Neuer Snapshot", [])))]]));
  const tree = await parseImport("neu.zip", current);
  const warning = tree.warnings.find((w) => /^Tags, Ordner/.test(w))!;
  assert.ok(warning);
  assert.match(englishMessage(warning), /^Only the workspace file \(\.affine\) contains tags, folders, collections, journals, properties and icons of documents/);
});

test("more than 500 documents; the limit is the instance's and named (#82)", async () => {
  const many = sampleWorkspace();
  many.folders = [];
  many.collections = [];
  many.docProperties = {};
  many.docs = Array.from({ length: 520 }, (_, i) => ({ id: `many${i}`, title: `Viele ${i}`, doc: page(`many${i}`, `Viele ${i}`, [note([para(`Text ${i}`)])]) }));
  const bytes = affineFileV2(many);
  // By default far more than 500 (10,000).
  const preview = await importFromSource(owner, wid, space, { name: "Viele.affine", bytes }, { dryRun: true });
  assert.equal(preview.pages, 520);
  assert.equal(preview.tooMany, undefined);
  const result = await importFromSource(owner, wid, space, { name: "Viele.affine", bytes });
  assert.equal(result.pages, 520);
  const wrapper = pageByTitle("Mein Wissen");
  assert.equal(Number(one<{ n: number }>("SELECT COUNT(*) n FROM pages WHERE parent_id=? AND title LIKE 'Viele %'", wrapper.id)!.n), 520);
  assert.match(html(pageByTitle("Viele 519").id), /Text 519/);

  // A lower limit: the preview counts and names the setting, the import is
  // refused; nothing was converted.
  process.env.FLOWPLAN_IMPORT_MAX_DOCS = "100";
  try {
    const tree = await parseImport("Viele.affine", bytes);
    assert.equal(tree.tooMany, true);
    assert.ok(tree.pages.every((p) => p.html === ""));
    const limited = await importFromSource(owner, wid, space, { name: "Viele.affine", bytes }, { dryRun: true });
    assert.equal(limited.pages, 520, "the preview shows how many there are");
    assert.equal(limited.tooMany, true);
    const message = limited.warnings[0];
    assert.match(message, /520 Seiten; erlaubt sind höchstens 100 je Import \(FLOWPLAN_IMPORT_MAX_DOCS\)/);
    assert.equal(englishMessage(message), "The file makes 520 pages; at most 100 are allowed per import (FLOWPLAN_IMPORT_MAX_DOCS).");
    const before = Number(one<{ n: number }>("SELECT COUNT(*) n FROM pages")!.n);
    await assert.rejects(importFromSource(owner, wid, space, { name: "Viele.affine", bytes }), (e: { status?: number; message: string }) => e.status === 413 && /FLOWPLAN_IMPORT_MAX_DOCS/.test(e.message));
    await assert.rejects(importFromSource(owner, wid, space, { name: "Viele.affine", bytes }, { mode: "database" }), /520 Einträge; erlaubt sind höchstens 100/);
    assert.equal(Number(one<{ n: number }>("SELECT COUNT(*) n FROM pages")!.n), before);
    // Folders, databases and whiteboards count as pages too.
    process.env.FLOWPLAN_IMPORT_MAX_DOCS = "12";
    const sample = await importFromSource(owner, wid, space, { name: "Probe.affine", bytes: affineFileV2(sampleWorkspace()) }, { dryRun: true });
    assert.equal(sample.tooMany, true);
    assert.ok(sample.pages < 12, "fewer documents than the limit, but more pages");
    // The Markdown/Notion import shares the limit.
    const md = await writeZip(new Map(Array.from({ length: 13 }, (_, i) => [`Seite ${i}.md`, Buffer.from(`# Seite ${i}`)] as [string, Buffer])));
    await assert.rejects(importZip(owner, wid, space, md), /13 Seiten; erlaubt sind höchstens 12 je Import \(FLOWPLAN_IMPORT_MAX_DOCS\)/);
  } finally {
    delete process.env.FLOWPLAN_IMPORT_MAX_DOCS;
  }
  // Files above their limit stay behind, and the preview names it.
  process.env.FLOWPLAN_IMPORT_MAX_FILES = "2";
  try {
    const files = await importFromSource(owner, wid, space, { name: "Probe.affine", bytes: affineFileV2(sampleWorkspace()) }, { dryRun: true });
    const note = files.warnings.find((w) => /FLOWPLAN_IMPORT_MAX_FILES/.test(w))!;
    assert.match(note, /^3 Dateien über der Grenze von 2 je Import werden nicht übernommen/);
    assert.match(englishMessage(note), /^3 files above the limit of 2 per import are not imported \(FLOWPLAN_IMPORT_MAX_FILES\)\.$/);
  } finally {
    delete process.env.FLOWPLAN_IMPORT_MAX_FILES;
  }
  // Invalid values fall back to the defaults.
  const { maxImportPages, maxImportFiles } = await import("../lib/importers/types");
  assert.equal(maxImportPages(undefined), 10000);
  assert.equal(maxImportPages("abc"), 10000);
  assert.equal(maxImportPages("0"), 10000);
  assert.equal(maxImportPages(" 50000 "), 50000);
  assert.equal(maxImportFiles(undefined), 20000);
});

test("a workspace on disk: documents are read one at a time, when converted (#82)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "flowplan-affine-lazy-"));
  try {
    const path = join(dir, "ws.affine");
    writeFileSync(path, affineFileV2(sampleWorkspace()));
    const ws = readAffineFile(path, "x");
    const plan = ws.docs.find((d) => d.id === IDS.plan)!;
    const first = plan.load();
    assert.ok(first && plan.load() !== first, "read again on every load, never kept");
    ws.close!();
    assert.equal(plan.load(), null, "read from the file, not from memory");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("older workspaces: properties in the root document; deep folders (#82)", async () => {
  const ws = sampleWorkspace();
  ws.docs = ws.docs.filter((d) => d.id === IDS.plan || d.id === IDS.notes);
  ws.collections = [];
  ws.docProperties = {};
  ws.propertyInfo = undefined;
  ws.icons = undefined;
  ws.legacyProperties = {
    schema: { pageProperties: { custom: { lp1: { id: "lp1", name: "Kunde", source: "custom", type: "text", icon: "", order: 1 }, lp2: { id: "lp2", name: "Stunden", source: "custom", type: "number", icon: "", order: 2 } } } },
    pageProperties: { [IDS.notes]: { custom: { lp1: { id: "lp1", visibility: "visible", value: "ACME", order: "a0" }, lp2: { id: "lp2", visibility: "visible", value: 7, order: "a1" } }, system: {} } },
  };
  // 60 folders inside each other, the notes in the deepest.
  ws.folders = Array.from({ length: 60 }, (_, i) => ({ id: `deep${i}`, parentId: i ? `deep${i - 1}` : null, type: "folder", data: `Ebene ${i}`, index: "a0" }));
  ws.folders.push({ id: "deepDoc", parentId: "deep59", type: "doc", data: IDS.notes, index: "a0" });
  const tree = await parseImport("Alt.affine", affineFileV2(ws));
  const notes = tree.pages.find((p) => p.key === `doc:${IDS.notes}`)!;
  assert.deepEqual(notes.properties, { Kunde: "ACME", Stunden: 7 });
  assert.ok(tree.warnings.some((w) => /Ordner tiefer als 50 Ebenen werden zusammengefasst/.test(w)));
  assert.equal(tree.pages.filter((p) => p.key.startsWith("folder:deep")).length, 50);
  assert.equal(notes.parent, "folder:deep49", "the document stays in the deepest folder taken over");
});

const boardDoc = (pageId: string) => {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, one<{ state: Uint8Array }>("SELECT state FROM whiteboards WHERE page_id=?", pageId)!.state);
  return doc;
};
// A database row turned into a document of its own (#82): its title is a
// reference ({type: "LinkedPage", pageId}), or its content a doc card.
function rowDocsWorkspace(): Workspace {
  const ref = (pageId: string) => ({ insert: " ", attributes: { reference: { type: "LinkedPage", pageId } } });
  const database: BlockSpec = {
    id: "rdDb",
    flavour: "affine:database",
    props: {
      title: text("Angebote"),
      views: [{ id: "rv1", name: "Alle", mode: "table", columns: [] }],
      columns: [
        { id: "kTitle", type: "title", name: "Angebot", data: {} },
        { id: "kTags", type: "multi-select", name: "Tags", data: { options: [{ id: "x1", value: "Alt" }] } },
        { id: "kKunde", type: "rich-text", name: "Kunde", data: {} },
        { id: "kOk", type: "checkbox", name: "Fertig", data: {} },
      ],
      cells: { rowA: { kOk: { columnId: "kOk", value: true } }, rowD: { kKunde: { columnId: "kKunde", value: text("Aus der Zelle") } } },
    },
    children: [
      { id: "rowA", flavour: "affine:paragraph", props: { type: "text", text: text([ref("rdA")]) } },
      { id: "rowB", flavour: "affine:paragraph", props: { type: "text", text: text([ref("rdA")]) }, children: [para("Eigene Notiz von B")] },
      { id: "rowC", flavour: "affine:paragraph", props: { type: "text", text: text("Mit Karte") }, children: [{ id: "cardC", flavour: "affine:embed-synced-doc", props: { pageId: "rdC" } }] },
      { id: "rowD", flavour: "affine:paragraph", props: { type: "text", text: text([{ insert: "Vorgang " }, ref("rdD")]) } },
      { id: "rowJ", flavour: "affine:paragraph", props: { type: "text", text: text([ref("rdDay")]) } },
      { id: "rowS", flavour: "affine:paragraph", props: { type: "text", text: text([ref("rdHome")]) } },
    ],
  };
  const nested: BlockSpec = {
    id: "rdNested",
    flavour: "affine:database",
    props: { title: text("Positionen"), views: [], columns: [{ id: "nTitle", type: "title", name: "Position", data: {} }], cells: {} },
    children: [{ id: "nRow", flavour: "affine:paragraph", props: { type: "text", text: text("Beratung") } }],
  };
  return {
    id: "rdWs",
    name: "Zeilen-Dokumente",
    docs: [
      { id: "rdHome", title: "Vertrieb", doc: page("rdHome", "Vertrieb", [note([para("Alle Angebote:"), database])]) },
      {
        id: "rdA",
        title: "Angebot ACME",
        tags: ["tg1"],
        doc: page("rdA", "Angebot ACME", [
          note([para("Inhalt von A"), { id: uid(), flavour: "affine:image", props: { sourceId: "rdPng" } }, para([{ insert: "siehe " }, ref("rdC")]), nested]),
        ]),
      },
      { id: "rdC", title: "Karte C", doc: page("rdC", "Karte C", [note([para("Inhalt von C")])]) },
      { id: "rdD", title: "Dokument D", tags: ["tg2"], doc: page("rdD", "Dokument D", [note([para("Inhalt von D")])]) },
      { id: "rdDay", title: "Tag", doc: page("rdDay", "Tag", [note([para("Am Tag")])]) },
      { id: "rdOver", title: "Übersicht Angebote", doc: page("rdOver", "Übersicht Angebote", [note([para([{ insert: "Zu " }, ref("rdA")]), { id: uid(), flavour: "affine:embed-linked-doc", props: { pageId: "rdD" } }])]) },
    ],
    tags: [
      { id: "tg1", value: "Wichtig" },
      { id: "tg2", value: "Neu" },
    ],
    folders: [
      { id: "rdF", parentId: null, type: "folder", data: "Kunden", index: "a0" },
      { id: "rdF-a", parentId: "rdF", type: "doc", data: "rdA", index: "a0" },
      { id: "rdF-o", parentId: "rdF", type: "doc", data: "rdOver", index: "a1" },
    ],
    docProperties: { rdA: { "custom:pK": "ACME", "custom:pB": "1200", primaryMode: "edgeless" }, rdD: { "custom:pK": "Aus dem Dokument" }, rdDay: { journal: "2026-10-05" } },
    propertyInfo: { pK: { name: "Kunde", type: "text" }, pB: { name: "Budget", type: "number" } },
    icons: { "doc:rdA": { type: "emoji", unicode: "💼" } },
    blobs: [{ key: "rdPng", data: PNG, mime: "image/png" }],
  };
}

test("documents made from database rows become the record's content (#82)", async () => {
  const { AText } = await import("../lib/importers/affine-read");
  const row = (delta: { insert: string; attributes?: Record<string, unknown> }[], children: { id: string; flavour: string; props: Record<string, unknown>; children: [] }[] = []) =>
    rowDocRef({ id: "r", flavour: "affine:paragraph", props: { text: new AText(delta) }, children });
  const r = (pageId: string) => ({ insert: " ", attributes: { reference: { type: "LinkedPage", pageId } } });
  assert.equal(row([{ insert: "Nur Text" }]), null);
  assert.equal(row([r("x")])!.pageId, "x");
  assert.equal(row([r("x"), { insert: " und " }, r("y")]), null, "a title naming two documents names none");
  assert.equal(row([{ insert: "A" }], [{ id: "k", flavour: "affine:embed-linked-doc", props: { pageId: "z" }, children: [] }])!.pageId, "z");
  assert.equal(
    row([{ insert: "A" }], [{ id: "k", flavour: "affine:embed-linked-doc", props: { pageId: "z" }, children: [] }, { id: "p", flavour: "affine:paragraph", props: { text: new AText([{ insert: "mehr" }]) }, children: [] }]),
    null,
    "a card among other content is a link, not the row's document",
  );
  assert.equal(rowDocRef({ id: "r", flavour: "affine:embed-synced-doc", props: { pageId: "s" }, children: [] })!.pageId, "s");
  const bytes = affineFileV2(rowDocsWorkspace());
  const tree = await parseImport("z.affine", bytes);
  assert.ok(tree.pages.find((p) => p.key === "doc:rdA")!.inRecord);
  assert.ok(!tree.pages.find((p) => p.key === "doc:rdDay")!.inRecord, "a journal day stays a journal day");
  assert.ok(!tree.pages.find((p) => p.key === "doc:rdHome")!.inRecord, "the document holding the database stays a page");
  assert.equal(tree.pages.find((p) => p.key === "db:rdA:rdNested")!.parent, "folder:rdF", "the document's own database goes where the document was");
  assert.ok(tree.warnings.some((w) => /^1 Eigenschaften von Dokumenten in Datenbankeinträgen haben keine passende Spalte/.test(w)));
  assert.match(englishMessage(tree.warnings.find((w) => /Eigenschaften von Dokumenten in Datenbankeinträgen/.test(w))!), /^1 properties of documents in database records have no matching column/);

  const preview = await importFromSource(owner, wid, space, { name: "z.affine", bytes }, { dryRun: true });
  assert.equal(preview.rowDocuments, 3);
  // Vertrieb and Übersicht (and a journal day); A, C and D are records.
  assert.equal(preview.pages, 2);
  assert.equal(preview.journalDays, 1);
  assert.equal(preview.icons, 1, "the document's icon becomes the record's");
  assert.equal(preview.files, 1);

  const result = await importFromSource(owner, wid, space, { name: "z.affine", bytes });
  assert.ok(result.rootIds.length);
  for (const title of ["Angebot ACME", "Karte C", "Dokument D"])
    assert.equal(all("SELECT id FROM pages WHERE workspace_id=? AND title=? AND kind='document'", wid, title).length, 0, `${title} is no page of its own`);
  const db = pageByTitle("Angebote");
  type Rec = { id: string; cells: string; content: string; icon: string };
  const recs = all<Rec>("SELECT id,cells,content,icon FROM rows WHERE page_id=? ORDER BY position", db.id);
  const cells = recs.map((r) => JSON.parse(r.cells) as Record<string, unknown>);
  const fields = JSON.parse(one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", db.id)!.fields) as { id: string; name: string; options?: string[] }[];
  const fid = (name: string) => fields.find((f) => f.name === name)!.id;
  const [a, b, c, d, j, s] = recs;
  // The first row: the document's content, title, icon, tags, properties.
  assert.equal(cells[0].title, "Angebot ACME");
  assert.match(a.content, /Inhalt von A/);
  assert.match(a.content, /<img src="\/api\/files\//);
  assert.match(a.content, /data-linked-source="[0-9a-f-]{36}"/, "the document's own database stays embedded");
  assert.match(a.content, new RegExp(`/#page=${db.id}&amp;row=${c.id}`), "a link to another row's document leads to that record");
  assert.equal(a.icon, "💼");
  assert.deepEqual(cells[0][fid("Tags")], ["Wichtig"]);
  assert.ok(fields.find((f) => f.name === "Tags")!.options!.includes("Wichtig"));
  assert.equal(cells[0][fid("Kunde")], "ACME");
  assert.equal(cells[0][fid("Fertig")], true, "the row's own cells stay");
  assert.equal(one<{ html: string }>("SELECT html FROM row_documents WHERE row_id=?", a.id)!.html.includes("Inhalt von A"), true);
  // A second row naming the same document links to the first.
  assert.equal(cells[1].title, "Angebot ACME");
  assert.match(b.content, new RegExp(`/#page=${db.id}&amp;row=${a.id}`));
  assert.match(b.content, /Eigene Notiz von B/);
  // A synced-doc card as the row's content; a title with more than the reference.
  assert.equal(cells[2].title, "Mit Karte");
  assert.match(c.content, /Inhalt von C/);
  assert.doesNotMatch(c.content, /Karte C/, "the card is not shown again");
  assert.equal(cells[3].title, "Vorgang Dokument D");
  assert.match(d.content, /Inhalt von D/);
  assert.deepEqual(cells[3][fid("Tags")], ["Neu"]);
  assert.equal(cells[3][fid("Kunde")], "Aus der Zelle", "a property never overwrites the row's cell");
  // A journal day and the database's own document: links.
  const day = one<{ id: string }>("SELECT id FROM pages WHERE workspace_id=? AND journal_date='2026-10-05' AND deleted_at IS NULL", wid)!;
  assert.match(j.content, new RegExp(link(day.id)));
  assert.match(s.content, new RegExp(link(pageByTitle("Vertrieb").id)));
  // Links from elsewhere and the folder lead to the record.
  const over = pageByTitle("Übersicht Angebote");
  assert.match(html(over.id), new RegExp(`/#page=${db.id}&amp;row=${a.id}`));
  assert.match(html(over.id), new RegExp(`/#page=${db.id}&amp;row=${d.id}`));
  const folder = pageByTitle("Kunden");
  assert.equal(over.parent_id, folder.id);
  assert.match(html(folder.id), new RegExp(`/#page=${db.id}&amp;row=${a.id}`));
  assert.equal(pageByTitle("Positionen").parent_id, folder.id);
  // The document's whiteboard shows the record on its card.
  const board = pageByTitle("Angebot ACME – Whiteboard");
  assert.equal(board.kind, "whiteboard");
  const card = whiteboardItems(boardDoc(board.id)).find((i) => i.type === "card")!;
  assert.equal(card.pageId, db.id);
  assert.equal(card.rowId, a.id);

  // Imported as one database, the documents are records like any other.
  const flat = await importFromSource(owner, wid, space, { name: "z.affine", bytes }, { mode: "database" });
  const flatRows = all<{ id: string; cells: string }>("SELECT id,cells FROM rows WHERE page_id=?", flat.databaseId!);
  assert.ok(flatRows.some((r) => JSON.parse(r.cells).title === "Angebot ACME"));
  const overRow = flatRows.find((r) => JSON.parse(r.cells).title === "Übersicht Angebote")!;
  const accept = flatRows.find((r) => JSON.parse(r.cells).title === "Angebot ACME")!;
  assert.match(one<{ content: string }>("SELECT content FROM rows WHERE id=?", overRow.id)!.content, new RegExp(`row=${accept.id}`));
});

test("snapshot ZIP: a database row's document becomes its record's content (#82)", async () => {
  const delta = (ops: unknown[]) => ({ "$blocksuite:internal:text$": true, delta: ops });
  const home = snapshotDoc("snHome", "Projekte Snapshot", [
    {
      type: "block",
      id: "snDb",
      flavour: "affine:database",
      version: 3,
      props: {
        title: delta([{ insert: "Projektliste" }]),
        views: [{ id: "sv", name: "Tabelle", mode: "table", columns: [] }],
        columns: [{ id: "sTitle", type: "title", name: "Projekt", data: {} }],
        cells: {},
      },
      children: [
        { type: "block", id: "snRow", flavour: "affine:paragraph", version: 1, props: { type: "text", text: delta([{ insert: " ", attributes: { reference: { type: "LinkedPage", pageId: "snRowDoc" } } }]) }, children: [] },
      ],
    },
  ]);
  const rowDoc = snapshotDoc("snRowDoc", "Projekt Alpha", [
    { type: "block", id: "snP", flavour: "affine:paragraph", version: 1, props: { type: "text", text: delta([{ insert: "Alpha im Detail" }]) }, children: [] },
  ]);
  const zip = await writeZip(
    new Map([
      ["Projekte-snHome.snapshot.json", Buffer.from(JSON.stringify(home))],
      ["Alpha-snRowDoc.snapshot.json", Buffer.from(JSON.stringify(rowDoc))],
    ]),
  );
  const preview = await importFromSource(owner, wid, space, { name: "sn.zip", bytes: zip }, { dryRun: true });
  assert.equal(preview.rowDocuments, 1);
  await importFromSource(owner, wid, space, { name: "sn.zip", bytes: zip });
  assert.equal(all("SELECT id FROM pages WHERE workspace_id=? AND title='Projekt Alpha'", wid).length, 0);
  const rec = one<{ cells: string; content: string }>("SELECT cells,content FROM rows WHERE page_id=?", pageByTitle("Projektliste").id)!;
  assert.equal(JSON.parse(rec.cells).title, "Projekt Alpha");
  assert.match(rec.content, /Alpha im Detail/);
});
