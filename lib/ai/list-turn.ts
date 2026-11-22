// "Umwandeln in" of the writing assistant (#431): the selected blocks as a
// task list, a numbered list or a bulleted list – a local transform, no AI.
// Changing a list's type is deterministic, so no model has to retype the
// text (and cannot answer with the same list again): list items keep their
// content, marks, sub-lists (which change with them) and ids; a task keeps
// its state when it stays a task; paragraphs and headings become items.
// Inside one list only the selected items change, the list is split around
// them. One transaction – one undo step.
import { Fragment, type Node as PMNode, type Schema } from "@tiptap/pm/model";
import { Selection, type EditorState, type Transaction } from "@tiptap/pm/state";

export type ListKind = "taskList" | "orderedList" | "bulletList";
export const LIST_KINDS: readonly ListKind[] = ["taskList", "orderedList", "bulletList"];

const LISTS = new Set<string>(LIST_KINDS);
const isList = (node: PMNode) => LISTS.has(node.type.name);

// Attributes that carry over to the other node type where it has them.
function carried(node: PMNode, type: PMNode["type"], skip: string[] = []) {
  const attrs: Record<string, unknown> = {};
  for (const key of Object.keys(type.spec.attrs || {})) if (key in node.attrs && !skip.includes(key)) attrs[key] = node.attrs[key];
  return attrs;
}

function itemType(schema: Schema, kind: ListKind) {
  return kind === "taskList" ? schema.nodes.taskItem : schema.nodes.listItem;
}

// An item of the other kind; nested lists inside it change with it.
function convertItem(schema: Schema, item: PMNode, kind: ListKind) {
  const type = itemType(schema, kind);
  const content: PMNode[] = [];
  item.content.forEach((child) => content.push(isList(child) ? convertList(schema, child, kind, true) : child));
  // A task that stays a task keeps its state, due date …; a new one is open.
  const attrs = item.type === type ? { ...item.attrs } : carried(item, type, ["checked", "status", "symbol", "due", "journalSince"]);
  return type.createChecked(attrs, Fragment.fromArray(content));
}

function convertList(schema: Schema, list: PMNode, kind: ListKind, keepId: boolean) {
  const items: PMNode[] = [];
  list.forEach((item) => items.push(convertItem(schema, item, kind)));
  const type = schema.nodes[kind];
  const attrs = carried(list, type);
  if (!keepId && "blockId" in attrs) attrs.blockId = null;
  return type.createChecked(attrs, Fragment.fromArray(items));
}

// A paragraph or heading as an item (its text and marks).
function textItem(schema: Schema, block: PMNode, kind: ListKind) {
  const type = itemType(schema, kind);
  const paragraph = schema.nodes.paragraph.createChecked(block.type === schema.nodes.paragraph ? block.attrs : carried(block, schema.nodes.paragraph), block.content);
  return type.createChecked(carried(block, type, ["checked", "status", "symbol", "due", "journalSince"]), paragraph);
}

// One transaction turning the blocks the range touches into a list of
// `kind`; null when there is nothing to turn (no list, paragraph or heading,
// or already that kind).
export function listTurnTransaction(state: EditorState, range: { from: number; to: number }, kind: ListKind): Transaction | null {
  const { doc, schema } = state;
  const from = Math.max(0, Math.min(range.from, range.to, doc.content.size)),
    to = Math.max(from, Math.min(Math.max(range.from, range.to), doc.content.size));
  const $from = doc.resolve(from),
    $to = doc.resolve(to);
  const tr = state.tr;
  let start: number, end: number, replacement: PMNode[];
  // The outermost list around the selection's start, when its end is in it too.
  let depth = 0;
  for (let d = 1; d <= $from.depth; d++)
    if (isList($from.node(d)) && to <= $from.end(d)) {
      depth = d;
      break;
    }
  if (depth) {
    const list = $from.node(depth);
    start = $from.before(depth);
    end = $from.after(depth);
    // A position between items (not inside one) ends before the next.
    const first = Math.min($from.index(depth), list.childCount - 1),
      last = Math.min(list.childCount - 1, Math.max(first, $to.index(depth) - ($to.depth === depth ? 1 : 0)));
    const items = (a: number, b: number) => {
      const nodes: PMNode[] = [];
      for (let i = a; i < b; i++) nodes.push(list.child(i));
      return Fragment.fromArray(nodes);
    };
    const middle = convertList(schema, list.copy(items(first, last + 1)), kind, first === 0);
    if (middle.eq(list.copy(items(first, last + 1)))) return null;
    replacement = [];
    if (first > 0) replacement.push(list.copy(items(0, first)));
    replacement.push(middle);
    if (last + 1 < list.childCount) {
      const attrs: Record<string, unknown> = { ...list.attrs, blockId: null };
      // A numbered list continues with its number.
      if (list.type.name === "orderedList") attrs.start = (Number(list.attrs.start) || 1) + last + 1;
      replacement.push(list.type.createChecked(attrs, items(last + 1, list.childCount)));
    }
  } else {
    const blocks = $from.blockRange($to);
    if (!blocks) return null;
    start = blocks.start;
    end = blocks.end;
    replacement = [];
    let run: PMNode[] = [];
    let changed = false;
    const flush = () => {
      if (run.length) replacement.push(schema.nodes[kind].createChecked(null, Fragment.fromArray(run)));
      run = [];
    };
    for (let i = blocks.startIndex; i < blocks.endIndex; i++) {
      const block = blocks.parent.child(i);
      if (isList(block)) {
        if (block.type.name !== kind) changed = true;
        convertList(schema, block, kind, !run.length).forEach((item) => run.push(item));
      } else if ((block.type.name === "paragraph" || block.type.name === "heading") && block.content.size) {
        changed = true;
        run.push(textItem(schema, block, kind));
      } else if (block.type.name === "paragraph" && !run.length) {
        // An empty line before the list stays.
        replacement.push(block);
      } else if (block.type.name !== "paragraph") {
        flush();
        replacement.push(block);
      }
      // Empty lines between items are dropped: one list.
    }
    flush();
    if (!changed) return null;
    if (!blocks.parent.canReplace(blocks.startIndex, blocks.endIndex, Fragment.fromArray(replacement))) return null;
  }
  tr.replaceWith(start, end, Fragment.fromArray(replacement));
  if (!tr.docChanged) return null;
  const after = tr.mapping.map(end, -1);
  tr.setSelection(Selection.near(tr.doc.resolve(Math.min(after, tr.doc.content.size)), -1));
  return tr.scrollIntoView();
}

// The writing assistant's "Umwandeln in" choices.
// i18n-table: 2 – [kind, German, English]
export const LIST_TURNS = [
  ["taskList", "Aufgaben", "Tasks"],
  ["orderedList", "Nummerierte Liste", "Numbered list"],
  ["bulletList", "Aufzählung", "Bulleted list"],
] as const satisfies readonly (readonly [ListKind, string, string])[];
