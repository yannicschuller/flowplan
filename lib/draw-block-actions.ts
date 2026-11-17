import type { EditorState, Transaction } from "@tiptap/pm/state";
import { adjacentBlockTarget, changeBlocks } from "./document-blocks";
// The "…" menu of a drawing block (components/ink/draw-block-editor.tsx,
// #322): on an iPad the block handle is out of reach once the block takes
// touches, so the block offers delete, duplicate and move itself – the
// same block changes as the handle's menu (lib/document-blocks.ts; a
// duplicate gets a fresh ink id and starts from the original's ink,
// lib/linked-paste.ts).
export type DrawBlockAction = "delete" | "duplicate" | "up" | "down";

// Where the block can go from `pos`: a sibling above or below it.
export function drawBlockMoves(state: EditorState, pos: number) {
  const can = (direction: -1 | 1) => {
    try {
      return adjacentBlockTarget(state, [pos], direction) !== undefined;
    } catch {
      return false;
    }
  };
  return { up: can(-1), down: can(1) };
}

// The change for an action on the block at `pos`, or null when it cannot
// be done there (no neighbour to move past, not a block of the document).
export function drawBlockChange(state: EditorState, pos: number, action: DrawBlockAction): Transaction | null {
  try {
    if (state.doc.nodeAt(pos)?.type.name !== "drawBlock") return null;
    if (action === "delete" || action === "duplicate") return changeBlocks(state, [pos], action);
    const target = adjacentBlockTarget(state, [pos], action === "up" ? -1 : 1);
    return target === undefined ? null : changeBlocks(state, [pos], "move", target);
  } catch {
    return null;
  }
}

// The hint on the block's height (#324): once per device, with the first
// new drawing block. The resize handle is hidden while drawing; the tip says
// where it is after Done. Storage that fails counts as "already shown" – a
// tip that cannot be remembered would come with every new block.
export const HEIGHT_TIP_KEY = "flowplan-draw-height-tip";
export const HEIGHT_TIP_MS = 5000;
type TipStorage = Pick<Storage, "getItem" | "setItem">;
// `storage` is a getter: reading window.localStorage itself can throw.
export function takeHeightTip(storageOf: () => TipStorage | null | undefined): boolean {
  try {
    const storage = storageOf();
    if (!storage || storage.getItem(HEIGHT_TIP_KEY)) return false;
    storage.setItem(HEIGHT_TIP_KEY, "1");
    return true;
  } catch {
    return false;
  }
}
