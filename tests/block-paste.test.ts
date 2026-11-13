// Where ⌘V puts copied or cut blocks when the caret is in text (#263,
// lib/block-paste.ts): above a non-empty textblock at its start, below it
// at its end, in place of an empty one, splitting it in the middle – also
// in list items, toggles, callouts and quotes.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Window } from "happy-dom";
import { EditorState, NodeSelection, TextSelection } from "@tiptap/pm/state";
import { DOMParser as PMParser, DOMSerializer, Slice, type Node as PMNode } from "@tiptap/pm/model";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-block-paste-"));
const win = new Window({ url: "https://flowplan.test/" });
const g = globalThis as Record<string, unknown>;
for (const key of ["window", "document", "navigator", "Node", "HTMLElement", "Element", "getComputedStyle", "MutationObserver", "DOMParser"]) {
  if (!(key in g)) g[key] = key === "window" ? win : (win as unknown as Record<string, unknown>)[key];
}
after(async () => {
  await win.happyDOM.close();
});

const { documentSchema } = await import("../lib/document-schema");
const { blockPaste } = await import("../lib/block-paste");
const schema = documentSchema();
const parse = (html: string) => {
  const el = document.createElement("div");
  el.innerHTML = html;
  return PMParser.fromSchema(schema).parse(el as never);
};
// The document as short HTML: tags and text only.
const html = (doc: PMNode) => {
  const el = document.createElement("div");
  el.appendChild(DOMSerializer.fromSchema(schema).serializeFragment(doc.content, { document: document as never }) as never);
  return el.innerHTML.replace(/ [a-z-]+="[^"]*"/g, "").replace(/<label>.*?<\/label>/g, "");
};
// What the block clipboard holds: blocks, closed on both sides.
const blocks = (h: string) => new Slice(parse(h).content, 0, 0);
const BRAVO = blocks("<p>Bravo</p>");
// The caret `offset` characters into the text `word`.
function at(doc: PMNode, word: string, offset: number | "end") {
  let pos = -1;
  doc.descendants((n, p) => {
    if (pos < 0 && n.isText && n.text === word) pos = p;
    return pos < 0;
  });
  assert.ok(pos >= 0, word);
  return pos + (offset === "end" ? word.length : offset);
}
// ⌘V as the editor does it: the block rule, else ProseMirror's own paste.
function paste(h: string, word: string, offset: number | "end", slice = BRAVO) {
  const doc = parse(h);
  const state = EditorState.create({ schema, doc, selection: TextSelection.create(doc, at(doc, word, offset)) });
  const tr = blockPaste(state, slice) ?? state.tr.replaceSelection(slice);
  const { $from } = tr.selection;
  return { html: html(tr.doc), caret: `${$from.parent.textContent}@${$from.parentOffset}` };
}

test("in a paragraph: above at the start, below at the end, split in the middle", () => {
  const doc = "<p>Alpha</p><p>Ende</p>";
  assert.deepEqual(paste(doc, "Ende", 0), { html: "<p>Alpha</p><p>Bravo</p><p>Ende</p>", caret: "Ende@0" });
  assert.deepEqual(paste(doc, "Ende", "end"), { html: "<p>Alpha</p><p>Ende</p><p>Bravo</p>", caret: "Bravo@5" });
  assert.equal(paste(doc, "Ende", 2).html, "<p>Alpha</p><p>En</p><p>Bravo</p><p>de</p>");
  // Several blocks of other kinds.
  assert.equal(paste(doc, "Ende", 0, blocks("<h2>X</h2><ul><li><p>L</p></li></ul>")).html, "<p>Alpha</p><h2>X</h2><ul><li><p>L</p></li></ul><p>Ende</p>");
});

test("an empty paragraph is replaced", () => {
  const doc = parse("<p>Alpha</p><p></p><p>Ende</p>");
  const state = EditorState.create({ schema, doc, selection: TextSelection.create(doc, 8) });
  assert.equal(blockPaste(state, BRAVO), null);
  assert.equal(html(state.tr.replaceSelection(BRAVO).doc), "<p>Alpha</p><p>Bravo</p><p>Ende</p>");
});

test("at the start of a heading: no empty heading is left above", () => {
  assert.deepEqual(paste("<h2>Ende</h2>", "Ende", 0), { html: "<p>Bravo</p><h2>Ende</h2>", caret: "Ende@0" });
  assert.equal(paste("<h2>Ende</h2>", "Ende", "end").html, "<h2>Ende</h2><p>Bravo</p>");
});

