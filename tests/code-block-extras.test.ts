// Code block preview (#92), line numbers (#93), collapsing (#94) and
// Mermaid code arriving with its diagram shown (#95).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EditorState } from "@tiptap/pm/state";
import {
  effectiveView,
  fenceMeta,
  formatLineRanges,
  highlightedLines,
  importedCodeAttributes,
  isCollapsed,
  lineCount,
  normalizeLineRanges,
  optionAttributes,
  optionsFromAttributes,
  parseFenceMeta,
  parseLineRanges,
  previewKind,
  splitInfo,
} from "../lib/code-block-options";
import { htmlState, stateHtml, markdownHtml } from "../lib/document-server";
import { markdownToHtml } from "../lib/markdown-import";
import { htmlToMarkdown, markdownSource } from "../lib/markdown";
import { documentSchema } from "../lib/document-schema";
import { codeLinesKey, codeLinesPlugin, lineStarts } from "../lib/code-lines-plugin";
import { htmlPreviewDocument, HTML_PREVIEW_CSP, latexFormulas, svgImage } from "../lib/code-preview";
import { typstError } from "../lib/typst-render";
import { TYPST_FONTS } from "../lib/typst-assets";
import { chatTextToHtml, looksLikeChatText } from "../lib/chat-paste";
import { renderNodes, parseHtml } from "../lib/importers/html";
import { customHostRoute } from "../lib/custom-domain-routing";
process.env.FLOWPLAN_DATA_DIR ||= mkdtempSync(join(tmpdir(), "flowplan-code-extras-"));

function roundtrip(html: string) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, htmlState(html));
  const result = stateHtml(doc);
  doc.destroy();
  return result;
}
const preOf = (html: string) => /<pre[^>]*>/.exec(html)?.[0] || "";

test("line ranges: parsed, merged, shifted by the start number and normalised", () => {
  assert.deepEqual(parseLineRanges("3-5, 8"), [[3, 5], [8, 8]]);
  assert.deepEqual(parseLineRanges("8, 5-3, 4 x 9–10"), [[3, 5], [8, 10]]);
  assert.deepEqual(parseLineRanges("0, -2, abc"), []);
  assert.equal(normalizeLineRanges(" 3 - 5 ,8 "), "3-5,8");
  // Shown from 10: lines 12-13 are the third and fourth.
  assert.equal(normalizeLineRanges("12-13", 10), "3-4");
  assert.equal(formatLineRanges(parseLineRanges("3-4"), 9), "12-13");
  assert.deepEqual([...highlightedLines("2,4-5")], [2, 4, 5]);
  assert.equal(highlightedLines("1-9999999").size, 10_000);
  assert.equal(lineCount("a\nb\nc\n"), 3);
  assert.equal(lineCount(""), 1);
});

test("fence meta in the common conventions, written back as in the brief", () => {
  assert.deepEqual(parseFenceMeta("{3-5} showLineNumbers startLine=10"), { highlightLines: "3-5", lineNumbers: true, startLine: 10 });
  assert.deepEqual(parseFenceMeta("showLineNumbers{7} {1,3}"), { lineNumbers: true, startLine: 7, highlightLines: "1,3" });
  assert.deepEqual(parseFenceMeta("showLineNumbers=12"), { lineNumbers: true, startLine: 12 });
  assert.deepEqual(parseFenceMeta('hl_lines="3 4 5" linenums="2"'), { highlightLines: "3-5", lineNumbers: true, startLine: 2 });
  assert.deepEqual(parseFenceMeta('title="a b" view=split collapsed collapsedLines=15'), { view: "split", collapsed: true, collapsedLines: 15 });
  assert.deepEqual(parseFenceMeta("showLineNumbers=false view=nonsense"), { lineNumbers: false });
  assert.equal(fenceMeta({ highlightLines: "3-5", lineNumbers: true, startLine: 10 }), "{3-5} showLineNumbers startLine=10");
  assert.equal(fenceMeta({ view: "preview", collapsed: false, collapsedLines: 5 }), "view=preview collapsed=false collapsedLines=5");
  assert.equal(fenceMeta({}), "");
  assert.deepEqual(splitInfo("ts {3} showLineNumbers"), { language: "ts", meta: "{3} showLineNumbers" });
  assert.deepEqual(splitInfo("python"), { language: "python", meta: "" });
});

