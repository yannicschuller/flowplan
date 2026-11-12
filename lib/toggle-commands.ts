// Making and unmaking toggles (#230): the "> " shortcut, a list of toggles
// with ↵, ↵ in an empty title, and "Umwandeln in → Aufklappbarer Block". Plain
// ProseMirror transactions, shared by the editor's input rule, the toggle's
// node view (lib/toggle-view.ts) and the block menu.
import { Fragment, type Node as PMNode } from "@tiptap/pm/model";
import { Selection, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { newBlockId, validBlockId } from "./block-ids";

const LIST_ITEMS = ["listItem", "taskItem"];

// A toggle with a title (plain text) and its content (an empty paragraph by
// default). Its block id: the one given (a block it replaces), else a new
// one – a toggle is remembered closed by its id (lib/toggle-memory.ts).
function toggleNode(trn: Transaction, title: string, content?: Fragment | null, blockId?: unknown) {
  const { schema } = trn.doc.type;
  const body = content?.size ? content : Fragment.from(schema.nodes.paragraph.create());
  return schema.nodes.toggle.create({ title, blockId: validBlockId(blockId) || newBlockId() }, body);
}

// A title from a text block: its text on one line.
export const titleText = (node: PMNode) => node.textBetween(0, node.content.size, " ", " ").replace(/\s+/g, " ").trim();

function canReplace(trn: Transaction, from: number, to: number, content: Fragment | PMNode) {
  const $from = trn.doc.resolve(from);
  const index = $from.index();
  const fragment = content instanceof Fragment ? content : Fragment.from(content);
  return $from.parent.canReplace(index, trn.doc.resolve(to).index(), fragment);
}

// "> " typed at the start of a paragraph (the marker from `from` to `to`):
// the paragraph becomes a toggle. Text after the marker becomes its title;
// the caret goes into its content (the view then puts it into the title).
// Returns the toggle's position, or null where a toggle cannot stand (the
// first line of a list item).
export function toggleFromMarker(trn: Transaction, from: number, to: number): number | null {
  const $from = trn.doc.resolve(from);
  const paragraph = $from.parent;
  if (paragraph.type.name !== "paragraph" || from !== $from.start()) return null;
  const before = $from.before();
  const after = $from.after();
  const rest = paragraph.cut(to - $from.start());
  const toggle = toggleNode(trn, titleText(rest), null, paragraph.attrs.blockId);
  if (!canReplace(trn, before, after, toggle)) return null;
  trn.replaceWith(before, after, toggle);
  trn.setSelection(TextSelection.create(trn.doc, before + 2));
  return before;
}

// ↵ at the end of a closed toggle's title: a new toggle right after it on
// the same level, empty. The caret goes after it (the view puts it into the
// new title); nothing after it: before the toggles.
export function toggleAfter(state: EditorState, pos: number): { tr: Transaction; pos: number } | null {
  const node = state.doc.nodeAt(pos);
  if (node?.type.name !== "toggle") return null;
  const trn = state.tr;
  const at = pos + node.nodeSize;
  const toggle = toggleNode(trn, "");
  if (!canReplace(trn, at, at, toggle)) return null;
  trn.insert(at, toggle);
  const target = Selection.findFrom(trn.doc.resolve(at + toggle.nodeSize), 1, true) || Selection.findFrom(trn.doc.resolve(pos), -1, true);
  if (target) trn.setSelection(target);
  return { tr: trn, pos: at };
}

// ↵ in the empty title of a toggle: it becomes an empty paragraph, its
// content follows on the same level (an empty paragraph alone is dropped).
export function emptyTitleToParagraph(state: EditorState, pos: number): Transaction | null {
  const node = state.doc.nodeAt(pos);
  if (node?.type.name !== "toggle") return null;
  const { schema } = state;
  const only = node.childCount === 1 ? node.firstChild : null;
  const content = only?.type.name === "paragraph" && !only.content.size ? Fragment.empty : node.content;
  const fragment = Fragment.from(schema.nodes.paragraph.create()).append(content);
  const trn = state.tr;
  if (!canReplace(trn, pos, pos + node.nodeSize, fragment)) return null;
  trn.replaceWith(pos, pos + node.nodeSize, fragment);
  trn.setSelection(TextSelection.create(trn.doc, pos + 1));
  return trn;
}

// The block types "Umwandeln in → Aufklappbarer Block" works on.
export const turnsIntoToggle = (node: PMNode, parent: PMNode | null) =>
  (node.type.name === "paragraph" && !(parent && LIST_ITEMS.includes(parent.type.name))) ||
  (LIST_ITEMS.includes(node.type.name) && node.firstChild?.type.name === "paragraph");

// "Umwandeln in → Aufklappbarer Block" for the block at `pos`: a paragraph
// becomes a toggle with its text as title and an empty paragraph inside; a
// list item becomes a toggle with its text as title and its nested blocks
// (sub-lists) inside, where its list is split. One transaction, one undo
// step. The caret goes to the start of the toggle's content.
export function turnIntoToggle(trn: Transaction, pos: number): boolean {
  const node = trn.doc.nodeAt(pos);
  if (!node) return false;
  const $pos = trn.doc.resolve(pos);
  if (!turnsIntoToggle(node, $pos.parent)) return false;
  let at = pos;
  if (node.type.name === "paragraph") {
    const toggle = toggleNode(trn, titleText(node), null, node.attrs.blockId);
    if (!canReplace(trn, pos, pos + node.nodeSize, toggle)) return false;
    trn.replaceWith(pos, pos + node.nodeSize, toggle);
  } else {
    const list = $pos.parent;
    const index = $pos.index();
    const listPos = $pos.before();
    const first = node.firstChild!;
    const toggle = toggleNode(trn, titleText(first), node.content.cut(first.nodeSize), node.attrs.blockId);
    const items: PMNode[] = [];
    list.forEach((item) => items.push(item));
    let parts = Fragment.empty;
    if (index > 0) parts = parts.addToEnd(list.type.create(list.attrs, items.slice(0, index)));
    parts = parts.addToEnd(toggle);
    if (index < items.length - 1) {
      const attrs: Record<string, unknown> = { ...list.attrs, blockId: null };
      if (typeof list.attrs.start === "number") attrs.start = list.attrs.start + index + 1;
      parts = parts.addToEnd(list.type.create(attrs, items.slice(index + 1)));
    }
    if (!canReplace(trn, listPos, listPos + list.nodeSize, parts)) return false;
    trn.replaceWith(listPos, listPos + list.nodeSize, parts);
    at = listPos + (index > 0 ? parts.firstChild!.nodeSize : 0);
  }
  const target = Selection.findFrom(trn.doc.resolve(at + 1), 1, true);
  if (target) trn.setSelection(target);
  return true;
}
