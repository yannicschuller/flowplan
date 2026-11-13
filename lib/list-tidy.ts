// Lists stay whole. TipTap's list keymap lifts an empty item out of its list
// on Backspace, which splits the list in two around a paragraph; deleting
// that paragraph leaves two lists back to back, with a gap between them.
//
// - Backspace in an empty item that has an item before it deletes the item
//   and puts the caret at the end of the previous one (the first and the
//   last item keep the usual behaviour: lifting out is how a list ends).
// - Two task or bullet lists that end up side by side become one list,
//   whatever caused it (a deleted paragraph, a paste, an older document).
//   Ordered lists are left alone: joined they would renumber.
// - Enter in an empty item moves that item one level up, like Shift+Tab
//   (#254): its siblings keep their level and the list stays one list; an
//   empty item at the top level becomes a paragraph. Enter at the end of an
//   item with sub-items starts a new first sub-item (as in Notion) instead
//   of handing all sub-items to a new empty item.
// - Tab and Shift+Tab never leave the text (#254): where nothing can be
//   indented or outdented, nothing happens instead of the browser moving
//   the focus on.
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { canJoin } from "@tiptap/pm/transform";
import type { Node } from "@tiptap/pm/model";

const ITEMS = ["taskItem", "listItem"];
const JOINED_LISTS = ["taskList", "bulletList"];

// The empty item under the caret and its place in the list, if the caret
// sits in an empty item that is neither alone nor first.
function emptyItemAfterAnother(state: EditorState) {
  const { $from, empty } = state.selection;
  if (!empty || $from.parentOffset !== 0 || $from.parent.content.size > 0 || $from.depth < 2) return null;
  const itemDepth = $from.depth - 1;
  const item = $from.node(itemDepth);
  if (!ITEMS.includes(item.type.name) || item.childCount !== 1) return null;
  if ($from.index(itemDepth - 1) === 0) return null;
  return { from: $from.before(itemDepth), to: $from.after(itemDepth) };
}

// Backspace: the empty item goes, the caret ends up in the item before.
export function deleteEmptyItemBackward(state: EditorState, dispatch?: (tr: Transaction) => void) {
  const range = emptyItemAfterAnother(state);
  if (!range) return false;
  if (dispatch) {
    const tr = state.tr.delete(range.from, range.to);
    tr.setSelection(TextSelection.near(tr.doc.resolve(range.from - 1), -1)).scrollIntoView();
    dispatch(tr);
  }
  return true;
}

// The empty item under the caret (its type), when the caret sits in the
// empty first line of a list item or task.
export function emptyItemType(state: EditorState) {
  const { $from, empty } = state.selection;
  if (!empty || $from.depth < 2 || $from.parent.type.name !== "paragraph" || $from.parent.content.size > 0) return null;
  const item = $from.node($from.depth - 1);
  if (!ITEMS.includes(item.type.name) || $from.index($from.depth - 1) !== 0) return null;
  return item.type.name;
}

// Enter at the end of an item's text when sub-items follow it: a new empty
// first sub-item, the caret in it.
export function enterBeforeSubItems(state: EditorState, dispatch?: (tr: Transaction) => void) {
  const { $from, empty } = state.selection;
  if (!empty || $from.depth < 2 || $from.parent.type.name !== "paragraph" || $from.parentOffset !== $from.parent.content.size) return false;
  const itemDepth = $from.depth - 1;
  const item = $from.node(itemDepth);
  if (!ITEMS.includes(item.type.name) || $from.index(itemDepth) !== 0 || item.childCount < 2) return false;
  const list = item.child(1);
  const first = list.firstChild;
  if (!first || !ITEMS.includes(first.type.name)) return false;
  const created = first.type.createAndFill();
  if (!created) return false;
  if (dispatch) {
    // Right inside the sub-list: after this paragraph and the list's opening.
    const at = $from.after() + 1;
    const tr = state.tr.insert(at, created);
    tr.setSelection(TextSelection.near(tr.doc.resolve(at + 1))).scrollIntoView();
    dispatch(tr);
  }
  return true;
}

// Joins every pair of same-kind lists that sit next to each other; returns
// whether anything was joined.
export function joinAdjacentLists(tr: Transaction) {
  const seams: number[] = [];
  const visit = (node: Node, start: number) => {
    let pos = start;
    let before: Node | null = null;
    node.forEach((child) => {
      if (
        before &&
        child.type === before.type &&
        JOINED_LISTS.includes(child.type.name) &&
        JSON.stringify(child.attrs) === JSON.stringify(before.attrs)
      )
        seams.push(pos);
      if (!child.isLeaf && !child.isTextblock) visit(child, pos + 1);
      before = child;
      pos += child.nodeSize;
    });
  };
  visit(tr.doc, 0);
  // From the end, so earlier positions stay valid.
  for (const pos of seams.reverse()) if (canJoin(tr.doc, pos)) tr.join(pos);
  return seams.length > 0;
}

export const ListTidy = Extension.create({
  name: "listTidy",
  // Before the list keymap, which would lift the item out instead.
  priority: 1000,
  addKeyboardShortcuts() {
    return {
      Backspace: () => deleteEmptyItemBackward(this.editor.state, this.editor.view.dispatch),
      // Splitting would lift the item's siblings with it: what Shift+Tab
      // does, for this item only.
      Enter: () => {
        const type = emptyItemType(this.editor.state);
        if (type) return this.editor.commands.liftListItem(type);
        return enterBeforeSubItems(this.editor.state, this.editor.view.dispatch);
      },
    };
  },
  addProseMirrorPlugins() {
    return [listTidyPlugin()];
  },
});

export function listTidyPlugin() {
  return new Plugin({
    key: new PluginKey("listTidy"),
    appendTransaction(transactions, _old, state) {
      if (!transactions.some((tr) => tr.docChanged)) return null;
      const tr = state.tr;
      return joinAdjacentLists(tr) ? tr : null;
    },
  });
}

// Last of all Tab handlers (lists, tasks, tables, code, toggles and the
// indent go first): a Tab nobody took stays in the editor.
export const TabStaysInText = Extension.create({
  name: "tabStaysInText",
  priority: 1,
  addKeyboardShortcuts() {
    return {
      Tab: () => this.editor.isEditable,
      "Shift-Tab": () => this.editor.isEditable,
    };
  },
});