test("preview kinds, default views and collapsing", () => {
  assert.equal(previewKind("html"), "html");
  assert.equal(previewKind("xhtml"), "html");
  assert.equal(previewKind("xml", '<?xml version="1.0"?>\n<svg viewBox="0 0 1 1"></svg>'), "svg");
  assert.equal(previewKind("svg", "<svg></svg>"), "svg");
  assert.equal(previewKind("xml", "<root/>"), null);
  assert.equal(previewKind("md"), "markdown");
  assert.equal(previewKind("mermaid"), "mermaid");
  assert.equal(previewKind("latex"), "latex");
  assert.equal(previewKind("tex"), "latex");
  assert.equal(previewKind("typst"), "typst");
  assert.equal(previewKind("javascript"), null);
  // Readers see the preview, editors the code – unless the block says.
  assert.equal(effectiveView(null, "html", false), "preview");
  assert.equal(effectiveView(null, "html", true), "code");
  assert.equal(effectiveView("split", "html", false), "split");
  assert.equal(effectiveView("preview", null, false), "code");
  // Collapsed: longer than 25 lines, or as set; never shorter than the limit.
  assert.equal(isCollapsed(null, 26, null), true);
  assert.equal(isCollapsed(null, 25, null), false);
  assert.equal(isCollapsed(true, 12, null), true);
  assert.equal(isCollapsed(true, 8, null), false);
  assert.equal(isCollapsed(false, 80, 20), false);
  assert.equal(isCollapsed(true, 18, 20), false);
});

test("the options travel through HTML and the stored document (Yjs)", () => {
  const html =
    '<pre data-code-view="split" data-line-numbers="true" data-start-line="10" data-highlight-lines="2-3,5" data-collapsed="false" data-collapsed-lines="15"><code class="language-html">&lt;b&gt;hi&lt;/b&gt;\n</code></pre>';
  const once = roundtrip(html);
  for (const attr of ['data-code-view="split"', 'data-line-numbers="true"', 'data-start-line="10"', 'data-highlight-lines="2-3,5"', 'data-collapsed="false"', 'data-collapsed-lines="15"'])
    assert.ok(once.includes(attr), attr);
  assert.equal(roundtrip(once), once);
  // Defaults write nothing; invalid values are dropped.
  assert.equal(preOf(roundtrip('<pre><code class="language-python">x = 1</code></pre>')), "<pre>");
  const bad = roundtrip('<pre data-code-view="script" data-start-line="-4" data-highlight-lines="x" data-collapsed-lines="9999"><code>x</code></pre>');
  assert.equal(preOf(bad), '<pre data-collapsed-lines="10">');
  assert.deepEqual(optionAttributes({ view: null, startLine: 1, highlightLines: "" }), {});
  assert.equal(optionsFromAttributes(() => null, "mermaid").view, "preview");
  assert.equal(optionsFromAttributes(() => null, "python").view, null);
});

