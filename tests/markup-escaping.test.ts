// Text taken out of untrusted markup (imports, mail, calendars, code blocks)
// only ever goes back into HTML escaped. These pin down the places code
// scanning flags for tag stripping: the stripping is for plain text, the
// escaping on the way out is what keeps markup inert.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-markup-escaping-"));
const { parseHtml, renderNodes } = await import("../lib/importers/html");
const { cleanHtml } = await import("../lib/document-server");
const { renderCode } = await import("../lib/code-highlight");
const { numberedCode } = await import("../components/code-block-static");
const { URL_PATTERN } = await import("../lib/footnotes");
const { imageFileId } = await import("../lib/page-appearance");
const { markdownToRawHtml } = await import("../lib/markdown-html");
const { noteHtml, rowNoteText } = await import("../lib/contacts");

const PAYLOADS = [
  "<scr<script>ipt>alert(1)</script >",
  "<script>alert(1)</script >",
  "x--!><img src=x onerror=alert(1)>",
  "x--><img src=x onerror=alert(1)>",
];
const hasTag = (html: string) => /<(script|img)\b/i.test(html);

test("imported ids with comment ends stay inside the attribute", () => {
  for (const payload of PAYLOADS) {
    const quoted = payload.replaceAll('"', "&quot;");
    for (const source of [
      `<p id="${quoted}">a</p>`,
      `<span id="${quoted}">a</span><p>b</p>`,
      `<p><a name="${quoted}"></a>c</p>`,
    ]) {
      const html = renderNodes(parseHtml(source).children);
      assert.ok(!hasTag(html), html);
      assert.ok(!hasTag(cleanHtml(html)), html);
      assert.doesNotMatch(html, /<!--/);
    }
  }
});

test("code blocks are escaped before they become innerHTML", () => {
  for (const payload of PAYLOADS) {
    const html = numberedCode(renderCode(payload, null), payload, true, 1, new Set([1]));
    assert.ok(!hasTag(html), html);
    assert.match(html, /&lt;/);
  }
});

test("footnote links are web addresses only", () => {
  const parts = "javascript:alert(1) data:text/html,x https://example.org/a".split(URL_PATTERN);
  assert.deepEqual(parts.filter((_, i) => i % 2), ["https://example.org/a"]);
});

test("covers are uploaded files only", () => {
  assert.equal(imageFileId("javascript:alert(1)"), undefined);
  assert.equal(imageFileId('/api/files/00000000-0000-0000-0000-000000000000" onerror="x'), undefined);
  assert.ok(imageFileId("/api/files/00000000-0000-0000-0000-000000000000"));
});

test("Markdown notes, captions and toggles come out escaped", () => {
  for (const payload of PAYLOADS) {
    const html = markdownToRawHtml(
      `Text[^1] ^[${payload}]\n\n[^1]: ${payload}\n\n<details><summary>${payload}</summary>\n\nBody\n\n</details>\n\n| a |\n| - |\n| b |\n\nTable: ${payload}\n`,
    );
    assert.ok(!hasTag(html), html);
  }
});

test("a record's note goes out as text and back escaped", () => {
  for (const payload of PAYLOADS) {
    const text = rowNoteText(`<p>${payload}</p>`);
    assert.ok(!hasTag(noteHtml(text)), noteHtml(text));
  }
});
