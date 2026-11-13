// Markdown conversion stays linear in the length of the text: the block
// colours of list items (#238) are taken from the HTML without rescanning
// long runs of whitespace (once quadratic: 100,000 spaces took seconds).
import { test } from "node:test";
import assert from "node:assert/strict";
import { markdownToRawHtml } from "../lib/markdown-html";

function timed(markdown: string) {
  const start = performance.now();
  const html = markdownToRawHtml(markdown);
  return { html, ms: performance.now() - start };
}

test("a list item with a long run of spaces converts quickly", () => {
  const code = timed("- `a" + " ".repeat(100_000) + "b`");
  assert.ok(code.ms < 1500, `took ${Math.round(code.ms)} ms`);
  assert.match(code.html, /<li><code>a +b<\/code><\/li>/);
  const lines = timed("- a" + " \n  ".repeat(30_000) + "b");
  assert.ok(lines.ms < 1500, `took ${Math.round(lines.ms)} ms`);
  const marked = timed("- x" + " ".repeat(100_000) + "y <!-- flowplan:color red -->\n- z");
  assert.ok(marked.ms < 1500, `took ${Math.round(marked.ms)} ms`);
  assert.match(marked.html, /<li data-block-color="red">x +y<\/li>/);
});

test("list item colours still land on their item, whitespace before the marker dropped", () => {
  const html = markdownToRawHtml("- Rot  <!-- flowplan:color red -->\n- Normal\n  - Innen <!-- flowplan:color blue -->");
  assert.match(html, /<li data-block-color="red">Rot<\/li>/);
  assert.match(html, /<li>Normal\n?<ul>\n?<li data-block-color="blue">Innen<\/li>/);
  assert.doesNotMatch(html, /flowplan-color/);
});