test("Markdown export writes the options as fence meta; import reads them back", () => {
  const html =
    '<pre data-line-numbers="true" data-start-line="10" data-highlight-lines="3-5"><code class="language-typescript">a\nb\nc\nd\ne\n</code></pre>' +
    '<pre data-code-view="split" data-collapsed="true"><code class="language-html">&lt;p&gt;x&lt;/p&gt;</code></pre>' +
    '<pre><code class="language-python">print(1)</code></pre>';
  const markdown = htmlToMarkdown(html, { url: (url) => url, linked: () => null });
  assert.match(markdown, /```typescript \{3-5\} showLineNumbers startLine=10\n/);
  assert.match(markdown, /```html view=split collapsed\n/);
  assert.match(markdown, /```python\n/);
  const back = roundtrip(markdownToHtml(markdown));
  assert.match(back, /<pre data-line-numbers="true" data-start-line="10" data-highlight-lines="3-5"><code class="language-typescript">/);
  assert.match(back, /<pre data-code-view="split" data-collapsed="true"><code class="language-html">/);
  assert.match(back, /<pre><code class="language-python">/);
  // Other tools' conventions.
  assert.match(roundtrip(markdownToHtml("```js showLineNumbers{5} {2}\nx\ny\n```")), /data-line-numbers="true" data-start-line="5" data-highlight-lines="2"/);
  // The page import's simple converter too.
  assert.match(markdownHtml("```ts {2} showLineNumbers\na\nb\n```"), /<pre data-line-numbers="true" data-highlight-lines="2"><code class="language-typescript">/);
});

test("#95: Mermaid fences become code blocks showing the diagram, in every Markdown path", () => {
  const source = "flowchart LR\n  A --> B\n";
  for (const html of [markdownToHtml("```mermaid\n" + source + "```"), markdownHtml("```mermaid\n" + source + "```")]) {
    const stored = roundtrip(html);
    assert.match(stored, /<pre data-code-view="preview"><code class="language-mermaid">flowchart LR\n {2}A --&gt; B\n?<\/code><\/pre>/);
    assert.doesNotMatch(stored, /data-mermaid/);
  }
  // Its own view wins.
  assert.match(roundtrip(markdownToHtml("```mermaid view=code\nflowchart LR\n```")), /<pre data-code-view="code">/);
  // HTML from elsewhere (pasted, imported): a mermaid code block shows the diagram.
  assert.match(roundtrip('<pre><code class="language-mermaid">graph TD\nA--&gt;B</code></pre>'), /<pre data-code-view="preview">/);
  // Other languages keep the code.
  assert.equal(importedCodeAttributes("python"), "");
  assert.equal(importedCodeAttributes("mermaid"), ' data-code-view="preview"');
});

test("the Markdown source view keeps Mermaid blocks and mermaid code blocks apart", () => {
  const html = '<div data-mermaid="graph TD&#10;A --&gt; B">graph</div><pre><code class="language-mermaid">graph LR\nX--&gt;Y\n</code></pre>';
  const before = roundtrip(html);
  const source = markdownSource(before);
  assert.match(source.markdown, /```mermaid\ngraph TD/);
  // (A mermaid code block read from HTML shows its diagram.)
  assert.match(source.markdown, /```mermaid view=preview\ngraph LR/);
  const after = roundtrip(markdownToHtml(source.markdown, undefined, { source: true }));
  assert.match(after, /data-mermaid="graph TD/);
  assert.match(after, /<pre data-code-view="preview"><code class="language-mermaid">graph LR/);
  // Without a view of its own it names "code" (and stays a code block).
  const plain = markdownSource(roundtrip('<pre data-code-view="code"><code class="language-mermaid">graph LR</code></pre>'));
  assert.match(plain.markdown, /```mermaid view=code\n/);
});

test("#95: HTML, Confluence and Mermaid's own markup keep the language", () => {
  const html = renderNodes(
    parseHtml(
      '<pre class="code"><code class="language-Mermaid">graph TD\nA--&gt;B</code></pre><div class="mermaid">\nsequenceDiagram\nA->>B: hi\n</div><pre class="syntaxhighlighter-pre" data-syntaxhighlighter-params="brush: java; gutter: false">int x;</pre><pre><code>plain</code></pre>',
    ).children,
  );
  assert.match(html, /<pre data-code-view="preview"><code class="language-mermaid">graph TD\nA--&gt;B<\/code><\/pre>/);
  assert.match(html, /<pre data-code-view="preview"><code class="language-mermaid">sequenceDiagram\nA-&gt;&gt;B: hi<\/code><\/pre>/);
  assert.match(html, /<pre><code class="language-java">int x;<\/code><\/pre>/);
  assert.match(html, /<pre><code>plain<\/code><\/pre>/);
});

test("pasted Markdown with a mermaid fence becomes a code block showing the diagram", () => {
  const text = "Here:\n\n```mermaid\ngraph TD\nA-->B\n```\n";
  assert.ok(looksLikeChatText(text));
  assert.ok(!looksLikeChatText("just ``` some text"));
  const html = chatTextToHtml(text);
  assert.match(html, /<pre><code class="language-mermaid">/);
  assert.match(roundtrip(html), /<pre data-code-view="preview"><code class="language-mermaid">/);
});

