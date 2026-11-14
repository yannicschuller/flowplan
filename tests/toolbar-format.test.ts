// The toolbar's text style and alignment menus (#278): what the text at the
// caret is now, on the document schema.
import { test } from "node:test";
import assert from "node:assert/strict";
import { getSchema } from "@tiptap/core";
import { EditorState, TextSelection, NodeSelection } from "@tiptap/pm/state";
import { DOMParser as PMDOMParser } from "@tiptap/pm/model";
import { Window } from "happy-dom";

const win = new Window();
const g = globalThis as Record<string, unknown>;
for (const key of ["window", "document", "navigator", "Node", "HTMLElement", "Element", "getComputedStyle", "DOMParser"]) {
  if (!(key in g)) g[key] = key === "window" ? win : (win as unknown as Record<string, unknown>)[key];
}
const { documentExtensions } = await import("../lib/document-schema");
const { alignmentAt, blockStyleAt, blockStyleShort, blockStyleShortcut, ALIGNMENTS, ALIGN_SHORTCUTS, BLOCK_STYLES } = await import("../lib/toolbar-format");
const schema = getSchema(documentExtensions);

function state(html: string, text: string) {
  const el = win.document.createElement("div");
  el.innerHTML = html;
  const doc = PMDOMParser.fromSchema(schema).parse(el as unknown as HTMLElement);
  let at = -1;
  doc.descendants((node, pos) => {
    if (at < 0 && node.isText && node.text?.includes(text)) at = pos + 1;
  });
  assert.ok(at > 0, `"${text}" not found`);
  return EditorState.create({ doc, selection: TextSelection.create(doc, at) });
}

test("the alignment of the text at the caret, left when none is set", () => {
  assert.equal(alignmentAt(state("<p>Eins</p>", "Eins")), "left");
  assert.equal(alignmentAt(state('<p style="text-align: right">Rechts</p>', "Rechts")), "right");
  assert.equal(alignmentAt(state('<h2 style="text-align: center">Mitte</h2>', "Mitte")), "center");
  assert.equal(alignmentAt(state('<p style="text-align: justify">Block</p>', "Block")), "justify");
  // Code cannot be aligned.
  assert.equal(alignmentAt(state("<pre><code>let a</code></pre>", "let a")), null);
});

test("the menu offers what TextAlign is configured with, with TipTap's keys", () => {
  const align = schema.nodes.paragraph.spec.attrs?.textAlign;
  assert.ok(align, "paragraphs can be aligned");
  assert.deepEqual([...ALIGNMENTS], ["left", "center", "right", "justify"]);
  // ⌘⇧L is the block link (#88), not "align left".
  assert.equal(ALIGN_SHORTCUTS.left, undefined);
  assert.equal(ALIGN_SHORTCUTS.center, "Mod+Shift+E");
});

test("the block style at the caret: text or a heading level", () => {
  assert.equal(blockStyleAt(state("<p>Text</p>", "Text")), "paragraph");
  assert.equal(blockStyleAt(state("<h3>Drei</h3>", "Drei")), 3);
  assert.equal(blockStyleAt(state("<ul><li><p>Punkt</p></li></ul>", "Punkt")), "paragraph");
  assert.equal(blockStyleAt(state("<pre><code>x = 1</code></pre>", "x = 1")), null);
  // A heading level the menu does not offer shows no level.
  assert.equal(blockStyleAt(state("<h6>Sechs</h6>", "Sechs")), null);
  const doc = state("<p>a</p><hr><p>b</p>", "a").doc;
  let rule = -1;
  doc.forEach((node, offset) => {
    if (node.type.name === "horizontalRule") rule = offset;
  });
  assert.equal(blockStyleAt(EditorState.create({ doc, selection: NodeSelection.create(doc, rule) })), null);
});

test("names and shortcuts of the block styles", () => {
  assert.deepEqual(BLOCK_STYLES, ["paragraph", 1, 2, 3, 4]);
  assert.deepEqual(BLOCK_STYLES.map(blockStyleShort), ["Text", "H1", "H2", "H3", "H4"]);
  assert.equal(blockStyleShort(null), "Text");
  assert.deepEqual(BLOCK_STYLES.map(blockStyleShortcut), ["Mod+Alt+0", "Mod+Alt+1", "Mod+Alt+2", "Mod+Alt+3", "Mod+Alt+4"]);
});
