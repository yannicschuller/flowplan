import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-callout-symbols-"));
process.env.APP_URL = "https://flowplan.example.test";
const { calloutIcon, calloutColor, calloutFill, CALLOUT_COLOR_NAMES } = await import("../lib/callout-types");
const { cleanHtml, htmlState, stateHtml } = await import("../lib/document-server");
const { htmlToMarkdown } = await import("../lib/markdown");
const { markdownToHtml } = await import("../lib/markdown-import");
const { markdownToRawHtml } = await import("../lib/markdown-html");
const { documentXhtml } = await import("../lib/export-xhtml");
const { buildDocx } = await import("../lib/export-docx");
const { readExportZip } = await import("./helpers/read-export-zip");
const { parseHtml, renderNodes } = await import("../lib/importers/html");
const htmlBlocks = (html: string) => renderNodes(parseHtml(html).children);

// Callouts with their own emoji or symbol and colour (issue #72).
const context = { url: (url: string) => url, linked: () => null };
const roundTrip = (html: string) => {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, htmlState(html));
  return stateHtml(doc);
};

test("a callout symbol is a single emoji or symbol, nothing else", () => {
  for (const ok of ["💡", "⚠️", "★", "→", "✓", "©", "🇩🇪", "1️⃣", "👍🏽", "👨‍👩‍👧‍👦", " 🚀 "])
    assert.equal(calloutIcon(ok), ok.trim(), ok);
  for (const bad of [null, 3, "", "A", "ab", "§", "!", "💡💡", "💡 x", "<b>", "<img src=x onerror=alert(1)>", '"', "💡\u0000", "x".repeat(40), "🚀".repeat(20)])
    assert.equal(calloutIcon(bad), null, String(bad));
  assert.equal(calloutColor("green"), "green");
  for (const bad of ["#ff0000", "Green", "constructor", "toString", "", null]) assert.equal(calloutColor(bad), null);
  assert.equal(calloutFill("#2f9e44"), "eaf5ec");
});

test("symbol and colour survive the document store and the cleaning", () => {
  const html = roundTrip('<aside data-callout="tip" data-callout-icon="💡" data-callout-color="green"><p>Text</p></aside>');
  assert.match(html, /^<aside (?=[^>]*data-callout="tip")(?=[^>]*data-callout-icon="💡")(?=[^>]*data-callout-color="green")[^>]*><p>Text<\/p><\/aside>$/);
  // Without them the callout stays as before.
  assert.match(roundTrip('<aside data-callout="note"><p>x</p></aside>'), /<aside data-callout="note" class="editor-callout">/);
  // Unknown colours, markup, long strings and several symbols are dropped.
  for (const [icon, color] of [
    ["<script>", "#ff0000"],
    ["💡💡", "red;background:url(x)"],
    ["Hinweis", "GREEN"],
    ["a".repeat(100), "javascript:alert(1)"],
  ]) {
    const clean = cleanHtml(`<aside data-callout="note" data-callout-icon='${icon}' data-callout-color="${color}"><p>x</p></aside>`);
    assert.doesNotMatch(clean, /data-callout-icon|data-callout-color/, clean);
    assert.doesNotMatch(roundTrip(`<aside data-callout="note" data-callout-icon='${icon}' data-callout-color="${color}"><p>x</p></aside>`), /data-callout-icon|data-callout-color/);
  }
  // Only on callouts.
  assert.doesNotMatch(cleanHtml('<p data-callout-color="red" data-callout-icon="💡">x</p>'), /data-callout-/);
});

