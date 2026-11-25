// Formulas from the keyboard (#541): with the caret right beside a formula,
// Backspace / Delete and the arrow keys open it for editing instead of
// deleting it or jumping over it. Plain ProseMirror in and out, so
// tests/math-keys.test.ts can check it without a browser.
//
// - Backspace directly after a formula (inline, or a block right above the
//   caret's block start): open it, caret at the end of its LaTeX.
// - Delete directly before one: open it, caret at the start.
// - ArrowLeft directly after / ArrowRight directly before an inline formula:
//   open it (caret at the end / start).
// - ArrowUp on the first line below a formula block / ArrowDown on the last
//   line above one: open it (caret at the end / start).
// Only with an empty selection and no modifier: ⇧ extends the selection,
// ⌥/Ctrl jump by words, ⌘ to the line's ends – as before. A formula that
// is selected as a node is still deleted by Backspace (no change here).
import type { Node as ProseMirrorNode, ResolvedPos } from "@tiptap/pm/model";
import type { EditorState } from "@tiptap/pm/state";

export type MathKeyAction = {
  type: "mathInline" | "mathBlock";
  // The formula's position in the document.
  pos: number;
  expression: string;
  // Where the caret goes in its LaTeX.
  caret: "start" | "end";
};
export type MathKey = {
  key: string;
  shiftKey?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
};

const isMath = (node: ProseMirrorNode | null | undefined, type: MathKeyAction["type"]) => node?.type.name === type;

// The block right before the caret's textblock when the caret is at its
// start (ProseMirror's own findCutBefore).
function blockBefore($pos: ResolvedPos): { node: ProseMirrorNode; pos: number } | null {
  if (!$pos.parent.isTextblock || $pos.parentOffset > 0) return null;
  for (let depth = $pos.depth - 1; depth >= 0; depth--) {
    if ($pos.index(depth) > 0) {
      const $cut = $pos.doc.resolve($pos.before(depth + 1));
      const node = $cut.nodeBefore;
      return node ? { node, pos: $cut.pos - node.nodeSize } : null;
    }
    if ($pos.node(depth).type.spec.isolating) break;
  }
  return null;
}
// The block right after the caret's textblock when the caret is at its end.
function blockAfter($pos: ResolvedPos): { node: ProseMirrorNode; pos: number } | null {
  if (!$pos.parent.isTextblock || $pos.parentOffset < $pos.parent.content.size) return null;
  for (let depth = $pos.depth - 1; depth >= 0; depth--) {
    const parent = $pos.node(depth);
    if ($pos.index(depth) + 1 < parent.childCount) {
      const $cut = $pos.doc.resolve($pos.after(depth + 1));
      const node = $cut.nodeAfter;
      return node ? { node, pos: $cut.pos } : null;
    }
    if (parent.type.spec.isolating) break;
  }
  return null;
}

// What a key does at the selection: open a formula (the answer) or nothing
// special (null: the editor's own handling). `atLineEdge` says whether the
// caret is on the first ("up") or last ("down") line of its textblock –
// the view's endOfTextblock; without it ArrowUp/ArrowDown do nothing here.
export function mathKeyAction(
  state: EditorState,
  event: MathKey,
  atLineEdge?: (direction: "up" | "down") => boolean,
): MathKeyAction | null {
  if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return null;
  const { selection } = state;
  if (!selection.empty) return null;
  const $pos = selection.$from;
  const open = (node: ProseMirrorNode, pos: number, caret: MathKeyAction["caret"]): MathKeyAction => ({
    type: node.type.name as MathKeyAction["type"],
    pos,
    expression: String(node.attrs.expression ?? ""),
    caret,
  });
  const before = $pos.nodeBefore,
    after = $pos.nodeAfter;
  switch (event.key) {
    case "Backspace": {
      if (isMath(before, "mathInline") || isMath(before, "mathBlock")) return open(before!, $pos.pos - before!.nodeSize, "end");
      const block = blockBefore($pos);
      return block && isMath(block.node, "mathBlock") ? open(block.node, block.pos, "end") : null;
    }
    case "Delete": {
      if (isMath(after, "mathInline") || isMath(after, "mathBlock")) return open(after!, $pos.pos, "start");
      const block = blockAfter($pos);
      return block && isMath(block.node, "mathBlock") ? open(block.node, block.pos, "start") : null;
    }
    case "ArrowLeft":
      return isMath(before, "mathInline") ? open(before!, $pos.pos - before!.nodeSize, "end") : null;
    case "ArrowRight":
      return isMath(after, "mathInline") ? open(after!, $pos.pos, "start") : null;
    case "ArrowUp": {
      // Between blocks (a gap cursor): the block right above.
      if (!$pos.parent.isTextblock) return isMath(before, "mathBlock") ? open(before!, $pos.pos - before!.nodeSize, "end") : null;
      if (!atLineEdge?.("up")) return null;
      const block = blockBefore($pos.doc.resolve($pos.start()));
      return block && isMath(block.node, "mathBlock") ? open(block.node, block.pos, "end") : null;
    }
    case "ArrowDown": {
      if (!$pos.parent.isTextblock) return isMath(after, "mathBlock") ? open(after!, $pos.pos, "start") : null;
      if (!atLineEdge?.("down")) return null;
      const block = blockAfter($pos.doc.resolve($pos.end()));
      return block && isMath(block.node, "mathBlock") ? open(block.node, block.pos, "start") : null;
    }
  }
  return null;
}

// Inside the formula's text field: whether a key leaves it, and on which
// side of the formula the caret goes in the document. ArrowLeft at the
// very start / ArrowRight at the very end; in a formula block also ArrowUp
// on its first line / ArrowDown on its last. Only without a selection in
// the field and without modifiers.
export function mathLeaveSide(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  event: MathKey,
  block: boolean,
): "before" | "after" | null {
  if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return null;
  if (selectionStart !== selectionEnd) return null;
  const at = selectionStart;
  switch (event.key) {
    case "ArrowLeft":
      return at === 0 ? "before" : null;
    case "ArrowRight":
      return at === value.length ? "after" : null;
    case "ArrowUp":
      return block && !value.slice(0, at).includes("\n") ? "before" : null;
    case "ArrowDown":
      return block && !value.slice(at).includes("\n") ? "after" : null;
  }
  return null;
}