test("in list items: above or below the item, a list of the same kind joins it", () => {
  const list = "<ul><li><p>Eins</p></li><li><p>Ende</p></li><li><p>Drei</p></li></ul>";
  assert.deepEqual(paste(list, "Ende", 0), {
    html: "<ul><li><p>Eins</p></li></ul><p>Bravo</p><ul><li><p>Ende</p></li><li><p>Drei</p></li></ul>",
    caret: "Ende@0",
  });
  assert.deepEqual(paste(list, "Ende", "end"), {
    html: "<ul><li><p>Eins</p></li><li><p>Ende</p></li></ul><p>Bravo</p><ul><li><p>Drei</p></li></ul>",
    caret: "Bravo@5",
  });
  const item = blocks("<ul><li><p>L</p></li></ul>");
  assert.equal(paste(list, "Ende", 0, item).html, "<ul><li><p>Eins</p></li><li><p>L</p></li><li><p>Ende</p></li><li><p>Drei</p></li></ul>");
  assert.deepEqual(paste(list, "Ende", "end", item), {
    html: "<ul><li><p>Eins</p></li><li><p>Ende</p></li><li><p>L</p></li><li><p>Drei</p></li></ul>",
    caret: "L@1",
  });
  // Another kind of list stays a list of its own.
  assert.equal(
    paste(list, "Ende", 0, blocks("<ol><li><p>N</p></li></ol>")).html,
    "<ul><li><p>Eins</p></li></ul><ol><li><p>N</p></li></ol><ul><li><p>Ende</p></li><li><p>Drei</p></li></ul>",
  );
  // An item with nested items: above it at the start; at the end in the
  // item between its text and the nested ones (ProseMirror's paste).
  const nested = "<ul><li><p>Ende</p><ul><li><p>Kind</p></li></ul></li></ul>";
  assert.equal(paste(nested, "Ende", 0).html, "<p>Bravo</p><ul><li><p>Ende</p><ul><li><p>Kind</p></li></ul></li></ul>");
  assert.equal(paste(nested, "Ende", "end").html, "<ul><li><p>Ende</p><p>Bravo</p><ul><li><p>Kind</p></li></ul></li></ul>");
  // Tasks the same.
  const tasks = '<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>Ende</p></li></ul>';
  assert.equal(paste(tasks, "Ende", 0).html, "<p>Bravo</p><ul><li><div><p>Ende</p></div></li></ul>");
  assert.equal(paste(tasks, "Ende", "end").html, "<ul><li><div><p>Ende</p></div></li></ul><p>Bravo</p>");
});

test("in toggles, callouts and quotes: in the box, above or below the text", () => {
  for (const [open, close] of [
    ["<details><summary>T</summary><div>", "</div></details>"],
    ['<aside data-callout="note">', "</aside>"],
    ["<blockquote>", "</blockquote>"],
  ]) {
    const doc = `${open}<p>Ende</p>${close}`;
    const shown = (h: string) => html(parse(`${open}${h}${close}`));
    assert.deepEqual(paste(doc, "Ende", 0), { html: shown("<p>Bravo</p><p>Ende</p>"), caret: "Ende@0" }, open);
    assert.equal(paste(doc, "Ende", "end").html, shown("<p>Ende</p><p>Bravo</p>"), open);
    assert.equal(paste(doc, "Ende", 2).html, shown("<p>En</p><p>Bravo</p><p>de</p>"), open);
  }
});

test("text, code and selections go the usual way", () => {
  const doc = parse("<p>Alpha</p><p>Ende</p><pre><code>x = 1</code></pre>");
  const caret = (pos: number) => EditorState.create({ schema, doc, selection: TextSelection.create(doc, pos) });
  const start = at(doc, "Ende", 0);
  // Text copied from a selection: open on both sides, merges into the text.
  assert.equal(blockPaste(caret(start), new Slice(parse("<p>Bravo</p>").content, 1, 1)), null);
  // In code.
  assert.equal(blockPaste(caret(at(doc, "x = 1", 0)), BRAVO), null);
  // Over selected text, or with a block selected.
  assert.equal(blockPaste(EditorState.create({ schema, doc, selection: TextSelection.create(doc, start, start + 2) }), BRAVO), null);
  assert.equal(blockPaste(EditorState.create({ schema, doc, selection: NodeSelection.create(doc, 0) }), BRAVO), null);
});
