import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-export-formats-"));
process.env.APP_URL = "https://flowplan.example.test";
const { run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, database } = await import("../lib/api");
const { htmlState } = await import("../lib/document-server");
const { replaceRowDocument } = await import("../lib/row-documents");
const { readExportZip } = await import("./helpers/read-export-zip");
const { assertWellFormedXml } = await import("./helpers/xml-check");
const { exportDocx, buildDocx, imageSize } = await import("../lib/export-docx");
const { exportEpub } = await import("../lib/export-epub");
const { exportPrintHtml } = await import("../lib/export-pdf");
const { collectExportContent } = await import("../lib/export-content");
const { englishMessage } = await import("../lib/i18n-errors");

function person(name: string): Identity {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const owner = person("Autor"),
  viewer = person("Leserin"),
  stranger = person("Fremd");
const wid = createWorkspace(owner.id, "Handbuch-Werkstatt");
run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
const space = (command(owner, { action: "space.create", workspaceId: wid, name: "Dokumentation" }) as { id: string }).id;
const privateSpace = (command(owner, { action: "space.create", workspaceId: wid, name: "Privat", private: true }) as { id: string }).id;
const page = (title: string, kind = "document", parentId?: string) =>
  (command(owner, { action: "page.create", workspaceId: wid, spaceId: space, title, kind, parentId }) as { id: string }).id;
const write = (pageId: string, html: string) => run("UPDATE documents SET html=?,state=? WHERE page_id=?", html, htmlState(html), pageId);
// A PNG header is enough for the size (the exports do not decode pictures).
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]),
  Buffer.from("IHDR"),
  Buffer.from([0, 0, 0x03, 0x20, 0, 0, 0x01, 0x90, 8, 6, 0, 0, 0]),
  Buffer.from("rest of the picture"),
]);
function file(pageId: string, name: string, mime: string, bytes: Buffer) {
  const fid = id();
  mkdirSync(join(process.env.FLOWPLAN_DATA_DIR!, "uploads"), { recursive: true });
  writeFileSync(join(process.env.FLOWPLAN_DATA_DIR!, "uploads", fid), bytes);
  run("INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)", fid, pageId, name, mime, bytes.length, owner.id);
  return { id: fid, url: `/api/files/${fid}` };
}

const root = page("Handbuch"),
  chapter = page("Kapitel 1", "document", root),
  section = page("Abschnitt 1.1", "document", chapter),
  table = page("Tabelle", "database", root),
  board = page("Skizze", "whiteboard", root),
  hidden = page("Geheim", "document", root);
// Moved below the root into the owner's private space: readers do not see it.
run("UPDATE pages SET space_id=? WHERE id=?", privateSpace, hidden);
const picture = file(root, "bild.png", "image/png", png);
const secretFile = file(hidden, "geheim.png", "image/png", png);
write(
  root,
  `<h2>Einführung</h2><p>Hallo <strong>fett</strong> <em>kursiv</em> <a href="/#page=${chapter}">Kapitel</a> <a href="https://example.org/">extern</a><sup data-footnote="Eine Notiz https://example.org/note"></sup> <a href="/#page=${hidden}">geheim</a></p>` +
    `<ul><li><p>Eins</p><ul><li><p>Zwei</p></li></ul></li></ul><ol start="3"><li><p>Drei</p></li></ol>` +
    `<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>Erledigt</p></li><li data-type="taskItem" data-checked="false" data-due="2026-05-04"><p>Offen</p></li></ul>` +
    `<table><tr><th colspan="2">Kopf</th></tr><tr><td rowspan="2"><p>A</p></td><td><p>B</p></td></tr><tr><td><p>C</p></td></tr></table>` +
    `<img src="${picture.url}" alt="Bild"><img src="${secretFile.url}" alt="Geheimes Bild">` +
    `<aside data-callout="warning"><p>Vorsicht &amp; Umsicht</p></aside><pre><code class="language-js">const x = 1 &lt; 2;</code></pre><blockquote><p>Zitat</p></blockquote>`,
);
write(chapter, `<p>Kapiteltext mit <mark>Markierung</mark> und <code>Code</code>.</p>`);
write(section, `<p>Abschnittstext.</p>`);
write(hidden, `<p>Nur für den Autor.</p>`);
const schema = database(table);
command(owner, {
  action: "database.update",
  pageId: table,
  version: schema.version,
  fields: [...schema.fields, { id: "amount", name: "Betrag", type: "number" }, { id: "done", name: "Fertig", type: "checkbox" }],
  views: schema.views,
});
const row = command(owner, { action: "row.create", pageId: table, cells: { title: "Erster Eintrag", amount: 42, done: true } }) as { id: string };
replaceRowDocument(row.id, "<p>Text des Eintrags.</p>", owner.id);

