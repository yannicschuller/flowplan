// All tasks of a checklist at once (#309): "Alle als offen markieren" sets
// every task back to open (also in progress, cancelled and deferred ones –
// a packing list used again), "Alle abhaken" ticks every task that is not
// closed yet (a cancelled one stays cancelled). Nested tasks count too. One
// transaction, so one undo step. Offered in the block menu (the list of a
// task, or the tasks in the chosen blocks) and in the right-click menu.
import type { EditorState, Transaction } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";
import { isClosedStatus, statusAttrs, taskStatusOf } from "./task-status";
import { selectedTasks } from "./task-status-commands";

export type BulkTaskAction = "open" | "done";

// The positions of the task items in `node` (at `pos`), itself included.
function tasksIn(node: PMNode, pos: number, out: Set<number>) {
  if (node.type.name === "taskItem") out.add(pos);
  node.descendants((child, offset) => {
    if (child.type.name === "taskItem") out.add(pos + 1 + offset);
    return true;
  });
}

// The whole checklist around a position: the outermost task list of the
// nested task lists and task items it sits in. Null outside a task list.
export function checklistAt(doc: PMNode, pos: number): number | null {
  const $pos = doc.resolve(Math.min(Math.max(pos, 0), doc.content.size));
  // A position right before a task list counts as inside it (before a task
  // item it already is).
  let found: number | null = $pos.nodeAfter?.type.name === "taskList" ? pos : null;
  for (let depth = $pos.depth; depth > 0; depth--) {
    const name = $pos.node(depth).type.name;
    if (name === "taskList") found = $pos.before(depth);
    else if (name !== "taskItem" && found !== null) break;
  }
  return found;
}

// The tasks of the checklist around `pos`.
export function checklistTasks(doc: PMNode, pos: number): number[] {
  const list = checklistAt(doc, pos);
  if (list === null) return [];
  const out = new Set<number>();
  const node = doc.nodeAt(list);
  if (node) tasksIn(node, list, out);
  return [...out].sort((a, b) => a - b);
}

// The tasks in and below the blocks at these positions.
export function tasksInBlocks(doc: PMNode, positions: number[]): number[] {
  const out = new Set<number>();
  for (const pos of positions) {
    const node = doc.nodeAt(pos);
    if (node) tasksIn(node, pos, out);
  }
  return [...out].sort((a, b) => a - b);
}

// For the block menu: one task (or task list) stands for its whole
// checklist; several blocks, or another block, for the tasks inside them.
export function blockMenuTasks(doc: PMNode, positions: number[]): number[] {
  if (positions.length === 1) {
    const node = doc.nodeAt(positions[0]);
    if (node && (node.type.name === "taskItem" || node.type.name === "taskList")) return checklistTasks(doc, positions[0]);
  }
  return tasksInBlocks(doc, positions);
}

// For the text menu: the tasks of a selection with their subtasks, or the
// checklist around the caret.
export function selectionTasks(state: EditorState): number[] {
  if (state.selection.empty) return checklistTasks(state.doc, state.selection.from);
  return tasksInBlocks(
    state.doc,
    selectedTasks(state).map((t) => t.pos),
  );
}

const changes = (node: PMNode, action: BulkTaskAction) => {
  const status = taskStatusOf(node.attrs);
  return action === "open" ? status !== "open" : !isClosedStatus(status);
};

// Whether the action would change any of these tasks (else it is greyed out).
export function canBulkTasks(doc: PMNode, positions: number[], action: BulkTaskAction): boolean {
  return positions.some((pos) => {
    const node = doc.nodeAt(pos);
    return node?.type.name === "taskItem" && changes(node, action);
  });
}

// The change, or null when nothing would change.
export function bulkTasks(state: EditorState, positions: number[], action: BulkTaskAction): Transaction | null {
  const tr = state.tr;
  for (const pos of positions) {
    const node = tr.doc.nodeAt(pos);
    if (node?.type.name === "taskItem" && changes(node, action))
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...statusAttrs(action) });
  }
  return tr.docChanged ? tr : null;
}