test("symbol and colour round-trip through Markdown and stay GitHub alerts", () => {
  const markdown = htmlToMarkdown('<aside data-callout="warning" data-callout-icon="🔥" data-callout-color="orange"><p>Hot <strong>stuff</strong></p><p>More</p></aside>', context);
  assert.equal(markdown.trim(), "> [!WARNING]\n> \n> 🔥 Hot **stuff**\n> \n> More\n> \n> <!-- flowplan:callout color=orange -->");
  const back = markdownToHtml(markdown);
  assert.match(back, /<aside data-callout="warning" data-callout-icon="🔥" data-callout-color="orange"><p>Hot <strong>stuff<\/strong><\/p>\s*<p>More<\/p><\/aside>/);
  // A callout starting with a list: the symbol stands on its own line.
  const list = htmlToMarkdown('<aside data-callout="note" data-callout-icon="★"><ul><li><p>One</p></li></ul></aside>', context);
  assert.match(list, /^> \[!NOTE\]\n> \n> ★\n> \n> - One/);
  assert.match(markdownToHtml(list), /<aside data-callout="note" data-callout-icon="★"><ul>\s*<li>One<\/li>\s*<\/ul>\s*<\/aside>/);
  // Only a colour; only a symbol and an empty callout.
  const colour = htmlToMarkdown('<aside data-callout="tip" data-callout-color="pink"><p>x</p></aside>', context);
  assert.match(markdownToHtml(colour), /<aside data-callout="tip" data-callout-color="pink"><p>x<\/p><\/aside>/);
  const empty = htmlToMarkdown('<aside data-callout="tip" data-callout-icon="✓"><p></p></aside>', context);
  assert.match(markdownToHtml(empty), /<aside data-callout="tip" data-callout-icon="✓"><p><\/p><\/aside>/);
  // An emoji leading a GitHub alert becomes its symbol; words stay text.
  assert.match(markdownToHtml("> [!TIP]\n> 💡 Use the slash menu"), /<aside data-callout="tip" data-callout-icon="💡"><p>Use the slash menu<\/p>/);
  assert.match(markdownToHtml("> [!TIP]\n> Use it 💡"), /<aside data-callout="tip"><p>Use it 💡<\/p>/);
  assert.match(markdownToHtml("> [!NOTE]\n> — dash"), /<aside data-callout="note"><p>— dash<\/p>/);
  // A wrong colour comment is no colour; outside callouts it disappears.
  assert.doesNotMatch(markdownToHtml("> [!NOTE]\n> x\n>\n> <!-- flowplan:callout color=hotpink -->"), /data-callout-color/);
  assert.doesNotMatch(markdownToHtml("text\n\n<!-- flowplan:callout color=red -->"), /flowplan|callout/);
  assert.doesNotMatch(markdownToRawHtml("text\n\n<!-- flowplan:callout color=red -->"), /&lt;|data-callout/);
});

test("Notion's Markdown callouts keep their emoji", () => {
  assert.match(markdownToHtml("<aside>\n💡 Notion tip\n\n</aside>"), /<aside data-callout="note" data-callout-icon="💡"><p>Notion tip<\/p>\s*<\/aside>/);
  assert.match(markdownToHtml("Before\n\n<aside>💡 One line</aside>\n\nAfter"), /<p>Before<\/p>\s*<aside data-callout="note" data-callout-icon="💡"><p>One line<\/p>\s*<\/aside>\s*<p>After<\/p>/);
  // Inside a code block nothing changes.
  assert.match(markdownToHtml("```\n<aside>💡 x</aside>\n```"), /<pre><code>&lt;aside&gt;💡 x&lt;\/aside&gt;/);
});

test("exports and imports carry the symbol and colour", async () => {
  const html = '<aside data-callout="note" data-callout-icon="🚀" data-callout-color="purple"><p>Launch</p></aside>';
  const xhtml = documentXhtml(html, { url: (u) => u, image: () => null });
  assert.match(xhtml, /<aside class="callout callout-note" style="border-color: #8f4ad9; background: #[0-9a-f]{6}"><p class="callout-title">🚀 [^<]+<\/p>/);
  const bytes = await buildDocx({ title: "T", sections: [{ title: "T", html }], file: () => null, url: (raw) => raw });
  const document = (await readExportZip(bytes)).get("word/document.xml")!.toString("utf8");
  assert.match(document, /w:color="8F4AD9"/);
  assert.match(document, /🚀 /);
  // The HTML import of other tools keeps them (and drops wrong ones).
  assert.match(htmlBlocks(html), /data-callout-icon="🚀" data-callout-color="purple"/);
  assert.doesNotMatch(htmlBlocks('<aside data-callout="note" data-callout-icon="xx" data-callout-color="#fff"><p>x</p></aside>'), /data-callout-icon|data-callout-color/);
  assert.ok(CALLOUT_COLOR_NAMES.length === 9);
});