test("a page becomes a valid Word file with styles, lists, tasks, tables, pictures, callouts, code and footnotes", async () => {
  // As the reader: the owner's private sub-page and its picture stay out.
  const result = await exportDocx(viewer, { pageId: root });
  assert.equal(result.name, "Handbuch.docx");
  const parts = await readExportZip(result.bytes);
  for (const name of ["[Content_Types].xml", "_rels/.rels", "word/document.xml", "word/styles.xml", "word/numbering.xml", "word/footnotes.xml", "word/_rels/document.xml.rels", "word/media/image1.png"])
    assert.ok(parts.has(name), `${name} is part of the file`);
  for (const [name, bytes] of parts) if (/\.(xml|rels)$/.test(name)) assertWellFormedXml(bytes.toString("utf8"), name);
  const document = parts.get("word/document.xml")!.toString("utf8");
  assert.match(document, /<w:pStyle w:val="Title"\/><\/w:pPr><w:r><w:t xml:space="preserve">Handbuch<\/w:t>/);
  assert.match(document, /<w:pStyle w:val="Heading2"\/>/);
  assert.match(document, /<w:b\/>.*?<w:t xml:space="preserve">fett<\/w:t>/);
  assert.match(document, /<w:i\/>.*?<w:t xml:space="preserve">kursiv<\/w:t>/);
  assert.match(document, /<w:numPr><w:ilvl w:val="1"\/>/);
  assert.match(document, /<w:startOverride w:val="3"\/>|w:numId/);
  assert.match(document, /☑ /);
  assert.match(document, /☐ /);
  assert.match(document, /fällig 2026-05-04/);
  assert.match(document, /<w:footnoteReference w:id="1"\/>/);
  assert.match(document, /<w:gridSpan w:val="2"\/>/);
  assert.match(document, /<w:vMerge w:val="restart"\/>/);
  assert.match(document, /<w:vMerge\/>/);
  assert.match(document, /w:fill="FEF7E0"/);
  assert.match(document, /Vorsicht &amp; Umsicht/);
  assert.match(document, /<w:pStyle w:val="Code"\/>/);
  assert.match(document, /const x = 1 &lt; 2;/);
  assert.match(document, /<w:drawing>.*?<a:blip r:embed="rId\d+"\/>/);
  assert.match(document, /Geheimes Bild \(nicht verfügbar\)/);
  assert.doesNotMatch(document, /Nur für den Autor/);
  // The picture is scaled to the text width: 800×400 px are wider than 6.3".
  assert.match(document, /<wp:extent cx="5760720" cy="2880360"\/>/);
  assert.equal(parts.get("word/media/image1.png")!.equals(png), true);
  assert.equal(parts.size, [...parts.keys()].filter((name) => name.startsWith("word/media/")).length + 9, "only the one readable picture is embedded");
  const rels = parts.get("word/_rels/document.xml.rels")!.toString("utf8");
  assert.match(rels, /Target="https:\/\/example.org\/" TargetMode="External"/);
  assert.match(rels, new RegExp(`Target="https://flowplan.example.test/#page=${chapter}" TargetMode="External"`));
  assert.doesNotMatch(rels, new RegExp(hidden));
  assert.match(rels, /Target="media\/image1.png"/);
  const footnotes = parts.get("word/footnotes.xml")!.toString("utf8");
  assert.match(footnotes, /Eine Notiz https:\/\/example.org\/note/);
  assert.match(parts.get("[Content_Types].xml")!.toString("utf8"), /Extension="png" ContentType="image\/png"/);
  const numbering = parts.get("word/numbering.xml")!.toString("utf8");
  assert.match(numbering, /<w:startOverride w:val="3"\/>/);
  assert.match(numbering, /<w:numFmt w:val="bullet"\/>/);
});

