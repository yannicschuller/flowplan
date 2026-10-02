import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState } from "@tiptap/pm/state";
import type { Node } from "@tiptap/pm/model";
import { documentSchema } from "../lib/document-schema";
import { checkSubtasks } from "../lib/task-subtasks";

const schema = documentSchema();
const p = (text: string) => schema.nodes.paragraph.create(null, schema.text(text));
const item = (text: string, checked = false, ...sub: Node[]) =>
  schema.nodes.taskItem.create({ checked }, [p(text), ...(sub.length ? [schema.nodes.taskList.create(null, sub)] : [])]);
const doc = (...items: Node[]) => schema.nodes.doc.create(null, schema.nodes.taskList.create(null, items));
const checkedOf = (d: Node) => {
  const out: [string, boolean][] = [];
  d.descendants((n) => {
    if (n.type.name === "taskItem") out.push([n.firstChild!.textContent, !!n.attrs.checked]);
    return true;
  });
  return out;
};
const apply = (state: EditorState, tr: import("@tiptap/pm/state").Transaction) => {
  const next = state.apply(tr);
  const extra = checkSubtasks([tr], state, next);
  return extra ? next.apply(extra) : next;
};

test("ticking a task off ticks off its subtasks; unticking leaves them", () => {
  let state = EditorState.create({ schema, doc: doc(item("Umzug", false, item("Kartons", false, item("Klebeband")), item("Wagen", true)), item("Anderes")) });
  // Position of "Umzug": first child of the list.
  state = apply(state, state.tr.setNodeMarkup(1, undefined, { ...state.doc.nodeAt(1)!.attrs, checked: true }));
  assert.deepEqual(checkedOf(state.doc), [
    ["Umzug", true],
    ["Kartons", true],
    ["Klebeband", true],
    ["Wagen", true],
    ["Anderes", false],
  ]);
  state = apply(state, state.tr.setNodeMarkup(1, undefined, { ...state.doc.nodeAt(1)!.attrs, checked: false }));
  assert.deepEqual(checkedOf(state.doc).map(([, c]) => c), [false, true, true, true, false]);
});

test("moving a task that is already done does not tick its subtasks", () => {
  const state = EditorState.create({ schema, doc: doc(item("Erst"), item("Fertig", true, item("Offen"))) });
  const done = state.doc.firstChild!.child(1);
  const from = 1 + state.doc.firstChild!.child(0).nodeSize;
  const tr = state.tr.delete(from, from + done.nodeSize).insert(1, done);
  const next = state.apply(tr);
  assert.equal(checkSubtasks([tr], state, next), null);
});
