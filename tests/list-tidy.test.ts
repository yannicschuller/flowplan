// Lists stay whole (lib/list-tidy.ts): Backspace in an empty item and lists
// that end up side by side.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { documentSchema } from "../lib/document-schema";
import { deleteEmptyItemBackward, joinAdjacentLists, listTidyPlugin } from "../lib/list-tidy";

const schema = documentSchema();
const p = (text = "") => schema.nodes.paragraph.create(null, text ? schema.text(text) : undefined);
const task = (text = "", checked = false) => schema.nodes.taskItem.create({ checked }, p(text));
const tasks = (...items: import("@tiptap/pm/model").Node[]) => schema.nodes.taskList.create(null, items);
const bullet = (...texts: string[]) => schema.nodes.bulletList.create(null, texts.map((t) => schema.nodes.listItem.create(null, p(t))));
const ordered = (...texts: string[]) => schema.nodes.orderedList.create(null, texts.map((t) => schema.nodes.listItem.create(null, p(t))));
const state = (...nodes: import("@tiptap/pm/model").Node[]) =>
  EditorState.create({ schema, doc: schema.nodes.doc.create(null, nodes), plugins: [listTidyPlugin()] });
const texts = (doc: import("@tiptap/pm/model").Node) => {
  const out: string[] = [];
  doc.forEach((node) => out.push(`${node.type.name}:${node.textContent.replace(/\n/g, "|") || "-"}`));
  return out;
};

test("Backspace in an empty task after another deletes it and moves the caret to the end of the one before", () => {
  // <ul><li><p>Erste</p></li><li><p></p></li><li><p>Dritte</p></li></ul>
  let s = state(tasks(task("Erste"), task(), task("Dritte")));
  // Caret inside the empty paragraph: ul(0) li(1) p(2) "Erste"(3-8) /p(8) /li(9) li(10) p(11) caret 12
  s = s.apply(s.tr.setSelection(TextSelection.create(s.doc, 12)));
  assert.equal(s.selection.$from.parent.content.size, 0);
  let next: EditorState | null = null;
  assert.equal(deleteEmptyItemBackward(s, (tr) => (next = s.apply(tr))), true);
  assert.ok(next);
  const after = next as EditorState;
  assert.deepEqual(texts(after.doc), ["taskList:ErsteDritte"]);
  assert.equal(after.doc.firstChild?.childCount, 2, "the empty task is gone, the list is still one list");
  assert.equal(after.selection.$from.parent.textContent, "Erste");
  assert.equal(after.selection.$from.parentOffset, 5, "caret at the end of the task before");
});

test("the first item, a filled item and an item with subtasks keep the usual Backspace", () => {
  // First item empty: the list keymap may lift it out.
  let s = state(tasks(task(), task("Zweite")));
  s = s.apply(s.tr.setSelection(TextSelection.create(s.doc, 3)));
  assert.equal(deleteEmptyItemBackward(s), false);
  // Caret at the start of a filled item: lifting outdents the text.
  s = state(tasks(task("Erste"), task("Zweite")));
  s = s.apply(s.tr.setSelection(TextSelection.create(s.doc, 12)));
  assert.equal(s.selection.$from.parent.textContent, "Zweite");
  assert.equal(deleteEmptyItemBackward(s), false);
  // An empty item with a nested list under it is not deleted.
  const nested = schema.nodes.taskItem.create(null, [p(), tasks(task("Unter"))]);
  s = state(tasks(task("Erste"), nested));
  s = s.apply(s.tr.setSelection(TextSelection.create(s.doc, 12)));
  assert.equal(deleteEmptyItemBackward(s), false);
  // Bullet lists behave the same as task lists.
  s = state(bullet("Eins", "", "Drei"));
  s = s.apply(s.tr.setSelection(TextSelection.create(s.doc, 11)));
  assert.equal(s.selection.$from.parent.content.size, 0);
  let next: EditorState | null = null;
  deleteEmptyItemBackward(s, (tr) => (next = s.apply(tr)));
  assert.equal((next as unknown as EditorState).doc.firstChild?.childCount, 2);
});

test("task and bullet lists that end up side by side become one list; ordered lists stay apart", () => {
  // A paragraph between two task lists is deleted: the lists join.
  let s = state(tasks(task("Eins")), p("dazwischen"), tasks(task("Zwei", true)));
  const para = s.doc.child(1);
  const from = s.doc.child(0).nodeSize;
  s = s.apply(s.tr.delete(from, from + para.nodeSize));
  assert.deepEqual(texts(s.doc), ["taskList:EinsZwei"]);
  assert.equal(s.doc.firstChild?.childCount, 2);
  assert.equal(s.doc.firstChild?.child(1).attrs.checked, true, "the items keep their state");
  // Also deeper down (a task list inside a callout) and for bullet lists.
  const callout = schema.nodes.callout.create(null, [bullet("a"), bullet("b")]);
  s = state(callout, p("x"));
  s = s.apply(s.tr.insertText("y", 1 + callout.nodeSize + 1));
  assert.equal(s.doc.firstChild?.childCount, 1, "the two bullet lists in the callout are one");
  // Ordered lists would renumber, so they are left as they are.
  s = state(ordered("1"), ordered("1"), p("x"));
  s = s.apply(s.tr.insertText("y", s.doc.nodeSize - 3));
  assert.equal(s.doc.childCount, 3);
  // Nothing to join: the transaction stays untouched.
  const tr = state(tasks(task("a")), p("b"), tasks(task("c"))).tr;
  assert.equal(joinAdjacentLists(tr), false);
  assert.equal(tr.docChanged, false);
});
