// Tab and Shift+Tab nest blocks into toggles and take them out again
// (#246, as in Notion): indented means inside. Tab on a block right after a
// toggle moves it into the toggle as its last block; Shift+Tab on a block in
// a toggle moves it out to right after the toggle (the blocks after it stay
// inside). A toggle's title does the same for the toggle itself, and also
// nests it into the last item of a list right before it.
//
// Plain ProseMirror transactions: one each, so one undo step brings the
// blocks back. Where there is nothing to nest into, the callers keep the
// visual indent of paragraphs and headings (lib/document-schema.ts, Indent).
import { Fragment, type Node as PMNode, type ResolvedPos } from "@tiptap/pm/model";
import { TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";

const LIST_ITEMS = ["listItem", "taskItem"];
const LISTS = ["bulletList", "orderedList", "taskList"];
// Boxes whose first line is the first line of their content: Tab in that
// line moves the whole box (a quote, a callout), as its handle does.
const BOXES = ["blockquote", "callout"];

// Neighbouring blocks of one parent: `from`–`to` in the document, children
// `first`–`last` (inclusive) of the node that starts at `parentPos` (-1: the
// document itself).
export type BlockRun = { parent: PMNode; parentPos: number; first: number; last: number; from: number; to: number };

const contentStart = (parentPos: number) => parentPos + 1;
const childPos = (parent: PMNode, parentPos: number, index: number) => {
  let pos = contentStart(parentPos);
  for (let i = 0; i < index; i++) pos += parent.child(i).nodeSize;
  return pos;
};

// The run of the blocks from `from` to `to` (block positions in one parent),
// or null when they are not neighbours of one parent.
export function runBetween(doc: PMNode, from: number, to: number): BlockRun | null {
  const $from = doc.resolve(from);
  const $to = doc.resolve(to);
  if ($from.depth !== $to.depth || $from.start() !== $to.start()) return null;
  const parent = $from.parent;
  const first = $from.index();
  const last = $to.index() - 1;
  if (last < first) return null;
  return { parent, parentPos: $from.depth ? $from.before() : -1, first, last, from, to };
}

// The block a caret position stands for: its text block, or the quote or
// callout whose first line it is.
function unitDepth($pos: ResolvedPos) {
  let depth = $pos.depth;
  while (depth > 1 && BOXES.includes($pos.node(depth - 1).type.name) && $pos.index(depth - 1) === 0) depth--;
  return depth;
}

// The blocks of a text selection, as a run (null for a selection without
// text blocks or across parents that share none).
export function runOfSelection(state: EditorState): BlockRun | null {
  const { $from, $to } = state.selection;
  if (!$from.parent.isTextblock || !$to.parent.isTextblock) return null;
  let depth = Math.min(unitDepth($from), unitDepth($to));
  // Down to the level where both ends share their parent.
  while (depth > 0 && $from.start(depth - 1) !== $to.start(depth - 1)) depth--;
  if (depth < 1) return null;
  return runBetween(state.doc, $from.before(depth), $to.after(depth));
}

// The run's blocks as a fragment.
const runContent = (run: BlockRun) => run.parent.content.cut(run.from - contentStart(run.parentPos), run.to - contentStart(run.parentPos));

// The positions of a run's blocks after a change put them at `at`.
function positionsFrom(doc: PMNode, at: number, count: number) {
  const out: number[] = [];
  let pos = at;
  for (let i = 0; i < count; i++) {
    const node = doc.nodeAt(pos);
    if (!node) break;
    out.push(pos);
    pos += node.nodeSize;
  }
  return out;
}

export type Nested = {
  tr: Transaction;
  // Where the moved blocks started before.
  from: number;
  // The blocks moved, where they are now.
  positions: number[];
  // Toggles they went into (to open them when closed).
  into: number[];
};

// Tab: the run into the toggle right before it (its last blocks), or, for
// a toggle (`lists`), into the last item of a list right before it.
export function nestRun(state: EditorState, run: BlockRun, { lists = false } = {}): Nested | null {
  if (run.first === 0) return null;
  const before = run.parent.child(run.first - 1);
  const beforePos = run.from - before.nodeSize;
  const content = runContent(run);
  // What stays must still be valid (a toggle keeps at least one block).
  if (!run.parent.canReplace(run.first, run.last + 1, Fragment.empty)) return null;
  let at: number;
  let into: number[] = [];
  if (before.type.name === "toggle") {
    if (!before.canReplace(before.childCount, before.childCount, content)) return null;
    at = beforePos + before.nodeSize - 1;
    into = [beforePos];
  } else if (lists && LISTS.includes(before.type.name) && before.lastChild && LIST_ITEMS.includes(before.lastChild.type.name)) {
    const item = before.lastChild;
    if (!item.canReplace(item.childCount, item.childCount, content)) return null;
    at = beforePos + before.nodeSize - 2;
  } else return null;
  const trn = state.tr;
  // The run comes after the target: removed first, so `at` stays valid.
  trn.delete(run.from, run.to);
  trn.insert(at, content);
  return { tr: trn, from: run.from, positions: positionsFrom(trn.doc, at, content.childCount), into };
}

// Shift+Tab: the run out of the toggle it is in, to right after it; blocks
// after it stay inside, an emptied toggle keeps an empty paragraph. For a
// toggle in a list item (`lists`): out of the item and its list, which is
// split around it.
export function liftRun(state: EditorState, run: BlockRun, { lists = false } = {}): Nested | null {
  if (run.parentPos < 0) return null;
  const { parent } = run;
  const content = runContent(run);
  const trn = state.tr;
  if (parent.type.name === "toggle") {
    const after = run.parentPos + parent.nodeSize;
    const $after = state.doc.resolve(after);
    const outer = $after.parent;
    const index = $after.index();
    if (!outer.canReplace(index, index, content)) return null;
    const all = run.first === 0 && run.last === parent.childCount - 1;
    trn.insert(after, content);
    if (all) trn.replaceWith(run.from, run.to, state.schema.nodes.paragraph.create());
    else trn.delete(run.from, run.to);
    const at = trn.mapping.slice(1).map(after, 1);
    return { tr: trn, from: run.from, positions: positionsFrom(trn.doc, at, content.childCount), into: [] };
  }
  if (!lists || !LIST_ITEMS.includes(parent.type.name) || run.first === 0) return null;
  // The item's list, split after the item: [items up to it] the run [items after it].
  const $item = state.doc.resolve(run.parentPos);
  const list = $item.parent;
  if (!LISTS.includes(list.type.name)) return null;
  const listPos = $item.before();
  const itemIndex = $item.index();
  const items: PMNode[] = [];
  list.forEach((item) => items.push(item));
  const shortened = parent.copy(parent.content.cut(0, run.from - contentStart(run.parentPos)).append(parent.content.cut(run.to - contentStart(run.parentPos))));
  let parts = Fragment.from(list.copy(Fragment.fromArray([...items.slice(0, itemIndex), shortened])));
  const firstAt = listPos + parts.size;
  parts = parts.append(content);
  if (itemIndex < items.length - 1) {
    const attrs: Record<string, unknown> = { ...list.attrs, blockId: null };
    if (typeof list.attrs.start === "number") attrs.start = list.attrs.start + itemIndex + 1;
    parts = parts.addToEnd(list.type.create(attrs, items.slice(itemIndex + 1)));
  }
  const $list = state.doc.resolve(listPos);
  if (!$list.parent.canReplace($list.index(), $list.index() + 1, parts)) return null;
  trn.replaceWith(listPos, listPos + list.nodeSize, parts);
  return { tr: trn, from: run.from, positions: positionsFrom(trn.doc, firstAt, content.childCount), into: [] };
}

// List items: the first items of a list right after a toggle go into it
// (Tab; into a list of the same kind at its end, or a list of their own);
// items of a list that is a toggle's block come out to right after it
// (Shift+Tab). Other items keep the lists' own Tab (sink, lift).
function nestItems(state: EditorState, out: boolean): Nested | null {
  const { $from, $to } = state.selection;
  const itemDepth = $from.depth - 1;
  if (itemDepth < 2 || !LIST_ITEMS.includes($from.node(itemDepth).type.name)) return null;
  const listDepth = itemDepth - 1;
  const list = $from.node(listDepth);
  const listPos = $from.before(listDepth);
  const first = $from.index(listDepth);
  // The selection's last item in the same list (else only the first).
  let last = first;
  if ($to.depth >= listDepth && $to.before(listDepth) === listPos) last = $to.index(listDepth);
  const $list = state.doc.resolve(listPos);
  const holder = $list.parent;
  const index = $list.index();
  const items: PMNode[] = [];
  list.forEach((item) => items.push(item));
  const moved = items.slice(first, last + 1);
  const itemsFrom = childPos(list, listPos, first);
  const itemsTo = childPos(list, listPos, last + 1);
  const trn = state.tr;
  const plainAttrs = (start: number) => {
    const attrs: Record<string, unknown> = { ...list.attrs, blockId: null };
    if (typeof list.attrs.start === "number") attrs.start = start;
    return attrs;
  };
  if (!out) {
    if (first !== 0 || index === 0) return null;
    const toggle = holder.child(index - 1);
    if (toggle.type.name !== "toggle") return null;
    const togglePos = listPos - toggle.nodeSize;
    const end = togglePos + toggle.nodeSize - 1;
    const tail = toggle.lastChild;
    // Joined with a list of the same kind at the toggle's end.
    const joined = tail?.type === list.type;
    const whole = last === items.length - 1;
    if (whole) trn.delete(listPos, listPos + list.nodeSize);
    else trn.delete(itemsFrom, itemsTo);
    let at: number;
    if (joined) {
      at = end - 1;
      trn.insert(at, Fragment.fromArray(moved));
    } else {
      const wrapped = list.type.create(plainAttrs(typeof list.attrs.start === "number" ? list.attrs.start : 1), moved);
      if (!toggle.canReplace(toggle.childCount, toggle.childCount, Fragment.from(wrapped))) return null;
      trn.insert(end, wrapped);
      at = end + 1;
    }
    return { tr: trn, from: itemsFrom, positions: positionsFrom(trn.doc, at, moved.length), into: [togglePos] };
  }
  if (holder.type.name !== "toggle") return null;
  const togglePos = $list.before();
  const after = togglePos + holder.nodeSize;
  const start = typeof list.attrs.start === "number" ? list.attrs.start : 1;
  const wrapped = list.type.create(plainAttrs(start + first), moved);
  const $after = state.doc.resolve(after);
  if (!$after.parent.canReplace($after.index(), $after.index(), Fragment.from(wrapped))) return null;
  trn.insert(after, wrapped);
  // What stays in the toggle: the items before and after, as two lists.
  let rest = Fragment.empty;
  if (first > 0) rest = rest.addToEnd(list.copy(Fragment.fromArray(items.slice(0, first))));
  if (last < items.length - 1) rest = rest.addToEnd(list.type.create(plainAttrs(start + last + 1), items.slice(last + 1)));
  if (!rest.size && holder.childCount === 1) rest = Fragment.from(state.schema.nodes.paragraph.create());
  trn.replaceWith(listPos, listPos + list.nodeSize, rest);
  const at = trn.mapping.slice(1).map(after, 1) + 1;
  return { tr: trn, from: itemsFrom, positions: positionsFrom(trn.doc, at, moved.length), into: [] };
}

// The caret (or selection) follows the blocks it was in: the same offsets
// from the start of the moved blocks.
function keepSelection(state: EditorState, nested: Nested) {
  const { selection } = state;
  const { from } = nested;
  const at = nested.positions[0];
  if (at === undefined) return nested;
  const size = nested.tr.doc.content.size;
  const anchor = Math.max(0, Math.min(size, at + (selection.anchor - from)));
  const head = Math.max(0, Math.min(size, at + (selection.head - from)));
  try {
    nested.tr.setSelection(TextSelection.between(nested.tr.doc.resolve(anchor), nested.tr.doc.resolve(head)));
  } catch {
    // The selection as mapped by the change.
  }
  return nested;
}

// Whether a run's text blocks within the selection are indented
// visually (Shift+Tab then takes that back first).
function indentedIn(state: EditorState) {
  const { from, to } = state.selection;
  let found = false;
  state.doc.nodesBetween(from, to, (node) => {
    if (found) return false;
    if ((node.type.name === "paragraph" || node.type.name === "heading") && node.attrs.indent) found = true;
    return !node.isTextblock;
  });
  return found;
}

// Tab (`out` false) or Shift+Tab (`out` true) in the text: the transaction
// that nests or lifts the blocks of the selection, the caret kept in place,
// or null where the keys keep their other meaning (code, tables, list items
// that sink or lift in their list, visual indent where there is no toggle
// to nest into, or one to take back first).
export function nestSelection(state: EditorState, out: boolean): Transaction | null {
  const { $from } = state.selection;
  if (!$from.parent.isTextblock || $from.parent.type.name === "codeBlock") return null;
  for (let d = $from.depth; d > 0; d--) if (["tableCell", "tableHeader"].includes($from.node(d).type.name)) return null;
  // In a list item's own line: its list decides, except at the edges of a
  // toggle. Its later blocks (a toggle in the item, what follows it) nest
  // as anywhere.
  if (LIST_ITEMS.includes($from.node($from.depth - 1)?.type.name ?? "") && $from.index($from.depth - 1) === 0) {
    const items = nestItems(state, out);
    return items ? keepSelection(state, items).tr : null;
  }
  if (out && indentedIn(state)) return null;
  const run = runOfSelection(state);
  if (!run) return null;
  const nested = out ? liftRun(state, run) : nestRun(state, run);
  return nested ? keepSelection(state, nested).tr : null;
}

// The same for chosen blocks (block selection, #237): their run, whatever
// blocks they are (code, tables, toggles …); list items keep their lists' Tab.
export function nestBlocks(state: EditorState, from: number, to: number, out: boolean): Nested | null {
  const run = runBetween(state.doc, from, to);
  if (!run || LISTS.includes(run.parent.type.name)) return null;
  return out ? liftRun(state, run) : nestRun(state, run);
}

// Tab / Shift+Tab in a toggle's title: the toggle at `pos` into the block
// before it (a toggle, the last item of a list) or out of the toggle or list
// item it is in.
export function nestToggle(state: EditorState, pos: number, out: boolean): Nested | null {
  const node = state.doc.nodeAt(pos);
  if (node?.type.name !== "toggle") return null;
  const run = runBetween(state.doc, pos, pos + node.nodeSize);
  if (!run) return null;
  return out ? liftRun(state, run, { lists: true }) : nestRun(state, run, { lists: true });
}
