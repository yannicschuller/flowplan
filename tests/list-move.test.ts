// ⌘⇧↑ / ⌘⇧↓ on list items (#467, #468): an item moves with its children
// one step per press – past its sibling, out of its list past the
// neighbouring block (into a list of its kind there), and a subtask into
// the child list of the previous / next parent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import type { Node } from "@tiptap/pm/model";
import { history, undo, undoDepth } from "@tiptap/pm/history";
import { documentSchema } from "../lib/document-schema";
import { adjacentBlockTarget, changeBlocks, selectedDocumentBlock } from "../lib/document-blocks";

const schema = documentSchema();
const p = (text: string) => schema.nodes.paragraph.create(null, schema.text(text));
const h = (text: string) => schema.nodes.heading.create({ level: 2 }, schema.text(text));
type Item = string | [string, ...Node[]];
const content = (item: Item): Node[] => (typeof item === "string" ? [p(item)] : [p(item[0]), ...(item.slice(1) as Node[])]);
const tasks = (...items: Item[]) =>
  schema.nodes.taskList.create(
    null,
    items.map((item) =>
      schema.nodes.taskItem.create(
        { checked: (typeof item === "string" ? item : item[0]).endsWith("✓") },
        content(item),
      ),
    ),
  );
const bullets = (...items: Item[]) =>
  schema.nodes.bulletList.create(null, items.map((item) => schema.nodes.listItem.create(null, content(item))));
const create = (...nodes: Node[]) =>
  EditorState.create({ schema, doc: schema.nodes.doc.create(null, nodes), plugins: [history()] });

const textPos = (doc: Node, text: string) => {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found < 0 && node.isTextblock && node.textContent === text) found = pos + 1;
  });
  assert.ok(found > 0, `“${text}” is there`);
  return found;
};
// What ⌘⇧↑ / ⌘⇧↓ does with the caret in `text` (lib/block-shortcuts.ts).
function press(state: EditorState, text: string, direction: -1 | 1) {
  const at = textPos(state.doc, text);
  const s = state.apply(state.tr.setSelection(TextSelection.create(state.doc, at)));
  const block = selectedDocumentBlock(s)!;
  const target = adjacentBlockTarget(s, [block.pos], direction);
  if (target === undefined) return undefined;
  const next = s.apply(changeBlocks(s, [block.pos], "move", target));
  next.doc.check();
  return next;
}

// The outline: one line per block, items indented by level, task state in [ ].
function outline(doc: Node) {
  const lines: string[] = [];
  const walk = (node: Node, level: number) =>
    node.forEach((child) => {
      if (child.type.name === "taskItem" || child.type.name === "listItem") {
        const mark = child.type.name === "taskItem" ? (child.attrs.checked ? "[x] " : "[ ] ") : "- ";
        lines.push("  ".repeat(level) + mark + child.firstChild!.textContent);
        child.forEach((grand, _o, i) => {
          if (i === 0) return;
          lines.push("  ".repeat(level + 1) + `<${grand.type.name}>`);
          walk(grand, level + 1);
        });
      } else if (["taskList", "bulletList", "orderedList"].includes(child.type.name)) {
        lines.push("  ".repeat(level) + `<${child.type.name}>`);
        walk(child, level);
      } else lines.push("  ".repeat(level) + `${child.type.name}: ${child.textContent}`);
    });
  walk(doc, 0);
  return lines;
}

test("an item swaps with its sibling and keeps its subtasks and state", () => {
  let s = create(tasks("A", ["B ✓", tasks("B1", "B2 ✓")], "C"));
  s = press(s, "B ✓", -1)!;
  assert.deepEqual(outline(s.doc), [
    "<taskList>",
    "[x] B ✓",
    "  <taskList>",
    "  [ ] B1",
    "  [x] B2 ✓",
    "[ ] A",
    "[ ] C",
  ]);
  s = press(s, "B ✓", 1)!;
  s = press(s, "B ✓", 1)!;
  assert.deepEqual(outline(s.doc).slice(1, 3), ["[ ] A", "[ ] C"]);
});

test("#467: a task leaves its list across a heading and joins the list above at its end", () => {
  let s = create(h("Today Work"), tasks("Task 1"), h("Backlog"), tasks(["Task 2", tasks("Sub")], "Task 3"));
  // Past the heading "Backlog": a list of its own between the sections –
  // next to the list of "Task 1" it joins it at the end.
  s = press(s, "Task 2", -1)!;
  assert.deepEqual(outline(s.doc), [
    "heading: Today Work",
    "<taskList>",
    "[ ] Task 1",
    "[ ] Task 2",
    "  <taskList>",
    "  [ ] Sub",
    "heading: Backlog",
    "<taskList>",
    "[ ] Task 3",
  ]);
  // On up: past Task 1, then out of the list past the heading.
  s = press(s, "Task 2", -1)!;
  assert.deepEqual(outline(s.doc).slice(1, 4), ["<taskList>", "[ ] Task 2", "  <taskList>"]);
  s = press(s, "Task 2", -1)!;
  assert.deepEqual(outline(s.doc).slice(0, 5), ["<taskList>", "[ ] Task 2", "  <taskList>", "  [ ] Sub", "heading: Today Work"]);
  // At the top of the document nothing moves.
  assert.equal(press(s, "Task 2", -1), undefined);
  // And down again, one step per press: past the heading, into the list.
  s = press(s, "Task 2", 1)!;
  assert.deepEqual(outline(s.doc).slice(0, 4), ["heading: Today Work", "<taskList>", "[ ] Task 2", "  <taskList>"]);
  s = press(s, "Task 2", 1)!;
  s = press(s, "Task 2", 1)!;
  assert.deepEqual(outline(s.doc), [
    "heading: Today Work",
    "<taskList>",
    "[ ] Task 1",
    "heading: Backlog",
    "<taskList>",
    "[ ] Task 2",
    "  <taskList>",
    "  [ ] Sub",
    "[ ] Task 3",
  ]);
});

