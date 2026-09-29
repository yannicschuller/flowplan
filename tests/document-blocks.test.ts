import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState, TextSelection, NodeSelection } from "@tiptap/pm/state";
import { documentSchema } from "../lib/document-schema";
import {
  documentBlocks,
  blockRange,
  changeBlocks,
  adjacentBlockTarget,
  selectedDocumentBlock,
  BLOCK_SELECTION_META,
} from "../lib/document-blocks";
const schema = documentSchema();
const p = (text: string) =>
  schema.nodes.paragraph.create(null, text ? schema.text(text) : undefined);
const state = (...nodes: import("@tiptap/pm/model").Node[]) =>
  EditorState.create({ schema, doc: schema.nodes.doc.create(null, nodes) });
const list = (...texts: string[]) =>
  schema.nodes.bulletList.create(
    null,
    texts.map((text) => schema.nodes.listItem.create(null, p(text))),
  );
test("block inventory distinguishes containers, list items and atoms while keeping table internals out of block actions", () => {
  const table = schema.nodes.table.create(
    null,
    schema.nodes.tableRow.create(
      null,
      schema.nodes.tableCell.create(null, p("Cell")),
    ),
  );
  const s = state(
    p("Start"),
    list("One", "Two"),
    schema.nodes.callout.create(null, p("Nested")),
    table,
    schema.nodes.mathBlock.create({ expression: "x^2" }),
  );
  const blocks = documentBlocks(s.doc);
  assert.deepEqual(
    blocks.map((b) => b.node.type.name),
    [
      "paragraph",
      "bulletList",
      "listItem",
      "listItem",
      "callout",
      "paragraph",
      "table",
      "mathBlock",
    ],
  );
  const item = blocks.find((b) => b.node.textContent === "One")!;
  assert.equal(
    selectedDocumentBlock(
      s.apply(s.tr.setSelection(TextSelection.create(s.doc, item.pos + 2))),
    )!.node.type.name,
    "listItem",
  );
  assert.equal(
    selectedDocumentBlock(
      s.apply(
        s.tr.setSelection(NodeSelection.create(s.doc, blocks.at(-1)!.pos)),
      ),
    )!.node.type.name,
    "mathBlock",
  );
});
test("contiguous multi-block moves keep order and reject gaps, ancestor selections and arbitrary text destinations", () => {
  let s = state(p("A"), p("B"), p("C"), p("D"));
  let blocks = documentBlocks(s.doc);
  assert.throws(
    () => blockRange(s.doc, [blocks[0].pos, blocks[2].pos]),
    /benachbarte/,
  );
  assert.throws(
    () => changeBlocks(s, [blocks[1].pos], "move", blocks[1].pos + 1),
    /innerhalb/,
  );
  assert.throws(
    () => changeBlocks(s, [blocks[0].pos], "move", blocks[2].pos + 1),
    /vor oder nach/,
  );
  const tr = changeBlocks(
    s,
    [blocks[0].pos, blocks[1].pos],
    "move",
    blocks[3].end,
  );
  assert.equal(tr.doc.textContent, "CDAB");
  assert.deepEqual(tr.getMeta(BLOCK_SELECTION_META), [6, 9]);
  s = s.apply(tr);
  blocks = documentBlocks(s.doc);
  const target = adjacentBlockTarget(s, [blocks[2].pos, blocks[3].pos], -1)!;
  assert.equal(
    s.apply(changeBlocks(s, [blocks[2].pos, blocks[3].pos], "move", target)).doc
      .textContent,
    "CABD",
  );
  assert.equal(adjacentBlockTarget(s, [blocks[0].pos], -1), undefined);
});
test("nested moves support list siblings and columns while preserving schema and refusing incompatible destinations", () => {
  let s = state(list("A", "B", "C"), p("End"));
  let blocks = documentBlocks(s.doc),
    items = blocks.filter((b) => b.node.type.name === "listItem");
  // A list item dropped outside its list stays an item of that list kind.
  const out = changeBlocks(s, [items[0].pos], "move", blocks.at(-1)!.end).doc;
  assert.equal(out.lastChild!.type.name, "bulletList");
  assert.equal(out.lastChild!.textContent, "A");
  out.check();
  s = s.apply(changeBlocks(s, [items[2].pos], "move", items[0].pos));
  assert.equal(s.doc.textContent, "CABEnd");
  s.doc.check();
  const columns = schema.nodes.columns.create(null, [
    schema.nodes.column.create(null, [p("Left1"), p("Left2")]),
    schema.nodes.column.create(null, p("Right")),
  ]);
  s = state(columns, p("Outside"));
  blocks = documentBlocks(s.doc);
  const left = blocks.find(
      (b) => b.node.type.name === "paragraph" && b.node.textContent === "Left2",
    )!,
    right = blocks.find((b) => b.node.textContent === "Right")!;
  s = s.apply(changeBlocks(s, [left.pos], "move", right.pos));
  assert.equal(s.doc.firstChild!.child(0).textContent, "Left1");
  assert.equal(s.doc.firstChild!.child(1).textContent, "Left2Right");
  s.doc.check();
  blocks = documentBlocks(s.doc);
  assert.throws(
    () => blockRange(s.doc, [blocks[0].pos, blocks[1].pos]),
    /benachbarte/,
  );
  s = state(
    schema.nodes.columns.create(null, [
      schema.nodes.column.create(null, p("Left")),
      schema.nodes.column.create(null, p("Right")),
    ]),
    p("End"),
  );
  blocks = documentBlocks(s.doc);
  const lastLeft = blocks.find(
    (b) => b.node.type.name === "paragraph" && b.node.textContent === "Left",
  )!;
  const onlyRight = blocks.find(
    (b) => b.node.type.name === "paragraph" && b.node.textContent === "Right",
  )!;
  s = s.apply(changeBlocks(s, [lastLeft.pos], "move", onlyRight.pos));
  s.doc.check();
  assert.equal(s.doc.firstChild!.childCount, 2);
  assert.equal(s.doc.firstChild!.child(0).textContent, "");
  assert.equal(s.doc.firstChild!.child(1).textContent, "LeftRight");
  assert.equal(s.doc.lastChild!.textContent, "End");
  s = state(list("A"), list("B"));
  const isolatedItems = documentBlocks(s.doc).filter(
    (b) => b.node.type.name === "listItem",
  );
  s = s.apply(
    changeBlocks(s, [isolatedItems[0].pos], "move", isolatedItems[1].pos),
  );
  s.doc.check();
  assert.equal(s.doc.childCount, 1);
  assert.equal(s.doc.firstChild!.childCount, 2);
  assert.equal(s.doc.textContent, "AB");
  const emptied = state(p("Only"));
  const deleted = changeBlocks(emptied, [0], "delete");
  deleted.doc.check();
  assert.equal(deleted.doc.textContent, "");
  assert.equal(deleted.doc.firstChild!.type.name, "paragraph");
});
test("duplication retains rich content and creates independent IDs for nested linked databases without changing the original", () => {
  const linked = schema.nodes.linkedDatabase.create({
    id: "original",
    source: "source-db",
    views: '[{"id":"table"}]',
    version: "7",
  });
  const code = schema.nodes.codeBlock.create(
    { language: "typescript", wrap: true },
    schema.text("const answer = 42;"),
  );
  const math = schema.nodes.mathBlock.create({ expression: "x^2" }),
    diagram = schema.nodes.mermaidBlock.create({ source: "graph LR\nA-->B" });
  const callout = schema.nodes.callout.create(null, [
    p("Intro"),
    linked,
    code,
    math,
    diagram,
  ]);
  const s = state(callout, p("End")),
    tr = changeBlocks(s, [0], "duplicate");
  const original = tr.doc.child(0),
    copy = tr.doc.child(1);
  assert.equal(original.child(1).attrs.id, "original");
  assert.notEqual(copy.child(1).attrs.id, "original");
  assert.equal(copy.child(1).attrs.version, "1");
  assert.equal(copy.child(1).attrs.source, "source-db");
  assert.equal(copy.child(1).attrs.views, linked.attrs.views);
  assert.ok(copy.child(2).eq(code));
  assert.ok(copy.child(3).eq(math));
  assert.ok(copy.child(4).eq(diagram));
  assert.ok(s.doc.child(0).eq(original));
  const moved = changeBlocks(s, [0], "move", s.doc.content.size);
  assert.equal(moved.doc.lastChild!.child(1).attrs.id, "original");
});
test("moved blocks adapt to task lists: paragraphs become tasks, tasks stay tasks outside, items switch list kinds", () => {
  const task = (text: string, checked = false) =>
    schema.nodes.taskItem.create({ checked }, p(text));
  const tasks = (...items: import("@tiptap/pm/model").Node[]) =>
    schema.nodes.taskList.create(null, items);
  let s = state(p("Intro"), tasks(task("Eins", true), task("Zwei")), list("Punkt"));
  let blocks = documentBlocks(s.doc);
  const find = (text: string, type: string) =>
    blocks.find((b) => b.node.type.name === type && b.node.textContent === text)!;
  // Paragraph into the task list, between the two tasks.
  let tr = changeBlocks(s, [find("Intro", "paragraph").pos], "move", find("Eins", "taskItem").end);
  let list0 = tr.doc.child(0);
  assert.equal(list0.type.name, "taskList");
  assert.deepEqual(
    Array.from({ length: list0.childCount }, (_, i) => list0.child(i).textContent),
    ["Eins", "Intro", "Zwei"],
  );
  assert.equal(list0.child(1).type.name, "taskItem");
  // A task dropped before the first paragraph-level block stays a task.
  s = state(p("Intro"), tasks(task("Eins", true), task("Zwei")), list("Punkt"));
  blocks = documentBlocks(s.doc);
  tr = changeBlocks(s, [find("Zwei", "taskItem").pos], "move", find("Intro", "paragraph").pos);
  assert.equal(tr.doc.child(0).type.name, "taskList");
  assert.equal(tr.doc.child(0).textContent, "Zwei");
  // A checked task moved into a bullet list becomes a bullet; back keeps text.
  tr = changeBlocks(s, [find("Eins", "taskItem").pos], "move", find("Punkt", "listItem").end);
  const bullets = tr.doc.lastChild!;
  assert.equal(bullets.type.name, "bulletList");
  assert.deepEqual(
    Array.from({ length: bullets.childCount }, (_, i) => bullets.child(i).type.name),
    ["listItem", "listItem"],
  );
  assert.equal(bullets.lastChild!.textContent, "Eins");
});

