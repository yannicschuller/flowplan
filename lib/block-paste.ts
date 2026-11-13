import { Selection, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Slice } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";

// Where ⌘V puts whole blocks when the caret is in text (#263). Blocks
// copied or cut with the block menu or as chosen blocks (⌘C/⌘X) reach the
// clipboard as a slice closed on both sides (data-pm-slice="0 0 []"), and
// they come back as blocks, like in Notion:
// - in an empty textblock: in its place;
// - at the start of a non-empty textblock: above its block – the list item
//   when the text is an item's first line (the list is split there);
// - at the end: below it – below the list item when the text is all the
//   item holds (with nested items: in the item, between text and them);
// - a list of the item's own kind pasted at the start or end of an item
//   adds its items to that list;
// - in the middle: the textblock is split around them.
// Empty, middle and end (outside list items) are ProseMirror's own paste,
// so this returns null there. At the start ProseMirror would leave an empty
// copy of a heading above them or put them into the list item; at the end
// of an item they would become part of it.
// Other slices (text, open on a side: what ⌘C copies from a text selection
// or another app) are not blocks and go the usual way, as does paste into
// code and over a selection.
const LIST_ITEMS = ["listItem", "taskItem"];
export function blockPaste(state: EditorState, slice: Slice): Transaction | null {
  const { selection } = state;
  if (!(selection instanceof TextSelection) || !selection.empty) return null;
  if (slice.openStart || slice.openEnd || !slice.content.childCount) return null;
  let blocks = true;
  slice.content.forEach((node) => {
    if (!node.isBlock) blocks = false;
  });
  if (!blocks) return null;
  const $at = selection.$from;
  const text = $at.parent;
  if (!text.isTextblock || text.type.spec.code || !text.content.size || $at.depth < 1) return null;
  const start = $at.parentOffset === 0,
    end = $at.parentOffset === text.content.size;
  if (!start && !end) return null;
  // The textblock's block: its list item when it is the item's first line.
  let depth = $at.depth;
  const item = depth > 1 && LIST_ITEMS.includes($at.node(depth - 1).type.name) && $at.index(depth - 1) === 0;
  if (!start && (!item || $at.node(depth - 1).childCount !== 1)) return null;
  if (item) depth -= 1;
  const at = start ? $at.before(depth) : $at.after(depth);
  // A list of the item's kind adds its items to the item's list.
  const list = slice.content.childCount === 1 ? slice.content.firstChild : null;
  const content = item && list?.type === $at.node(depth - 1).type ? new Slice(list.content, 0, 0) : slice;
  const tr = state.tr.replaceRange(at, at, content);
  if (!tr.docChanged) return null;
  if (start)
    // The caret stays at the start of the text, now below them.
    return tr.setSelection(TextSelection.near(tr.doc.resolve(tr.mapping.map($at.pos)))).scrollIntoView();
  // The caret at the end of what was pasted, as ProseMirror puts it.
  let after = tr.mapping.map(at, 1);
  tr.mapping.maps[tr.mapping.maps.length - 1]?.forEach((_from, _to, _newFrom, newTo) => (after = newTo));
  return tr.setSelection(Selection.near(tr.doc.resolve(after), -1)).scrollIntoView();
}

// The caret as the page shows it: Chrome can deliver the "selectionchange"
// of a key (Home, ⌘←) only after the next paste, copy or cut event, and
// ProseMirror would use the caret from before. Its DOM observer reads the
// current one (a handler of handleDOMEvents: lets the event go on).
export function syncDomSelection(view: EditorView) {
  (view as unknown as { domObserver?: { flush?: () => void } }).domObserver?.flush?.();
  return false;
}