test("an item at the edge passes a paragraph as an item of its list kind; a list of another kind is passed whole", () => {
  let s = create(p("Intro"), bullets("A", "B"), tasks("T"));
  s = press(s, "A", -1)!;
  assert.deepEqual(outline(s.doc), ["<bulletList>", "- A", "paragraph: Intro", "<bulletList>", "- B", "<taskList>", "[ ] T"]);
  s = press(s, "T", -1)!;
  // Past the bullet list (another kind), between the paragraph and it.
  assert.deepEqual(outline(s.doc), ["<bulletList>", "- A", "paragraph: Intro", "<taskList>", "[ ] T", "<bulletList>", "- B"]);
  // Down past a paragraph: a list of the same kind below is joined at its start.
  s = create(bullets("X"), p("Mid"), bullets("Y"));
  s = press(s, "X", 1)!;
  assert.deepEqual(outline(s.doc), ["paragraph: Mid", "<bulletList>", "- X", "- Y"]);
});

test("#468: a subtask walks through the parents and keeps its own subtasks", () => {
  let s = create(
    tasks(["P1", tasks("S1")], ["P2", tasks(["S2 ✓", tasks("S2a")], "S3")], "P3"),
  );
  // S2 at the top of P2's subtasks: to the end of P1's.
  s = press(s, "S2 ✓", -1)!;
  assert.deepEqual(outline(s.doc), [
    "<taskList>",
    "[ ] P1",
    "  <taskList>",
    "  [ ] S1",
    "  [x] S2 ✓",
    "    <taskList>",
    "    [ ] S2a",
    "[ ] P2",
    "  <taskList>",
    "  [ ] S3",
    "[ ] P3",
  ]);
  // P1 is the first parent: up stops there (Shift+Tab changes the level).
  s = press(s, "S2 ✓", -1)!;
  assert.equal(press(s, "S2 ✓", -1), undefined);
  // Down: past S1, then to the start of P2's subtasks, then into P3 (none
  // yet: a new child list).
  s = press(s, "S2 ✓", 1)!;
  s = press(s, "S2 ✓", 1)!;
  assert.deepEqual(outline(s.doc).slice(4), ["[ ] P2", "  <taskList>", "  [x] S2 ✓", "    <taskList>", "    [ ] S2a", "  [ ] S3", "[ ] P3"]);
  s = press(s, "S2 ✓", 1)!;
  s = press(s, "S2 ✓", 1)!;
  assert.deepEqual(outline(s.doc), [
    "<taskList>",
    "[ ] P1",
    "  <taskList>",
    "  [ ] S1",
    "[ ] P2",
    "  <taskList>",
    "  [ ] S3",
    "[ ] P3",
    "  <taskList>",
    "  [x] S2 ✓",
    "    <taskList>",
    "    [ ] S2a",
  ]);
  assert.equal(press(s, "S2 ✓", 1), undefined);
  // The emptied child lists went with their last item.
  s.doc.check();
});

test("a subtask crosses to the parent in the next list of the section below", () => {
  let s = create(h("Today"), tasks("Today 1"), h("Backlog"), tasks(["Later", tasks("Step")]));
  s = press(s, "Step", -1)!;
  assert.deepEqual(outline(s.doc), [
    "heading: Today",
    "<taskList>",
    "[ ] Today 1",
    "  <taskList>",
    "  [ ] Step",
    "heading: Backlog",
    "<taskList>",
    "[ ] Later",
  ]);
});

test("attributes, ids, marks and a numbered list's number come along", () => {
  const due = schema.nodes.taskItem.create(
    { checked: true, due: "2026-12-01", blockId: "b-1" },
    schema.nodes.paragraph.create(null, schema.text("Bold", [schema.marks.bold.create()])),
  );
  let s = create(p("Top"), schema.nodes.taskList.create(null, [due]));
  s = press(s, "Bold", -1)!;
  const item = s.doc.firstChild!.firstChild!;
  assert.equal(item.attrs.due, "2026-12-01");
  assert.equal(item.attrs.blockId, "b-1");
  assert.equal(item.attrs.checked, true);
  assert.ok(schema.marks.bold.isInSet(item.firstChild!.firstChild!.marks));
  // A numbered item out of its list at the bottom keeps its number.
  s = create(schema.nodes.orderedList.create({ start: 1 }, ["1", "2", "3"].map((n) => schema.nodes.listItem.create(null, p(n)))), p("After"));
  s = press(s, "3", 1)!;
  assert.equal(s.doc.lastChild!.type.name, "orderedList");
  assert.equal(s.doc.lastChild!.attrs.start, 3);
});

test("each press is one undo step", () => {
  let s = create(h("Today Work"), tasks("Task 1"), h("Backlog"), tasks(["Task 2", tasks("Sub")]));
  const before = s.doc;
  s = press(s, "Task 2", -1)!;
  assert.equal(undoDepth(s), 1);
  let undone: EditorState | undefined;
  undo(s, (tr) => (undone = s.apply(tr)));
  assert.ok(undone!.doc.eq(before));
});

test("blocks other than list items keep moving among their siblings, across headings", () => {
  let s = create(h("One"), p("Text"), h("Two"));
  s = press(s, "Text", -1)!;
  assert.deepEqual(outline(s.doc), ["paragraph: Text", "heading: One", "heading: Two"]);
  assert.equal(press(s, "Text", -1), undefined);
});
