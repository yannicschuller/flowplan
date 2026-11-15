// Indent and outdent from the block menu and the formatting toolbar (#302):
// what Tab / ⇧Tab do in the text, for people without a keyboard. The
// action itself is the keys (`pressTab`, the editor's own handlers); the
// checks here only say beforehand whether the keys would move anything, in
// the order the handlers take them:
//   1. into the toggle before / out of the one around (lib/toggle-nesting.ts),
//   2. list and task items sink into the item before or lift out of their
//      list (a top-level item becomes text),
//   3. paragraphs and headings take a visual indent (lib/document-schema.ts,
//      `Indent`, up to MAX_INDENT).
// Code (Tab indents its lines) and tables (Tab goes to the next cell) keep
// their own Tab: nothing to indent there as a block.
import { Selection, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Mapping } from "@tiptap/pm/transform";
import type { Editor } from "@tiptap/core";
import { liftListItem, sinkListItem } from "@tiptap/pm/schema-list";
import type { EditorView } from "@tiptap/pm/view";
import { yUndoPluginKey } from "@tiptap/y-tiptap";
import { nestBlocks, nestSelection } from "./toggle-nesting";
import { blockRange, documentBlocks } from "./document-blocks";
import { MAX_INDENT } from "./document-schema";

const ITEMS = ["listItem", "taskItem"];
const CELLS = ["tableCell", "tableHeader"];

// Whether Tab (`out` false) or ⇧Tab (`out` true) would indent or outdent
// something at the text selection of `state`.
export function canShiftText(state: EditorState, out: boolean): boolean {
  if (nestSelection(state, out)) return true;
  const { $from, from, to } = state.selection;
  if ($from.parent.type.name === "codeBlock") return false;
  for (let d = $from.depth; d > 0; d--) {
    const name = $from.node(d).type.name;
    if (CELLS.includes(name)) return false;
    if (ITEMS.includes(name))
      return ITEMS.some((item) => {
        const type = state.schema.nodes[item];
        return !!type && (out ? liftListItem(type) : sinkListItem(type))(state);
      });
  }
  let can = false;
  state.doc.nodesBetween(from, to, (node, _pos, parent) => {
    if (can) return false;
    if (node.type.name !== "paragraph" && node.type.name !== "heading") return true;
    // Lists, tasks and tables drop a paragraph's own indent again.
    if (parent && [...ITEMS, ...CELLS].includes(parent.type.name)) return false;
    const indent = Number(node.attrs.indent) || 0;
    if (out ? indent > 0 : indent < MAX_INDENT) can = true;
    return false;
  });
  return can;
}

// The text selection over chosen blocks (from the start of the first to the
// end of the last), as Tab on chosen blocks uses it; null without text.
export function textSelectionOver(state: EditorState, from: number, to: number): Selection | null {
  const start = Selection.findFrom(state.doc.resolve(from), 1, true),
    end = Selection.findFrom(state.doc.resolve(to), -1, true);
  if (!start || !end || start.from > end.to) return null;
  return TextSelection.between(start.$from, end.$to);
}

// Whether Tab / ⇧Tab on the chosen blocks at `positions` (the block
// selection, components/document-block-controls.tsx `indent`) would move
// any of them.
export function canShiftBlocks(state: EditorState, positions: number[], out: boolean): boolean {
  let range;
  try {
    range = blockRange(state.doc, positions);
  } catch {
    return false;
  }
  if (nestBlocks(state, range.from, range.to, out)) return true;
  const selection = textSelectionOver(state, range.from, range.to);
  if (!selection) return false;
  return canShiftText(state.apply(state.tr.setSelection(selection)), out);
}

// Where the blocks at `positions` are after `run` changed the document
// (indented blocks stay chosen): each followed by a place in its text
// through the changes' mapping, then the innermost block of its kind
// around that place. Lists rebuild their items when they nest, so neither
// the old positions nor the Yjs elements behind them (lib/block-bookmarks.ts)
// survive that.
export function followBlocks(editor: Editor, positions: number[], run: () => void): number[] {
  const { doc } = editor.state;
  const before = documentBlocks(doc);
  const marks = positions.flatMap((pos) => {
    const block = before.find((b) => b.pos === pos);
    if (!block) return [];
    const inner = Selection.findFrom(doc.resolve(pos), 1, true);
    return [{ at: inner && inner.from < block.end ? inner.from : pos + 1, type: block.node.type.name }];
  });
  const mapping = new Mapping();
  const listen = ({ transaction, appendedTransactions }: { transaction: Transaction; appendedTransactions?: Transaction[] }) => {
    for (const tr of [transaction, ...(appendedTransactions ?? [])]) mapping.appendMapping(tr.mapping);
  };
  editor.on("transaction", listen);
  try {
    run();
  } finally {
    editor.off("transaction", listen);
  }
  const after = documentBlocks(editor.state.doc);
  const found = marks.flatMap(({ at, type }) => {
    const mapped = mapping.map(at, 1);
    const around = after.filter((b) => b.node.type.name === type && b.pos < mapped && mapped < b.end);
    return around.length ? [around[around.length - 1].pos] : [];
  });
  return [...new Set(found)];
}

// Tab / ⇧Tab as if pressed in the text: the editor's own key handlers, so
// buttons and menu entries do exactly what the keys do – as one undo step of
// its own (not merged with typing right before). True when one took the key.
export function pressTab(view: EditorView, out: boolean): boolean {
  const undo = yUndoPluginKey.getState(view.state)?.undoManager;
  undo?.stopCapturing();
  const event = new KeyboardEvent("keydown", { key: "Tab", code: "Tab", keyCode: 9, shiftKey: out, bubbles: true, cancelable: true });
  const taken = !!view.someProp("handleKeyDown", (handle) => handle(view, event));
  undo?.stopCapturing();
  return taken;
}
