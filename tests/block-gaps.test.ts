import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState, NodeSelection, TextSelection } from "@tiptap/pm/state";
import { GapCursor } from "@tiptap/pm/gapcursor";
import type { Node } from "@tiptap/pm/model";
import { documentSchema } from "../lib/document-schema";
import { paragraphAtGap, paragraphOnEnter } from "../lib/block-gaps";
import { blockForInsert, documentBlocks, emptyBlockNear } from "../lib/document-blocks";

// Room for new blocks between blocks without text (#261) and the toolbar's
// "+" adding a block below (#261).
const schema = documentSchema();
const p = (text = "") => schema.nodes.paragraph.create(null, text ? schema.text(text) : undefined);
const doc = (...nodes: Node[]) => schema.nodes.doc.create(null, nodes);
const state = (...nodes: Node[]) => EditorState.create({ schema, doc: doc(...nodes) });
const table = () =>
  schema.nodes.table.create(null, schema.nodes.tableRow.create(null, schema.nodes.tableCell.create(null, p("Zelle"))));
const image = () => schema.nodes.image.create({ src: "/api/files/x.png", alt: "Bild" });
const math = () => schema.nodes.mathBlock.create({ expression: "x^2" });
const names = (s: EditorState) => {
  const out: string[] = [];
  s.doc.forEach((n) => out.push(n.type.name + (n.textContent ? `:${n.textContent}` : "")));
  return out;
};

test("a gap between a table and an image takes an empty paragraph with the caret", () => {
  const s = state(table(), image(), p("Ende"));
  const gap = s.doc.child(0).nodeSize;
  const tr = paragraphAtGap(s, gap);
  assert.ok(tr);
  const next = s.apply(tr);
  assert.deepEqual(names(next), ["table:Zelle", "paragraph", "image", "paragraph:Ende"]);
  assert.ok(next.selection instanceof TextSelection);
  assert.equal(next.selection.from, gap + 1);
  // Above the first block as well.
  assert.deepEqual(names(s.apply(paragraphAtGap(s, 0)!)), ["paragraph", "table:Zelle", "image", "paragraph:Ende"]);
});

test("no gap paragraph next to text or inside a table", () => {
  const s = state(p("Text"), image(), p("Ende"));
  // Between a paragraph and an image: the paragraph is the place to type.
  assert.equal(paragraphAtGap(s, s.doc.child(0).nodeSize), null);
  const t = state(table(), p("Ende"));
  // Inside the cell's text, or between table internals.
  assert.equal(paragraphAtGap(t, 3), null);
  assert.equal(paragraphAtGap(t, 1), null);
  assert.equal(paragraphAtGap(t, -1), null);
});

test("↵ on a selected image or table adds a paragraph after it – also as the first block", () => {
  const s = state(image(), math(), p("Ende"));
  const selected = s.apply(s.tr.setSelection(NodeSelection.create(s.doc, 0)));
  const next = selected.apply(paragraphOnEnter(selected)!);
  assert.deepEqual(names(next), ["image", "paragraph", "mathBlock", "paragraph:Ende"]);
  assert.equal(next.selection.from, s.doc.child(0).nodeSize + 1);
  // A selected table too.
  const t = state(p("A"), table(), p("B"));
  const tableSelected = t.apply(t.tr.setSelection(NodeSelection.create(t.doc, t.doc.child(0).nodeSize)));
  assert.deepEqual(names(tableSelected.apply(paragraphOnEnter(tableSelected)!)), ["paragraph:A", "table:Zelle", "paragraph", "paragraph:B"]);
  // A caret in text keeps the usual ↵.
  const text = state(p("Text"));
  assert.equal(paragraphOnEnter(text.apply(text.tr.setSelection(TextSelection.create(text.doc, 2)))), null);
});

test("↵ at a gap cursor starts a paragraph there", () => {
  const s = state(table(), image(), p("Ende"));
  const gap = s.doc.child(0).nodeSize;
  const at = s.apply(s.tr.setSelection(new GapCursor(s.doc.resolve(gap))));
  const next = at.apply(paragraphOnEnter(at)!);
  assert.deepEqual(names(next), ["table:Zelle", "paragraph", "image", "paragraph:Ende"]);
  assert.equal(next.selection.from, gap + 1);
});

test("an empty block below or above every kind of block; a list item gets an item", () => {
  const list = schema.nodes.bulletList.create(null, [schema.nodes.listItem.create(null, p("Eins"))]);
  const columns = schema.nodes.columns.create(null, [schema.nodes.column.create(null, p("L")), schema.nodes.column.create(null, p("R"))]);
  const s = state(table(), image(), math(), columns, list, p("Ende"));
  const blocks = documentBlocks(s.doc);
  const of = (name: string) => blocks.find((b) => b.node.type.name === name)!;
  for (const name of ["table", "image", "mathBlock", "columns"]) {
    const block = of(name);
    const below = emptyBlockNear(s, block)!;
    const after = s.apply(below.tr);
    assert.equal(after.doc.nodeAt(block.pos + block.node.nodeSize)?.type.name, "paragraph", name);
    assert.equal(below.caret, block.pos + block.node.nodeSize + 1, name);
    const above = emptyBlockNear(s, block, true)!;
    assert.equal(s.apply(above.tr).doc.nodeAt(block.pos)?.type.name, "paragraph", name);
  }
  // Inside a column: below the block, in the column.
  const left = blocks.find((b) => b.node.textContent === "L" && b.node.type.name === "paragraph")!;
  const inColumn = s.apply(emptyBlockNear(s, left)!.tr);
  assert.equal(inColumn.doc.nodeAt(left.pos + left.node.nodeSize)?.type.name, "paragraph");
  assert.equal(inColumn.doc.resolve(left.pos + left.node.nodeSize).parent.type.name, "column");
  // A list item: a new item.
  const item = of("listItem");
  const placed = emptyBlockNear(s, item)!;
  const withItem = s.apply(placed.tr);
  assert.equal(withItem.doc.nodeAt(item.pos + item.node.nodeSize)?.type.name, "listItem");
  assert.equal(withItem.doc.resolve(placed.caret).parent.type.name, "paragraph");
  // An empty paragraph is itself the place.
  const empty = state(p("A"), p());
  const emptyBlock = documentBlocks(empty.doc)[1];
  const same = emptyBlockNear(empty, emptyBlock)!;
  assert.equal(same.tr.docChanged, false);
  assert.equal(same.caret, emptyBlock.pos + 1);
});

test("the toolbar's “+” adds below the block with the caret, an empty paragraph it fills", () => {
  const s = state(p("Text"), table(), p());
  const inText = s.apply(s.tr.setSelection(TextSelection.create(s.doc, 3)));
  assert.equal(blockForInsert(inText)?.node.type.name, "paragraph");
  // A caret in a table cell: the table.
  const inCell = s.apply(s.tr.setSelection(TextSelection.create(s.doc, s.doc.child(0).nodeSize + 4)));
  assert.equal(blockForInsert(inCell)?.node.type.name, "table");
  // In an empty paragraph: none (it is filled).
  const end = s.doc.content.size - 1;
  assert.equal(blockForInsert(s.apply(s.tr.setSelection(TextSelection.create(s.doc, end)))), null);
});
