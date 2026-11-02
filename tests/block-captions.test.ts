// Captions of images, tables and code blocks (#84, lib/block-captions.ts):
// the stored HTML, Yjs, Markdown both ways, numbering, the exports, the
// page switch and the AFFiNE import.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-captions-"));
process.env.APP_URL = "https://flowplan.example.test";
const { generateHTML, generateJSON } = await import("@tiptap/html/server");
const { documentExtensions, documentSchema } = await import("../lib/document-schema");
const { cleanHtml, htmlState, stateHtml } = await import("../lib/document-server");
const { captionNumbers, captionCounter, captionLabel, captionText, captionInput, numberedInFrontmatter } = await import("../lib/block-captions");
const { htmlToMarkdown, markdownSource } = await import("../lib/markdown");
const { markdownToHtml } = await import("../lib/markdown-import");
const { documentXhtml } = await import("../lib/export-xhtml");
const { documentText } = await import("../lib/search-index");
const { translate } = await import("../lib/i18n");
const { run, one, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command } = await import("../lib/api");
const { exportDocx } = await import("../lib/export-docx");
const { exportPrintHtml } = await import("../lib/export-pdf");
const { exportMarkdown } = await import("../lib/markdown-export");
const { readExportZip } = await import("./helpers/read-export-zip");
const { parseImport } = await import("../lib/importers");
const { affineFileV2, note, page: affinePage, para } = await import("./helpers/affine-fixture");
const { sampleWorkspace, IDS } = await import("./helpers/affine-sample");

const nodes = (html: string) => generateJSON(cleanHtml(html), documentExtensions).content as { type: string; attrs?: Record<string, unknown> }[];
const roundTrip = (html: string) => generateHTML(generateJSON(cleanHtml(html), documentExtensions), documentExtensions);
const doc = (html: string) => documentSchema().nodeFromJSON(generateJSON(cleanHtml(html), documentExtensions));
const markdown = (html: string) => htmlToMarkdown(html, { url: (url) => url, linked: () => null });

const STORED =
  '<figure class="block-figure"><img src="/api/files/a" alt="Ein Diagramm"><figcaption>Ablauf der Freigabe</figcaption></figure>' +
  '<figure class="block-figure"><pre><code class="language-ts">const a = 1;\n  return a;</code></pre><figcaption>Beispiel in TypeScript</figcaption></figure>' +
  "<table><caption>Kosten 2026</caption><tbody><tr><th><p>Posten</p></th></tr><tr><td><p>Server</p></td></tr></tbody></table>";

test("captions are attributes of image, code block and table; HTML keeps them as figure and caption", () => {
  const [image, code, table] = nodes(STORED);
  assert.deepEqual([image.type, image.attrs!.caption, image.attrs!.alt], ["image", "Ablauf der Freigabe", "Ein Diagramm"], "alt text stays separate");
  assert.deepEqual([code.type, code.attrs!.caption, code.attrs!.language], ["codeBlock", "Beispiel in TypeScript", "ts"]);
  assert.deepEqual([table.type, table.attrs!.caption], ["table", "Kosten 2026"]);
  const html = roundTrip(STORED);
  assert.match(html, /<figure class="block-figure"><img src="\/api\/files\/a" alt="Ein Diagramm"><figcaption>Ablauf der Freigabe<\/figcaption><\/figure>/);
  assert.match(html, /<figure class="block-figure"><pre><code class="language-ts">const a = 1;\n {2}return a;<\/code><\/pre><figcaption>Beispiel in TypeScript<\/figcaption><\/figure>/);
  assert.match(html, /<table[^>]*><caption>Kosten 2026<\/caption><colgroup>/, "the caption is the table's first child");
  assert.equal(roundTrip(html), html, "stable");
  // No caption: the block as before (no figure).
  assert.equal(roundTrip('<img src="/api/files/b"><pre><code>x</code></pre>'), '<img src="/api/files/b"><pre><code class="language-plaintext">x</code></pre>');
  // Through Yjs (collaboration and the stored state).
  const ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, htmlState(html));
  assert.equal(stateHtml(ydoc), cleanHtml(html));
  // Searchable.
  assert.match(documentText(html), /Ablauf der Freigabe.*Beispiel in TypeScript.*Kosten 2026/);
});

