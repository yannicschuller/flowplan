import { yUndoPluginKey } from "@tiptap/y-tiptap";
import { Plugin, type Transaction } from "@tiptap/pm/state";
import { Extension, type Editor } from "@tiptap/core";
import {
  adjacentBlockTarget,
  BLOCK_MOVE_META,
  BLOCK_SELECTION_META,
  changeBlocks,
  selectedDocumentBlock,
} from "./document-blocks";
export function applyBlockChange(editor: Editor, transaction: Transaction) {
  const undo = yUndoPluginKey.getState(editor.state)?.undoManager;
  undo?.stopCapturing();
  const slide = prepareSlide(editor, transaction);
  editor.view.dispatch(transaction);
  slide?.();
  undo?.stopCapturing();
}
// Moved blocks glide from their old to their new place and neighbours make
// room smoothly. Web Animations change no DOM attributes, so the editor
// and collaboration never see them.
function prepareSlide(editor: Editor, transaction: Transaction) {
  const move = transaction.getMeta(BLOCK_MOVE_META) as
    { from: number; to: number } | undefined;
  const root = editor.view.dom as HTMLElement;
  if (
    !move ||
    typeof root.animate !== "function" ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  )
    return null;
  const base = () => root.getBoundingClientRect();
  const place = (el: Element, origin: DOMRect) => {
    const r = el.getBoundingClientRect();
    return { x: r.left - origin.left, y: r.top - origin.top };
  };
  const before = base(),
    moved: { x: number; y: number }[] = [];
  editor.state.doc.nodesBetween(move.from, move.to, (node, pos) => {
    if (pos >= move.from && pos + node.nodeSize <= move.to) {
      const el = editor.view.nodeDOM(pos);
      if (el instanceof HTMLElement) moved.push(place(el, before));
      return false;
    }
    return true;
  });
  const neighbours = new Map<Element, { x: number; y: number }>();
  for (const el of root.children) neighbours.set(el, place(el, before));
  return () => {
    const after = base(),
      movedEls = new Set<Element>();
    const easing = "cubic-bezier(0.2, 0.8, 0.2, 1)";
    (
      transaction.getMeta(BLOCK_SELECTION_META) as number[] | undefined
    )?.forEach((pos, i) => {
      const el = editor.view.nodeDOM(pos),
        from = moved[i];
      if (!(el instanceof HTMLElement) || !from) return;
      movedEls.add(el);
      const to = place(el, after);
      el.animate(
        [
          {
            transform: `translate(${from.x - to.x}px, ${from.y - to.y}px)`,
            boxShadow: "0 12px 28px #1424442e",
            position: "relative",
            zIndex: 5,
          },
          { transform: "none", boxShadow: "0 0 0 transparent" },
        ],
        { duration: 340, easing },
      );
    });
    for (const [el, from] of neighbours) {
      if (!el.isConnected || movedEls.has(el)) continue;
      const to = place(el, after),
        dx = from.x - to.x,
        dy = from.y - to.y;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      el.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }],
        { duration: 240, easing },
      );
    }
  };
}
export function moveSelectedBlock(editor: Editor | null, direction: -1 | 1) {
  if (!editor?.isEditable) return false;
  const block = selectedDocumentBlock(editor.state);
  if (!block) return false;
  const target = adjacentBlockTarget(editor.state, [block.pos], direction);
  if (target === undefined) return false;
  try {
    applyBlockChange(
      editor,
      changeBlocks(editor.state, [block.pos], "move", target),
    );
    editor.commands.focus();
    return true;
  } catch {
    return false;
  }
}
export const BlockShortcuts = Extension.create({
  name: "blockShortcuts",
  addKeyboardShortcuts() {
    return {
      // Native document navigation can leave an atom selected in contenteditable.
      "Mod-Home": () => this.editor.commands.focus("start"),
      "Mod-End": () => this.editor.commands.focus("end"),
      "Mod-Shift-ArrowUp": () => moveSelectedBlock(this.editor, -1),
      "Mod-Shift-ArrowDown": () => moveSelectedBlock(this.editor, 1),
    };
  },
});

// A new line starts as plain text: bold, colours, highlights, super- and
// subscript do not carry over from the line above (Enter and Shift+Enter).
// The block itself behaves as before: lists and tasks continue with a new
// item, a heading is followed by a normal paragraph.
export const PlainNewLine = Extension.create({
  name: "plainNewLine",
  addProseMirrorPlugins() {
    let enter = false;
    return [
      new Plugin({
        props: {
          handleKeyDown(_view, event) {
            enter =
              event.key === "Enter" &&
              !event.isComposing &&
              !event.metaKey &&
              !event.ctrlKey &&
              !event.altKey;
            return false;
          },
        },
        appendTransaction(transactions, _old, state) {
          if (!enter || !transactions.some((tr) => tr.docChanged)) return null;
          enter = false;
          const { empty, $from } = state.selection;
          const lineStart =
            $from.parentOffset === 0 ||
            $from.nodeBefore?.type.name === "hardBreak";
          if (!empty || !lineStart || !$from.parent.isTextblock) return null;
          return state.tr.setStoredMarks([]);
        },
      }),
    ];
  },
});
