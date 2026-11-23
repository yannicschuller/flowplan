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

// A new drawing block comes into view (#440): inserted at the end of a page
// on a tablet, the view stayed on the line below it (where the caret went,
// above the on-screen keyboard), and once the keyboard went the block sat
// half out of sight with the touch shield around it. `target` is the block
// with its toolbar, `area` the part of the screen the person sees (client
// coordinates, without bars, keyboard and safe areas). The result is how
// far to scroll down (negative: up): nothing when it is fully in view; a
// block that fits is brought fully into view, the shortest way; one taller
// than the area has its top at the area's top.
export const REVEAL_MARGIN = 12;
export function revealOffset(target: { top: number; bottom: number }, area: { top: number; bottom: number }, margin = REVEAL_MARGIN) {
  const top = area.top + margin,
    bottom = area.bottom - margin;
  if (target.bottom - target.top > bottom - top) return Math.round(target.top - top);
  if (target.top < top) return Math.round(target.top - top);
  if (target.bottom > bottom) return Math.round(target.bottom - bottom);
  return 0;
}