test("captions from other HTML: a figure around one block counts, its caption is not body text", () => {
  // Notion's HTML export: the image in a link inside the figure.
  const [notion] = nodes('<figure class="image"><a href="https://example.org/a.png"><img src="https://example.org/a.png"></a><figcaption>Aus Notion</figcaption></figure>');
  assert.deepEqual([notion.type, notion.attrs!.caption], ["image", "Aus Notion"]);
  const [code] = nodes("<figure><pre><code>x</code></pre><figcaption>  Ein\n  Listing  </figcaption></figure>");
  assert.equal(code.attrs!.caption, "Ein Listing", "one line, trimmed");
  const [table] = nodes("<figure><table><tr><td>1</td></tr></table><figcaption>Unter der Tabelle</figcaption></figure>");
  assert.deepEqual([table.type, table.attrs!.caption], ["table", "Unter der Tabelle"]);
  // Two pictures in one figure: no caption of either, the text stays.
  const two = nodes('<figure><img src="https://e.org/1.png"><img src="https://e.org/2.png"><figcaption>Zwei Bilder</figcaption></figure>');
  assert.deepEqual(two.map((n) => [n.type, n.attrs?.caption ?? null]), [["image", null], ["image", null], ["paragraph", null]]);
  // An empty figcaption is no caption.
  assert.equal(nodes('<figure><img src="/api/files/c"><figcaption> </figcaption></figure>')[0].attrs!.caption, null);
  // Typing keeps one line and the limit; shown captions are tidied.
  assert.equal(captionInput("a\nb" + "x".repeat(600)).length, 500);
  assert.equal(captionText("  a   b "), "a b");
  assert.equal(captionText(null), "");
});

test("numbering: per kind in document order, only blocks with a caption, in the reader's language", () => {
  const html =
    '<figure class="block-figure"><img src="/api/files/1"><figcaption>Eins</figcaption></figure>' +
    '<img src="/api/files/2">' +
    "<table><caption>Tab A</caption><tbody><tr><td><p>x</p></td></tr></tbody></table>" +
    '<ul><li><p>Liste</p><figure class="block-figure"><img src="/api/files/3"><figcaption>Zwei</figcaption></figure></li></ul>' +
    '<figure class="block-figure"><pre><code>a</code></pre><figcaption>Code</figcaption></figure>' +
    "<table><tbody><tr><td><p>ohne</p></td></tr></tbody></table>" +
    "<table><caption>Tab B</caption><tbody><tr><td><p>y</p></td></tr></tbody></table>";
  const tree = doc(html);
  const numbers = [...captionNumbers(tree).values()].map((n) => `${n.kind} ${n.number}`);
  assert.deepEqual(numbers, ["figure 1", "table 1", "figure 2", "listing 1", "table 2"]);
  const de = translate("de"),
    en = translate("en"),
    fr = translate("fr");
  assert.equal(captionLabel("figure", 3, de), "Abbildung 3");
  assert.equal(captionLabel("table", 1, en), "Table 1");
  assert.equal(captionLabel("listing", 2, en), "Listing 2");
  assert.equal(captionLabel("table", 4, fr), "Tableau 4");
  // The walk the exports use gives the same order.
  const next = captionCounter(true, en);
  const labels: string[] = [];
  tree.descendants((node) => {
    const label = next(node);
    if (label) labels.push(label);
  });
  assert.deepEqual(labels, ["Figure 1", "Table 1", "Figure 2", "Listing 1", "Table 2"]);
  const off = captionCounter(false, en);
  let any = false;
  tree.descendants((node) => void (off(node) && (any = true)));
  assert.equal(any, false, "without numbering no labels");
});

