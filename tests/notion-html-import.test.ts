import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-notion-html-"));
const { all, one, run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { bootstrap, rows } = await import("../lib/api");
const { writeZip } = await import("../lib/archive");
const { importZip } = await import("../lib/zip-import");
const { notionHtmlPage, isNotionHtml } = await import("../lib/importers/notion-html");
const { cleanHtml } = await import("../lib/document-server");

// Notion's HTML export (#234): synthetic samples shaped like "Export →
// HTML" (tests/fixtures/import/notion-html): every list item a list of its
// own, toggles as <ul class="toggle"><details>, toggle headings as
// <details> with a heading summary, callouts as <figure class="callout">,
// colours as highlight-… and block-color-… classes.
const FIXTURE = new URL("./fixtures/import/notion-html/", import.meta.url).pathname;
function fixtureFiles(dir = FIXTURE): [string, Buffer][] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? fixtureFiles(path) : [[relative(FIXTURE, path), readFileSync(path)] as [string, Buffer]];
  });
}
const page = (body: string) => `<html><body><article class="page sans"><header><h1 class="page-title">Seite</h1></header><div class="page-body">${body}</div></article></body></html>`;
const convert = (body: string) => cleanHtml(notionHtmlPage(page(body)).html).replace(/ data-block-id="[^"]*"/g, "");

test("Notion's per-item lists become one nested list, to-dos task lists", () => {
  const html = convert(
    '<ol type="1" class="numbered-list" start="1"><li>Eins<ol type="a" class="numbered-list" start="1"><li>a</li></ol><ol type="a" class="numbered-list" start="2"><li>b</li></ol></li></ol>' +
      '<ol type="1" class="numbered-list" start="2"><li>Zwei</li></ol>' +
      '<ul class="bulleted-list"><li style="list-style-type:disc">Punkt</li></ul><ul class="bulleted-list"><li style="list-style-type:disc">Punkt 2</li></ul>' +
      '<ul class="to-do-list"><li><div class="checkbox checkbox-on"></div> <span class="to-do-children-checked">Fertig</span><div class="indented"><ul class="bulleted-list"><li>Detail</li></ul></div></li></ul>' +
      '<ul class="to-do-list"><li><div class="checkbox checkbox-off"></div> <span class="to-do-children-unchecked">Offen</span></li></ul>',
  );
  assert.equal(
    html,
    "<ol><li><p>Eins</p><ol><li><p>a</p></li><li><p>b</p></li></ol></li><li><p>Zwei</p></li></ol>" +
      "<ul><li><p>Punkt</p></li><li><p>Punkt 2</p></li></ul>" +
      '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>Fertig</p><ul><li><p>Detail</p></li></ul></li><li data-type="taskItem" data-checked="false"><p>Offen</p></li></ul>',
  );
});

test("toggles stay toggles; toggle headings become headings where their section matches", () => {
  const html = convert(
    '<ul class="toggle"><li><details open=""><summary>Action Items</summary><p>Innen</p></details></li></ul>' +
      // H2 followed by another H2: a heading (it folds in Flowplan).
      '<details open=""><summary style="font-weight:600;font-size:1.5em;line-height:1.3;margin:0">08.10.26 Termin</summary><p>Inhalt eins</p></details>' +
      // H2 followed by a paragraph: a toggle with the heading's text.
      '<details open=""><summary style="font-weight:600;font-size:1.5em;line-height:1.3;margin:0"><h2>15.10.26 Termin</h2></summary><p>Inhalt zwei</p></details>' +
      "<p>Danach</p>" +
      // Nested in a callout: always a toggle.
      '<figure class="callout"><div><span class="icon">📌</span></div><div><details open=""><summary style="font-size:1.25em">Klein</summary><p>x</p></details></div></figure>',
  );
  assert.match(html, /^<details><summary>Action Items<\/summary><div><p>Innen<\/p><\/div><\/details>/);
  assert.match(html, /<h2>08\.10\.26 Termin<\/h2><p>Inhalt eins<\/p><details><summary>15\.10\.26 Termin<\/summary><div><p>Inhalt zwei<\/p><\/div><\/details><p>Danach<\/p>/);
  assert.match(html, /<aside data-callout="note" data-callout-icon="📌"><details><summary>Klein<\/summary>/);
  // A toggle heading as the last block, and one whose content holds a
  // heading of its own level, keep their place.
  assert.match(convert('<p>x</p><details><summary style="font-size:1.875em">Letzter</summary><p>y</p></details>'), /<h1>Letzter<\/h1><p>y<\/p>$/);
  assert.match(convert('<details><summary style="font-size:1.25em">Drei</summary><h3>Auch drei</h3></details>'), /^<details><summary>Drei<\/summary>/);
});