test("line numbers and highlighted lines are decorations of the editor, never document content", () => {
  assert.deepEqual(lineStarts("ab\ncd\n\ne"), [0, 3, 6, 7]);
  const schema = documentSchema();
  const make = (attrs: Record<string, unknown>, text = "one\ntwo\nthree") =>
    schema.nodes.doc.create(null, [schema.nodes.codeBlock.create({ language: "javascript", ...attrs }, schema.text(text))]);
  let byDefault = false;
  const listeners = new Set<() => void>();
  const plugin = codeLinesPlugin("codeBlock", () => byDefault, (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  });
  const decorations = (doc: ReturnType<typeof make>) => {
    const state = EditorState.create({ schema, doc, plugins: [plugin] });
    return codeLinesKey.getState(state)!.find();
  };
  assert.equal(decorations(make({})).length, 0);
  const numbered = decorations(make({ lineNumbers: true, startLine: 7 }));
  assert.equal(numbered.length, 3);
  // Widgets at the start of each line (positions inside the block).
  assert.deepEqual(numbered.map((d) => d.from), [1, 5, 9]);
  assert.deepEqual(
    numbered.map((d) => (d.spec as { key: string }).key),
    ["line:7:1:0", "line:8:1:0", "line:9:1:0"],
  );
  // A highlighted line without numbers: a marker and its text marked.
  const marked = decorations(make({ highlightLines: "2" }));
  assert.equal(marked.length, 2);
  assert.deepEqual(marked.map((d) => [d.from, d.to]).sort(), [[5, 5], [5, 8]].sort());
  // The personal default.
  byDefault = true;
  assert.equal(decorations(make({})).length, 3);
  assert.equal(decorations(make({ lineNumbers: false })).length, 0);
  // Nothing of it in the document's HTML.
  assert.doesNotMatch(roundtrip('<pre data-line-numbers="true"><code>a\nb</code></pre>'), /code-line-number/);
});

test("HTML previews run nothing and load nothing; SVG, LaTeX and Typst helpers", () => {
  const doc = htmlPreviewDocument("<html><head><script>alert(1)</script></head><body><img src=https://example.org/x.png></body></html>");
  // The policy comes first, before anything of the block.
  assert.ok(doc.indexOf("Content-Security-Policy") < doc.indexOf("<script>"));
  assert.match(HTML_PREVIEW_CSP, /default-src 'none'/);
  assert.doesNotMatch(HTML_PREVIEW_CSP, /script-src|connect-src|https?:/);
  const svg = svgImage('<svg viewBox="0 0 10 10"><circle r="4"/></svg>');
  assert.ok("url" in svg && decodeURIComponent(svg.url).includes('xmlns="http://www.w3.org/2000/svg"'));
  assert.deepEqual(latexFormulas("$$a^2$$\n\n\\[ b \\]\n\nc + d"), ["a^2", "b", "c + d"]);
  assert.equal(latexFormulas("\\documentclass{article}\n\\begin{document}x\\end{document}"), null);
  const line = (n: number) => `Zeile ${n}`;
  assert.equal(typstError([{ range: "3:4-3:9", severity: "error", message: "unknown variable: x" }], line), "Zeile 3: unknown variable: x");
  assert.equal(typstError([], line), null);
  assert.ok(TYPST_FONTS.includes("NewCMMath-Regular.otf"));
  // A publication on its own domain loads the Typst files too.
  assert.deepEqual(customHostRoute({ status: "verified", token: "abc", verifyToken: "v" } as never, "/typst/compiler.wasm", "GET"), { kind: "next" });
});

test("the Typst route serves the compiler, renderer and fonts, nothing else", async () => {
  const { GET } = await import("../app/typst/[file]/route");
  const get = (file: string) => GET(new Request(`http://x/typst/${file}`), { params: Promise.resolve({ file }) });
  const wasm = await get("renderer.wasm");
  assert.equal(wasm.status, 200);
  assert.equal(wasm.headers.get("content-type"), "application/wasm");
  const font = await get("LibertinusSerif-Regular.otf");
  assert.equal(font.status, 200);
  assert.equal(font.headers.get("content-type"), "font/otf");
  for (const name of ["../package.json", "NewCM10-Regular.otf", "constructor", "__proto__"]) assert.equal((await get(name)).status, 404, name);
});
