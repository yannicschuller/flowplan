// Property-based tests (fast-check, tests/helpers/properties.ts) of Markdown
// both ways: random documents of headings, paragraphs, lists, task lists,
// tables, code, quotes, links and marks with nasty text go to Markdown
// (lib/markdown.ts) and back (lib/markdown-import.ts). The source view
// ("Als Markdown bearbeiten") must give the document back as it was; the
// export must keep every block's text. Below them, the bugs they found.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { check, nastyText } from "./helpers/properties";
import { documentHtml } from "./helpers/document-arbitrary";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-properties-markdown-"));
const Y = await import("yjs");
const { htmlState, stateHtml, htmlJson } = await import("../lib/document-server");
const { htmlToMarkdown, markdownSource } = await import("../lib/markdown");
const { markdownToHtml } = await import("../lib/markdown-import");
const { chatTextToHtml, looksLikeChatText } = await import("../lib/chat-paste");

// The document as stored (HTML → Yjs → HTML).
const canonical = (html: string) => {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, htmlState(html));
  return stateHtml(doc);
};
// Markdown and back as the source view does it.
function sourceView(html: string) {
  const before = canonical(html);
  const source = markdownSource(before);
  const back = markdownToHtml(source.markdown, (href) => href, {
    source: true,
    blocks: (index) => source.blocks[index]?.html ?? null,
  });
  return { before, markdown: source.markdown, back: canonical(back) };
}
// Markdown and back as the export and the import do it.
function exported(html: string) {
  const before = canonical(html);
  const markdown = htmlToMarkdown(before, { url: (url) => url, linked: () => null });
  return { before, markdown, back: canonical(markdownToHtml(markdown, (href) => href)) };
}

/* ---------- Regressions found by the properties ---------- */

test("regression: runs that share a mark side by side keep it (no \"****\")", () => {
  for (const html of [
    '<p><strong>a<a href="https://example.test/">b</a></strong></p>',
    "<p><s>a<em>b</em></s></p>",
    '<p><s>!</s><a href="https://example.test/"><s>|</s></a>|</p>',
  ]) {
    const { markdown, before, back } = sourceView(html);
    assert.doesNotMatch(markdown, /\*\*\*\*|~~~~/);
    assert.equal(back, before, markdown);
    assert.equal(exported(html).back, before);
  }
  assert.equal(sourceView('<p><strong>a<a href="https://example.test/">b</a></strong></p>').markdown, "**a**<strong>[b](<https://example.test/>)</strong>\n");
});
test("regression: a delimiter next to a letter, a link, another delimiter or an emoji still reads as one", () => {
  for (const html of [
    // Inside: a link or the other delimiter.
    '<p><a href="https://example.test/"><s>x</s></a>中文</p>',
    '<p>中<strong><a href="https://example.test/">x</a></strong></p>',
    "<p><s><em>한</em></s>שלום</p>",
    // Outside: struck text, a combining accent, a zero-width space, an emoji.
    "<p><strong>!</strong><s>!</s></p>",
    "<p><strong>|</strong><s>|</s></p>",
    "<p>e\u0301<strong>!</strong></p>",
    "<p><strong>!</strong>\u200bx</p>",
    "<p>😀<strong>!</strong></p>",
    "<p><strong>😀</strong>x</p>",
  ]) {
    const { markdown, before, back } = sourceView(html);
    assert.equal(back, before, markdown);
    assert.equal(exported(html).back, before, markdown);
  }
  // Delimiters of one character form one run: stays Markdown.
  assert.equal(sourceView("<p>a<strong><em>x</em></strong>b</p>").markdown, "a***x***b\n");
});
test("regression: lists of the same kind one after the other stay apart", () => {
  for (const html of [
    "<ul><li><p>a</p></li></ul><ul><li><p>b</p></li></ul><ul><li><p>c</p></li></ul>",
    '<ol><li><p>a</p></li></ol><ol start="4"><li><p>b</p></li></ol>',
    '<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>a</p></li></ul><ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>b</p></li></ul>',
  ]) {
    const { markdown, before, back } = sourceView(html);
    assert.equal(back, before, markdown);
    assert.equal(exported(html).back, before, markdown);
  }
  assert.equal(sourceView("<ul><li><p>a</p></li></ul><ul><li><p>b</p></li></ul><ul><li><p>c</p></li></ul>").markdown, "- a\n\n* b\n\n- c\n");
  assert.equal(sourceView('<ol><li><p>a</p></li></ol><ol start="4"><li><p>b</p></li></ol>').markdown, "1. a\n\n4) b\n");
});
test("regression: no-break spaces and byte order marks at a block's ends, line separators in tables", () => {
  for (const html of [
    "<p>\u00a0indented\u00a0</p>",
    "<h2>\u00a0x</h2>",
    "<p>\ufeffx</p>",
    "<table><tr><th><p>a</p></th></tr><tr><td><p>\ufeffx</p></td></tr></table>",
    "<table><tr><th><p>a</p></th></tr><tr><td><p>b\u2028c|</p></td></tr></table>",
  ]) {
    const { markdown, before, back } = sourceView(html);
    assert.equal(back, before, markdown);
    assert.equal(exported(html).back, before, markdown);
  }
  assert.equal(sourceView("<p>\u00a0x</p>").markdown, "&#160;x\n");
});
test("regression: \"!\" and \"^\" right before a link, \"^[\" in a link's text", () => {
  for (const html of [
    '<p>!<a href="https://example.test/">link</a></p>',
    '<h1>^<a href="https://example.test/">!</a></h1>',
    '<p><a href="https://example.test/">^[x]</a></p>',
  ]) {
    const { markdown, before, back } = sourceView(html);
    assert.equal(back, before, markdown);
    assert.equal(exported(html).back, before, markdown);
  }
  assert.equal(sourceView('<p>!<a href="https://example.test/">link</a></p>').markdown, "\\![link](<https://example.test/>)\n");
});
test("regression: a paragraph of only \"#\", \"+\" or \"1.\" stays a paragraph", () => {
  for (const html of ["<p>#</p>", "<p>+</p>", "<p>1.</p>", "<blockquote><p>+</p></blockquote>", "<p>= <strong>x</strong></p>"]) {
    const { markdown, before, back } = sourceView(html);
    assert.equal(back, before, markdown);
    assert.equal(exported(html).back, before, markdown);
  }
  assert.equal(sourceView("<p>#</p>").markdown, "\\#\n");
});
test("regression: code with \"\\|\" in a table cell comes back as code", () => {
  for (const html of [
    "<table><tr><th><p>a</p></th></tr><tr><td><p><code>\\|</code>!</p></td></tr></table>",
    "<table><tr><th><p>a</p></th></tr><tr><td><p><code>a\\|b *c* &amp;</code></p></td></tr></table>",
  ]) {
    const { markdown, before, back } = sourceView(html);
    assert.equal(back, before, markdown);
    assert.equal(exported(html).back, before, markdown);
  }
});