test("Markdown: image title, Table: and Listing: lines – and back", () => {
  const md = markdown(STORED);
  assert.match(md, /!\[Ein Diagramm\]\(<\/api\/files\/a> "Ablauf der Freigabe"\)/);
  assert.match(md, /```ts\nconst a = 1;\n {2}return a;\n```\n\nListing: Beispiel in TypeScript/);
  assert.match(md, /\| Posten \|\n\| --- \|\n\| Server \|\n\nTable: Kosten 2026/);
  const back = markdownToHtml(md, (href) => href);
  const [image, code, table] = nodes(back);
  assert.deepEqual([image.attrs!.caption, image.attrs!.alt], ["Ablauf der Freigabe", "Ein Diagramm"]);
  assert.equal(code.attrs!.caption, "Beispiel in TypeScript");
  assert.equal(table.attrs!.caption, "Kosten 2026");
  assert.equal(markdown(back), md, "export → import → export is stable");
  // Characters Markdown would read otherwise survive.
  const tricky = 'Sagt "Hallo" & *nicht* \\ | [x] #1';
  const html = `<figure class="block-figure"><img src="/api/files/a" alt="A"><figcaption>${tricky.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}</figcaption></figure><figure class="block-figure"><pre><code>x</code></pre><figcaption>${tricky.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}</figcaption></figure>`;
  const again = nodes(markdownToHtml(markdown(html), (href) => href));
  assert.deepEqual(again.map((n) => n.attrs!.caption), [tricky, tricky]);
  // A paragraph that only looks like a caption stays a paragraph.
  const lookalike = "<pre><code>x</code></pre><p>Listing: kein Titel</p><table><tbody><tr><td><p>1</p></td></tr></tbody></table><p>Table: auch nicht</p>";
  const plain = markdown(lookalike);
  assert.match(plain, /Listing\\: kein Titel/);
  assert.deepEqual(nodes(markdownToHtml(plain, (href) => href)).map((n) => [n.type, n.attrs?.caption ?? null]), [
    ["codeBlock", null],
    ["paragraph", null],
    ["table", null],
    ["paragraph", null],
  ]);
});

test("Markdown from elsewhere: Pandoc's table captions, image titles, and formulas keep their lines", () => {
  const html = markdownToHtml(
    "| a |\n| - |\n| 1 |\n\n: Pandoc-Beschriftung\n\n![Alt](https://e.org/x.png 'Titel')\n\n```math\nx^2\n```\n\nListing: bleibt Text\n\n> ```js\n> y\n> ```\n>\n> Listing: im Zitat",
    (href) => href,
  );
  const list = nodes(html);
  assert.deepEqual(list.map((n) => [n.type, n.attrs?.caption ?? null]), [
    ["table", "Pandoc-Beschriftung"],
    ["image", "Titel"],
    ["mathBlock", null],
    ["paragraph", null],
    ["blockquote", null],
  ]);
  assert.match(html, /<blockquote><figure class="block-figure"><pre><code class="language-js">y\n<\/code><\/pre><figcaption>im Zitat<\/figcaption><\/figure>/);
});

test("Markdown source view keeps captions through editing", () => {
  const source = markdownSource(STORED);
  assert.deepEqual(source.blocks, [], "no block needs to be kept aside for its caption");
  const [image, code, table] = nodes(markdownToHtml(source.markdown, (href) => href, { source: true }));
  assert.deepEqual([image.attrs!.caption, code.attrs!.caption, table.attrs!.caption], ["Ablauf der Freigabe", "Beispiel in TypeScript", "Kosten 2026"]);
});

test("XHTML (PDF, EPUB): figure, figcaption and table caption, numbered when the page says so", () => {
  const context = { url: (url: string) => url, image: (raw: string) => raw };
  const plain = documentXhtml(STORED, context);
  assert.match(plain, /<figure><img src="\/api\/files\/a" alt="Ein Diagramm"\/><figcaption>Ablauf der Freigabe<\/figcaption><\/figure>/);
  assert.match(plain, /<figure class="listing"><pre><code class="language-ts">[^<]*<\/code><\/pre><figcaption>Beispiel in TypeScript<\/figcaption><\/figure>/);
  assert.match(plain, /<table><caption>Kosten 2026<\/caption><tr>/);
  const numbered = documentXhtml(STORED, { ...context, captionNumbers: true });
  assert.match(numbered, /<figcaption><span class="caption-label">Abbildung 1:<\/span> Ablauf der Freigabe<\/figcaption>/);
  assert.match(numbered, /<figcaption><span class="caption-label">Listing 1:<\/span> Beispiel/);
  assert.match(numbered, /<caption><span class="caption-label">Tabelle 1:<\/span> Kosten 2026<\/caption>/);
});

function person(name: string): Identity {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}