test("a record and a database become Word files with their properties", async () => {
  const record = await exportDocx(owner, { pageId: table, rowId: row.id });
  assert.equal(record.name, "Erster Eintrag.docx");
  const document = (await readExportZip(record.bytes)).get("word/document.xml")!.toString("utf8");
  assertWellFormedXml(document);
  assert.match(document, /Betrag/);
  assert.match(document, /<w:t xml:space="preserve">42<\/w:t>/);
  assert.match(document, /<w:t xml:space="preserve">Ja<\/w:t>/);
  assert.match(document, /Text des Eintrags\./);
  const whole = await exportDocx(viewer, { pageId: table });
  const all = (await readExportZip(whole.bytes)).get("word/document.xml")!.toString("utf8");
  assert.match(all, /<w:pStyle w:val="Title"\/><\/w:pPr><w:r><w:t xml:space="preserve">Tabelle<\/w:t>/);
  assert.match(all, /<w:pStyle w:val="Heading2"\/><\/w:pPr><w:r><w:t xml:space="preserve">Erster Eintrag<\/w:t>/);
  await assert.rejects(exportDocx(stranger, { pageId: root }), (error: { status: number }) => [403, 404].includes(error.status));
  await assert.rejects(exportDocx(owner, { pageId: table, rowId: id() }), { status: 404 });
});

test("the Word generator reads picture sizes and keeps nested lists inside quotes", async () => {
  assert.deepEqual(imageSize(png), { width: 800, height: 400 });
  assert.deepEqual(imageSize(Buffer.from("GIF89a\x10\x00\x20\x00", "latin1")), { width: 16, height: 32 });
  assert.equal(imageSize(Buffer.from("not a picture")), null);
  const bytes = await buildDocx({
    title: "Test",
    sections: [{ title: "Test", html: "<blockquote><ul><li><p>In quote</p></li></ul></blockquote><p style=\"text-align:center\">Mitte</p>" }],
    file: () => null,
    url: (raw) => raw,
  });
  const document = (await readExportZip(bytes)).get("word/document.xml")!.toString("utf8");
  assertWellFormedXml(document);
  assert.match(document, /<w:pBdr><w:left[^>]*\/><\/w:pBdr>[^]*?In quote/);
  assert.match(document, /<w:jc w:val="center"\/><\/w:pPr><w:r><w:t xml:space="preserve">Mitte/);
});