test("a numbered item moved out of its list keeps its number and joins a neighbouring list", () => {
  const ol = (start: number, ...texts: string[]) =>
    schema.nodes.orderedList.create(
      { start },
      texts.map((text) => schema.nodes.listItem.create(null, p(text))),
    );
  let s = state(ol(1, "Plus", "Minus"), p("Plus mal Minus"), p("Binomisch"));
  let blocks = documentBlocks(s.doc);
  const minus = blocks.find((b) => b.node.type.name === "listItem" && b.node.textContent === "Minus")!;
  const binomisch = blocks.find((b) => b.node.textContent === "Binomisch")!;
  s = s.apply(changeBlocks(s, [minus.pos], "move", binomisch.pos));
  s.doc.check();
  const moved = s.doc.child(2);
  assert.equal(moved.type.name, "orderedList");
  assert.equal(moved.attrs.start, 2);
  assert.equal(moved.textContent, "Minus");
  // Back right after the first list: it joins it again.
  blocks = documentBlocks(s.doc);
  const item = blocks.find((b) => b.node.type.name === "listItem" && b.node.textContent === "Minus")!;
  s = s.apply(changeBlocks(s, [item.pos], "move", s.doc.child(0).nodeSize));
  s.doc.check();
  assert.equal(s.doc.child(0).type.name, "orderedList");
  assert.equal(s.doc.child(0).childCount, 2);
  assert.equal(s.doc.child(0).textContent, "PlusMinus");
  assert.equal(s.doc.childCount, 3);
  // Tasks keep their checkbox outside the list, too.
  const task = schema.nodes.taskItem.create({ checked: true }, p("Erledigt"));
  s = state(schema.nodes.taskList.create(null, [task, schema.nodes.taskItem.create(null, p("Offen"))]), p("Ende"));
  blocks = documentBlocks(s.doc);
  const done = blocks.find((b) => b.node.type.name === "taskItem" && b.node.textContent === "Erledigt")!;
  s = s.apply(changeBlocks(s, [done.pos], "move", s.doc.content.size));
  s.doc.check();
  assert.equal(s.doc.lastChild!.type.name, "taskList");
  assert.equal(s.doc.lastChild!.firstChild!.attrs.checked, true);
});
