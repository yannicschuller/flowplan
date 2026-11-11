// Ctrl/Cmd+L in the editor (#201), as in Obsidian: a plain line becomes a
// task, a task goes to its next state (open → in progress → done → open).
// With several lines selected all of them follow the first one. And the
// clean-up after a click on the box: a cancelled task unticked is open, an
// in-progress task ticked is done.
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Fragment, type Node as PMNode, type NodeType } from "@tiptap/pm/model";
import { AttrStep, ReplaceAroundStep } from "@tiptap/pm/transform";
import { wrapInList } from "@tiptap/pm/schema-list";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import { isTaskSymbol, nextStatus, statusAttrs, taskStatusOf, type TaskStatus } from "./task-status";

type Dispatch = ((tr: Transaction) => void) | undefined;
const LISTS = ["bulletList", "orderedList"];

// The tasks whose own line (first paragraph) lies in the selection, in
// document order.
export function selectedTasks(state: EditorState) {
  const { from, to } = state.selection;
  const tasks: { pos: number; node: PMNode }[] = [];
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (node.type.name === "taskItem") {
      const start = pos + 1,
        end = start + (node.firstChild?.nodeSize ?? 0);
      if (start <= to && end >= from) tasks.push({ pos, node });
    }
    return true;
  });
  return tasks;
}

// Gives every task in the selection this state.
export function setTaskStatus(state: EditorState, dispatch: Dispatch, status: TaskStatus, positions?: number[]) {
  const targets = positions ?? selectedTasks(state).map((t) => t.pos);
  if (!targets.length) return false;
  if (dispatch) {
    const tr = state.tr;
    for (const pos of targets) {
      const node = tr.doc.nodeAt(pos);
      if (node?.type.name === "taskItem") tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...statusAttrs(status) });
    }
    dispatch(tr.scrollIntoView());
  }
  return true;
}

// Items of a bullet or numbered list in the selection become tasks: the
// list is split around them (a list holds either tasks or plain items).
function listItemsToTasks(state: EditorState, dispatch: Dispatch) {
  const { $from, from, to } = state.selection;
  let depth = $from.depth;
  while (depth > 0 && !LISTS.includes($from.node(depth).type.name)) depth--;
  if (depth <= 0) return false;
  const list = $from.node(depth),
    listPos = $from.before(depth);
  const schema = state.schema;
  const taskList = schema.nodes.taskList as NodeType,
    taskItem = schema.nodes.taskItem as NodeType;
  const picked: number[] = [];
  list.forEach((item, offset, index) => {
    const start = listPos + 1 + offset,
      end = start + item.nodeSize;
    if (start < to && end > from) picked.push(index);
  });
  if (!picked.length) return false;
  const first = picked[0],
    last = picked[picked.length - 1];
  const items = (a: number, b: number) => {
    const out: PMNode[] = [];
    for (let i = a; i < b; i++) out.push(list.child(i));
    return out;
  };
  let tasks: PMNode;
  try {
    tasks = taskList.createChecked(
      null,
      items(first, last + 1).map((item) => {
        // What both kinds of item know (block id, direction …) stays.
        const attrs: Record<string, unknown> = {};
        for (const name of Object.keys(taskItem.spec.attrs || {})) if (name in item.attrs) attrs[name] = item.attrs[name];
        return taskItem.createChecked({ ...attrs, ...statusAttrs("open") }, item.content);
      }),
    );
  } catch {
    return false;
  }
  const parts: PMNode[] = [];
  if (first > 0) parts.push(list.type.create(list.attrs, items(0, first), list.marks));
  parts.push(tasks);
  if (last < list.childCount - 1) {
    const attrs = list.type.name === "orderedList" ? { ...list.attrs, start: (Number(list.attrs.start) || 1) + last + 1 } : list.attrs;
    parts.push(list.type.create(attrs, items(last + 1, list.childCount), list.marks));
  }
  if (dispatch) {
    const tr = state.tr.replaceWith(listPos, listPos + list.nodeSize, Fragment.fromArray(parts));
    // The items keep their size: the selection moves by the list split off before them.
    const shift = first > 0 ? 2 : 0;
    tr.setSelection(TextSelection.create(tr.doc, Math.min(from + shift, tr.doc.content.size), Math.min(to + shift, tr.doc.content.size)));
    dispatch(tr.scrollIntoView());
  }
  return true;
}

// Ctrl/Cmd+L.
export function cycleTaskStatus(state: EditorState, dispatch: Dispatch) {
  const tasks = selectedTasks(state);
  if (tasks.length) return setTaskStatus(state, dispatch, nextStatus(taskStatusOf(tasks[0].node.attrs)), tasks.map((t) => t.pos));
  if (listItemsToTasks(state, dispatch)) return true;
  const taskList = state.schema.nodes.taskList;
  return !!taskList && wrapInList(taskList)(state, dispatch);
}

// After the box was clicked (by this or an older client): a state that no
// longer fits `checked` goes, as does an unknown symbol of a task that is
// not plain open any more. Only own attribute changes, like the subtasks.
export const taskStatusKey = new PluginKey("taskStatus");
export function tidyTaskStatus(transactions: readonly Transaction[], _old: EditorState, state: EditorState): Transaction | null {
  const own = transactions.filter((tr) => tr.docChanged && !tr.getMeta(ySyncPluginKey));
  if (!own.length || !own.every((tr) => tr.steps.every((step) => step instanceof AttrStep || step instanceof ReplaceAroundStep))) return null;
  const tr = state.tr;
  state.doc.descendants((node, pos) => {
    if (node.type.name !== "taskItem") return true;
    const { checked, status, symbol } = node.attrs;
    const fits = status == null || (checked ? status === "cancelled" : status === "progress" || status === "deferred");
    const keepSymbol = symbol == null || (!checked && status == null && isTaskSymbol(symbol));
    if (!fits || !keepSymbol)
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, status: fits ? status : null, symbol: keepSymbol ? symbol : null });
    return true;
  });
  return tr.docChanged ? tr : null;
}
export const taskStatusPlugin = () => new Plugin({ key: taskStatusKey, appendTransaction: tidyTaskStatus });