test("a page tree becomes an EPUB 3 with a stored mimetype first, a nested navigation and relative links", async () => {
  const result = await exportEpub(viewer, { pageId: root, children: true });
  assert.equal(result.name, "Handbuch.epub");
  assert.equal(result.mime, "application/epub+zip");
  // Local file header of the first entry: stored (method 0), named mimetype.
  assert.equal(result.bytes.readUInt16LE(8), 0);
  assert.equal(result.bytes.subarray(30, 38).toString(), "mimetype");
  const parts = await readExportZip(result.bytes);
  assert.equal([...parts.keys()][0], "mimetype");
  assert.equal(parts.get("mimetype")!.toString(), "application/epub+zip");
  for (const name of ["META-INF/container.xml", "OEBPS/content.opf", "OEBPS/nav.xhtml", "OEBPS/style.css", "OEBPS/title.xhtml", "OEBPS/chapter-001.xhtml"])
    assert.ok(parts.has(name), `${name} is part of the book`);
  for (const [name, bytes] of parts) if (/\.(xml|opf|xhtml)$/.test(name)) assertWellFormedXml(bytes.toString("utf8"), name);
  assert.match(parts.get("META-INF/container.xml")!.toString(), /full-path="OEBPS\/content.opf"/);
  const opf = parts.get("OEBPS/content.opf")!.toString();
  assert.match(opf, /<dc:title>Handbuch<\/dc:title>/);
  assert.match(opf, new RegExp(`<dc:identifier id="pub-id">urn:uuid:${root}</dc:identifier>`));
  assert.match(opf, /properties="nav"/);
  assert.match(opf, new RegExp(`href="images/${picture.id}.png" media-type="image/png"`));
  assert.ok(parts.get(`OEBPS/images/${picture.id}.png`)!.equals(png));
  assert.ok(!parts.has(`OEBPS/images/${secretFile.id}.png`), "a picture of a hidden page stays out");
  const chapters = [...parts.keys()].filter((name) => /chapter-\d+\.xhtml$/.test(name));
  // Root, chapter, its section, the database and the whiteboard – the hidden page stays out.
  assert.equal(chapters.length, 5);
  assert.equal((opf.match(/<itemref /g) || []).length, 6);
  const nav = parts.get("OEBPS/nav.xhtml")!.toString();
  assert.match(nav, /<ol><li><a href="chapter-001.xhtml">Handbuch<\/a><ol><li><a href="chapter-002.xhtml">Kapitel 1<\/a><ol><li><a href="chapter-003.xhtml">Abschnitt 1.1<\/a><\/li><\/ol><\/li>/);
  assert.doesNotMatch(nav, /Geheim/);
  const first = parts.get("OEBPS/chapter-001.xhtml")!.toString();
  assert.match(first, /<html xmlns="http:\/\/www.w3.org\/1999\/xhtml"/);
  assert.match(first, /<a href="chapter-002.xhtml">Kapitel<\/a>/);
  assert.match(first, /<a href="https:\/\/example.org\/">extern<\/a>/);
  assert.match(first, /<sup class="footnote-ref" id="c1-fnref-1"><a href="#c1-fn-1">1<\/a><\/sup>/);
  assert.match(first, /<li id="c1-fn-1">Eine Notiz <a href="https:\/\/example.org\/note">/);
  // The link to the private page is dropped, its text stays.
  assert.match(first, /<\/sup> geheim<\/p>/);
  assert.doesNotMatch(first, new RegExp(`#page=${hidden}`));
  assert.match(first, new RegExp(`<img src="images/${picture.id}.png" alt="Bild"/>`));
  assert.match(first, /Geheimes Bild \(nicht verfügbar\)/);
  assert.match(first, /<li class="task done"><p><span class="task-box">☑<\/span> Erledigt<\/p><\/li>/);
  assert.match(first, /<th colspan="2">/);
  assert.match(first, /<td rowspan="2">/);
  assert.match(first, /<aside class="callout callout-warning"><p class="callout-title">Warnung<\/p><p>Vorsicht &amp; Umsicht<\/p><\/aside>/);
  assert.match(first, /<pre><code class="language-js">const x = 1 &lt; 2;<\/code><\/pre>/);
  const data = parts.get("OEBPS/chapter-004.xhtml")!.toString();
  assert.match(data, /<th><p>Betrag<\/p><\/th>/);
  assert.match(data, /<td><p>42<\/p><\/td>/);
  assert.match(data, /<h2>Erster Eintrag<\/h2><p>Text des Eintrags.<\/p>/);
  assert.match(parts.get("OEBPS/chapter-005.xhtml")!.toString(), /Dieses Whiteboard ist leer\./);
  await assert.rejects(exportEpub(stranger, { pageId: root, children: true }), (error: { status: number }) => [403, 404].includes(error.status));
});