test("callouts, colours, images, formulas and bookmarks; scripts and handlers go", () => {
  const html = convert(
    '<figure class="block-color-blue_background callout" style="white-space:pre-wrap;display:flex"><div style="font-size:1.5em"><span class="icon">💡</span></div><div style="width:100%">Tipp<p>Zweiter Absatz</p></div></figure>' +
      '<p class="block-color-red">Rot</p>' +
      '<p><mark class="highlight-teal">grün</mark> <mark class="highlight-purple_background">lila</mark> <mark class="highlight-default">normal</mark> <span style="border-bottom:0.05em solid">unter</span></p>' +
      '<figure class="image"><a href="Seite/bild.png"><img style="width:400px" src="Seite/bild.png"/></a><figcaption>Bild eins</figcaption></figure>' +
      '<figure class="equation"><style>@import url(x.css)</style><div class="equation-container"><annotation encoding="application/x-tex">a^2</annotation></div></figure>' +
      '<figure><a href="https://example.org" class="bookmark source"><div class="bookmark-title">Beispiel</div></a></figure>' +
      '<p onclick="alert(1)">Ende<script>alert(2)</script><img src="x" onerror="alert(3)"></p>',
  );
  assert.match(html, /<aside data-callout="note" data-callout-icon="💡" data-callout-color="blue"><p>Tipp<\/p><p>Zweiter Absatz<\/p><\/aside>/);
  assert.match(html, /<p><span style="color:#e03131">Rot<\/span><\/p>/);
  assert.match(html, /<span style="color:#2f9e44">grün<\/span> <mark style="background-color:#e3d3fa">lila<\/mark> normal <u>unter<\/u>/);
  assert.match(html, /<figure><img src="Seite\/bild\.png" alt="Bild eins" \/><figcaption>Bild eins<\/figcaption><\/figure>/);
  assert.match(html, /<div data-math="a\^2"><\/div>/);
  assert.match(html, /<p><a href="https:\/\/example\.org"[^>]*>Beispiel<\/a><\/p>/);
  assert.doesNotMatch(html, /script|onclick|onerror|alert|@import/);
  assert.equal(notionHtmlPage(page("")).title, "Seite");
  assert.equal(isNotionHtml(page("")), true);
  assert.equal(isNotionHtml("<html><body><p>x</p></body></html>"), false);
});

async function account(name: string) {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}

test("a Notion HTML export ZIP becomes pages, subpages, files and a database with record pages", async () => {
  const owner = await account("notion-html-owner");
  const wid = await createWorkspace(owner.id, "Notion HTML");
  const space = (await bootstrap(owner, wid)).spaces[0].id;
  // As Notion delivers it: one folder around everything.
  const bytes = await writeZip(new Map(fixtureFiles().map(([name, data]) => [`Export-0f9e8d/${name}`, data])));
  const result = await importZip(owner, wid, space, bytes);
  assert.deepEqual({ pages: result.pages, rows: result.rows, files: result.files }, { pages: 3, rows: 2, files: 2 });
  const pageOf = async (title: string) =>
    (await one<{ id: string; parent_id: string | null; kind: string }>(
      "SELECT id,parent_id,kind FROM pages WHERE workspace_id=? AND title=? AND deleted_at IS NULL",
      wid,
      title,
    ))!;
  // Titles from the page itself, not from the (shortened) file name.
  const meetings = await pageOf("Besprechungen Projekt Alpha"),
    decisions = await pageOf("Entscheidungen"),
    tasks = await pageOf("Aufgaben");
  assert.equal(decisions.parent_id, meetings.id);
  assert.equal(tasks.kind, "database");
  const html = (await one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", meetings.id))!.html;
  // Links between pages, images and files of the export.
  assert.match(html, new RegExp(`<a [^>]*href="/#page=${decisions.id}"`));
  const files = await all<{ id: string; name: string }>("SELECT id,name FROM files WHERE page_id=? ORDER BY name", meetings.id);
  assert.deepEqual(files.map((f) => f.name), ["Ablauf.png", "Protokoll.pdf"]);
  assert.match(html, new RegExp(`<img [^>]*src="/api/files/${files[0].id}"`));
  assert.match(html, new RegExp(`<a [^>]*href="/api/files/${files[1].id}"`));
  assert.match(html, /<figcaption>Ablauf heute<\/figcaption>/);
  // Toggles, the toggle heading, callouts, colours, to-dos and lists.
  assert.match(html, /<details[^>]*><summary>Action Items \/ ToDos<\/summary>/);
  assert.match(html, /<h2[^>]*>08\.10\.26 Prozessverständnis<\/h2>/);
  assert.match(html, /<summary>15\.10\.26 Lösungsideen<\/summary>/);
  assert.match(html, /data-callout-icon="💡" data-callout-color="gray"/);
  assert.match(html, /<span style="color:#e03131">roter Schrift<\/span>/);
  assert.match(html, /data-checked="true"/);
  assert.equal((html.match(/<ol[ >]/g) || []).length, 4);
  assert.doesNotMatch(html, /<script|onclick|alert/);
  // The database from the CSV, record documents from the record pages.
  const records = await rows(tasks.id);
  assert.deepEqual(records.map((r) => r.cells.title), ["Planen", "Bauen"]);
  const rowHtml = (await one<{ html: string }>("SELECT html FROM row_documents WHERE row_id=?", records[0].id))!.html;
  assert.match(rowHtml, /<strong>Planen<\/strong>/);
  assert.match(rowHtml, /<summary>Offene Fragen<\/summary>/);
  // The properties above the record's text are cells, not text.
  assert.doesNotMatch(rowHtml, /Status/);
  assert.equal(await one("SELECT 1 FROM row_documents WHERE row_id=?", records[1].id), undefined);
});

test("HTML pages of a Markdown export are files, unless they are Notion's", async () => {
  const owner = await account("notion-html-mixed");
  const wid = await createWorkspace(owner.id, "Gemischt");
  const space = (await bootstrap(owner, wid)).spaces[0].id;
  const bytes = await writeZip(
    new Map([
      ["Start.md", Buffer.from("# Start\n\nSiehe [Bericht](bericht.html)\n")],
      ["bericht.html", Buffer.from("<html><body><p>Bericht</p></body></html>")],
      ["Notion 0123456789abcdef0123456789abcdef.html", Buffer.from(page("<p>Aus Notion</p>"))],
    ]),
  );
  const result = await importZip(owner, wid, space, bytes);
  assert.equal(result.pages, 2);
  assert.equal(result.files, 1);
  assert.ok(await one("SELECT 1 FROM pages WHERE workspace_id=? AND title='Seite'", wid));
});
