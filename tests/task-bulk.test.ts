// All tasks of a checklist at once (#309, lib/task-bulk.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EditorState, TextSelection, type Transaction } from "@tiptap/pm/state";
import type { Node } from "@tiptap/pm/model";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-task-bulk-"));
const { documentSchema } = await import("../lib/document-schema");
const { tidyTaskStatus } = await import("../lib/task-status-commands");
const { checkSubtasks } = await import("../lib/task-subtasks");
const { statusAttrs, taskStatusOf } = await import("../lib/task-status");
const { blockMenuTasks, bulkTasks, canBulkTasks, checklistTasks, selectionTasks, tasksInBlocks } = await import("../lib/task-bulk");

const schema = documentSchema();
const p = (text: string) => schema.nodes.paragraph.create(null, schema.text(text));
const task = (text: string, status: Parameters<typeof statusAttrs>[0] = "open", ...sub: Node[]) =>
  schema.nodes.taskItem.create(statusAttrs(status), [p(text), ...(sub.length ? [schema.nodes.taskList.create(null, sub)] : [])]);
const tasks = (...items: Node[]) => schema.nodes.taskList.create(null, items);
const doc = (...blocks: Node[]) => schema.nodes.doc.create(null, blocks);
const states = (d: Node) => {
  const out: Record<string, string> = {};
  d.descendants((n) => {
    if (n.type.name === "taskItem") out[n.firstChild!.textContent] = taskStatusOf(n.attrs);
    return true;
  });
  return out;
};
const posOf = (d: Node, text: string) => {
  let at = -1;
  d.descendants((n, pos) => {
    if (at < 0 && n.type.name === "taskItem" && n.firstChild?.textContent === text) at = pos;
    return at < 0;
  });
  return at;
};
// The change and what the editor's plugins append (subtasks, tidy).
function apply(state: EditorState, tr: Transaction) {
  let after = state.apply(tr);
  const extra = checkSubtasks([tr], state, after);
  if (extra) after = after.apply(extra);
  const tidy = tidyTaskStatus([tr], state, after);
  return tidy ? after.apply(tidy) : after;
}

const trip = () =>
  doc(
    p("Reise"),
    tasks(task("Pass", "done"), task("Koffer", "progress", task("Socken", "done"), task("Hemden", "cancelled")), task("Ticket", "deferred"), task("Karte")),
    p("Sonst"),
    tasks(task("Anderes", "done")),
  );

test("a task stands for its whole checklist, nested tasks included", () => {
  const d = trip();
  const all = checklistTasks(d, posOf(d, "Socken"));
  assert.equal(all.length, 6);
  assert.deepEqual(blockMenuTasks(d, [posOf(d, "Socken")]), all);
  assert.deepEqual(blockMenuTasks(d, [posOf(d, "Pass") - 1]), all, "the list itself");
  assert.deepEqual(checklistTasks(d, 1), [], "outside a list");
});

test("mark all as open: one change, every state back to open, the other list untouched", () => {
  const d = trip();
  const state = EditorState.create({ schema, doc: d });
  const positions = checklistTasks(d, posOf(d, "Pass"));
  assert.equal(canBulkTasks(d, positions, "open"), true);
  const tr = bulkTasks(state, positions, "open");
  assert.ok(tr);
  const next = apply(state, tr);
  assert.deepEqual(states(next.doc), { Pass: "open", Koffer: "open", Socken: "open", Hemden: "open", Ticket: "open", Karte: "open", Anderes: "done" });
  assert.equal(canBulkTasks(next.doc, positions, "open"), false, "nothing left to reset");
  assert.equal(bulkTasks(next, positions, "open"), null);
});

test("check all: open tasks done, cancelled stays cancelled", () => {
  const d = trip();
  const state = EditorState.create({ schema, doc: d });
  const positions = checklistTasks(d, posOf(d, "Pass"));
  const next = apply(state, bulkTasks(state, positions, "done")!);
  assert.deepEqual(states(next.doc), { Pass: "done", Koffer: "done", Socken: "done", Hemden: "cancelled", Ticket: "done", Karte: "done", Anderes: "done" });
  assert.equal(canBulkTasks(next.doc, positions, "done"), false);
});

test("several blocks: only the tasks in them and below them", () => {
  const d = trip();
  const state = EditorState.create({ schema, doc: d });
  const positions = blockMenuTasks(d, [posOf(d, "Koffer"), posOf(d, "Anderes")]);
  assert.deepEqual(positions, tasksInBlocks(d, [posOf(d, "Koffer"), posOf(d, "Anderes")]));
  const next = apply(state, bulkTasks(state, positions, "open")!);
  assert.deepEqual(states(next.doc), { Pass: "done", Koffer: "open", Socken: "open", Hemden: "open", Ticket: "deferred", Karte: "open", Anderes: "open" });
});

test("the text menu: caret in a task, or a selection over tasks", () => {
  const d = trip();
  const caret = EditorState.create({ schema, doc: d, selection: TextSelection.create(d, posOf(d, "Karte") + 3) });
  assert.equal(selectionTasks(caret).length, 6);
  const range = EditorState.create({ schema, doc: d, selection: TextSelection.create(d, posOf(d, "Pass") + 3, posOf(d, "Koffer") + 3) });
  assert.deepEqual(selectionTasks(range), [posOf(d, "Pass"), posOf(d, "Koffer"), posOf(d, "Socken"), posOf(d, "Hemden")]);
  const text = EditorState.create({ schema, doc: d, selection: TextSelection.create(d, 2) });
  assert.deepEqual(selectionTasks(text), []);
});