test("a space becomes one e-book with what the person may read", async () => {
  const result = await exportEpub(viewer, { spaceId: space });
  assert.equal(result.name, "Dokumentation.epub");
  const parts = await readExportZip(result.bytes);
  const nav = parts.get("OEBPS/nav.xhtml")!.toString();
  assert.match(nav, /Handbuch/);
  assert.doesNotMatch(nav, /Geheim/);
  await assert.rejects(exportEpub(viewer, { spaceId: privateSpace }), { status: 403 });
  await assert.rejects(exportEpub(stranger, { spaceId: space }), { status: 403 });
});

test("the combined print view has a cover, a numbered table of contents and every page as a chapter", async () => {
  const result = exportPrintHtml(viewer, { pageId: root, children: true });
  assert.equal(result.name, "Handbuch.html");
  const html = result.html;
  assert.ok(html.startsWith("<!doctype html>"));
  assert.match(html, /<title>Handbuch<\/title>/);
  assert.match(html, /<section class="cover">[^]*?<h1>Handbuch<\/h1>/);
  assert.match(html, /Leserin/);
  assert.match(html, new RegExp(`<nav class="toc">[^]*?<a href="#p-${root}">[^]*?<span class="number">1</span>Handbuch`));
  assert.match(html, new RegExp(`<a href="#p-${section}"><span><span class="number">1.1.1</span>Abschnitt 1.1`));
  assert.match(html, new RegExp(`<article class="chapter" id="p-${chapter}"><h1 class="chapter-title"><span class="number">1.1</span>Kapitel 1</h1>`));
  assert.match(html, new RegExp(`<a href="#p-${chapter}">Kapitel</a>`));
  assert.match(html, new RegExp(`<img src="${picture.url}" alt="Bild"/>`));
  assert.doesNotMatch(html, new RegExp(secretFile.id));
  assert.doesNotMatch(html, new RegExp(`p-${hidden}`));
  assert.doesNotMatch(html, /Nur für den Autor/);
  assert.match(html, /Geheimes Bild \(nicht verfügbar\)/);
  // The owner reads the private page: it is a chapter for them.
  assert.match(exportPrintHtml(owner, { pageId: root, children: true }).html, /Nur für den Autor/);
  assert.match(html, /page-break-before: always/);
  assert.match(html, /target-counter\(attr\(href url\), page\)/);
  assert.doesNotMatch(html, /<script/i);
  // Chapter order follows the tree depth first: root, chapter, section, …
  const order = [...html.matchAll(/<article class="chapter" id="p-([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(order.slice(0, 3), [root, chapter, section]);
  assert.equal(order.length, 5);
  const whole = exportPrintHtml(owner, { spaceId: space });
  assert.match(whole.html, /<p class="cover-kind">Bereich<\/p><h1>Dokumentation<\/h1>/);
  assert.throws(() => exportPrintHtml(stranger, { pageId: root, children: true }), (error: { status: number }) => [403, 404].includes(error.status));
  assert.throws(() => exportPrintHtml(viewer, { spaceId: privateSpace }), { status: 403 });
});

test("the page limit stops an export with a clear message", () => {
  assert.throws(() => collectExportContent(owner, { pageId: root, children: true, maxPages: 2, format: "PDF" }), {
    status: 413,
    message: "Bitte höchstens 2 Seiten je PDF-Export auswählen.",
  });
  assert.equal(englishMessage("Bitte höchstens 2 Seiten je PDF-Export auswählen."), "Please select at most 2 pages per PDF export.");
  // Without sub-pages the one page always fits.
  assert.equal(collectExportContent(owner, { pageId: root, children: false, maxPages: 1, format: "Word" }).pages.length, 1);
});