test("the page switch: stored, copied, exported to Word, print and Markdown", async () => {
  const owner = person("Beschrifterin");
  const wid = createWorkspace(owner.id, "Beschriftungen");
  const space = (command(owner, { action: "space.create", workspaceId: wid, name: "Doku" }) as { id: string }).id;
  const pageId = (command(owner, { action: "page.create", workspaceId: wid, spaceId: space, title: "Bericht", kind: "document" }) as { id: string }).id;
  run("UPDATE documents SET html=?,state=? WHERE page_id=?", STORED, htmlState(STORED), pageId);
  const flag = (pid: string) => one<{ caption_numbers: number }>("SELECT caption_numbers FROM pages WHERE id=?", pid)!.caption_numbers;
  assert.equal(flag(pageId), 0, "off by default");
  command(owner, { action: "page.update", pageId, patch: { caption_numbers: true } });
  assert.equal(flag(pageId), 1);
  const copy = (command(owner, { action: "page.duplicate", pageId }) as { id: string }).id;
  assert.equal(flag(copy), 1, "a copy numbers too");

  const word = (await readExportZip((await exportDocx(owner, { pageId })).bytes)).get("word/document.xml")!.toString("utf8");
  assert.match(word, /<w:pStyle w:val="Caption"\/>.*?Abbildung <\/w:t><\/w:r><w:fldSimple w:instr=" SEQ Figure \\\* ARABIC "><w:r><w:t>1<\/w:t><\/w:r><\/w:fldSimple>.*?Ablauf der Freigabe/);
  assert.match(word, /SEQ Listing .*?Beispiel in TypeScript/);
  assert.match(word, /<\/w:tbl><w:p><w:pPr><w:pStyle w:val="Caption"\/><w:jc w:val="left"\/><\/w:pPr>.*?SEQ Table .*?Kosten 2026/, "the table's caption is the paragraph after it");

  const print = exportPrintHtml(owner, { pageId }).html;
  assert.match(print, /<span class="caption-label">Tabelle 1:<\/span> Kosten 2026/);

  const file = (await exportMarkdown(owner, { pageId, format: "markdown", includeSubpages: false })).bytes.toString("utf8");
  assert.match(file, /^---\nflowplan:\n {2}captions: numbered\n---/);
  assert.match(file, /Table: Kosten 2026/);
  const { splitFrontmatter } = await import("../lib/frontmatter");
  assert.equal(numberedInFrontmatter(splitFrontmatter(file).data), true);
  assert.equal(numberedInFrontmatter({ flowplan: { id: "x" } }), false);

  command(owner, { action: "page.update", pageId, patch: { caption_numbers: false } });
  const unnumbered = (await readExportZip((await exportDocx(owner, { pageId })).bytes)).get("word/document.xml")!.toString("utf8");
  assert.doesNotMatch(unnumbered, /SEQ /);
  assert.match(unnumbered, /Ablauf der Freigabe/);
  assert.doesNotMatch((await exportMarkdown(owner, { pageId, format: "markdown", includeSubpages: false })).bytes.toString("utf8"), /captions: numbered/);
});

test("AFFiNE: image and code captions become captions", async () => {
  const ws = sampleWorkspace();
  const plan = ws.docs.find((d) => d.id === IDS.plan)!;
  plan.doc = affinePage(IDS.plan, "Projektplan", [
    note([
      para("Vorher"),
      { id: "capImg", flavour: "affine:image", props: { sourceId: "blobPng", caption: "Das Logo" } },
      { id: "capCode", flavour: "affine:code", props: { text: { "$blocksuite:internal:text$": true, delta: [{ insert: "print(1)" }] }, language: "python", caption: "Hallo Welt" } },
    ]),
  ]);
  const tree = await parseImport("x.affine", affineFileV2(ws));
  const html = tree.pages.find((p) => p.key === `doc:${IDS.plan}`)!.html;
  const list = nodes(html.replace(/src="[^"]*"/g, 'src="/api/files/x"'));
  const image = list.find((n) => n.type === "image")!,
    code = list.find((n) => n.type === "codeBlock")!;
  assert.equal(image.attrs!.caption, "Das Logo");
  assert.equal(image.attrs!.alt, null, "the caption is not the alt text");
  assert.equal(code.attrs!.caption, "Hallo Welt");
  assert.doesNotMatch(html, /<em>Das Logo<\/em>/, "no extra paragraph");
});
