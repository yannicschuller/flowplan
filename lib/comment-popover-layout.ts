// Where a text comment's popover goes (#450, components/comment-popover.tsx)
// when there is no room for the margin beside the text: beside the text
// column at the height of the passage where the window leaves room there,
// else right below the passage (above it when below is too small), kept
// inside the visible area. On phones a bottom sheet instead
// (`sheet`): the caller keeps the passage visible above it.
// The hover preview of a highlight (components/comment-preview.tsx) uses
// the same rules without the side placement.
// Plain numbers in and out, so tests/comment-popover-layout.test.ts can
// check it without a browser.

export type Box = { left: number; top: number; right: number; bottom: number };
export type PopoverPlacement = {
  side: "beside" | "below" | "above";
  left: number;
  top: number;
  // The most the popover may grow (it scrolls inside beyond that).
  maxHeight: number;
};

// Up to this width the popover is a bottom sheet.
export const COMMENT_SHEET_MAX_WIDTH = 600;
const EDGE = 8;

export function placeCommentPopover({
  passage,
  text,
  size,
  viewport,
  gap = 8,
  beside = true,
}: {
  // The passage's box on screen (the union of its highlight's lines).
  passage: Box;
  // The text column's box (the editor), for the place beside it.
  text?: Box | null;
  size: { width: number; height: number };
  // The visible area: { left: 0, top: offsetTop, right: width, bottom: offsetTop + height }.
  viewport: Box;
  gap?: number;
  beside?: boolean;
}): PopoverPlacement {
  const minTop = viewport.top + EDGE,
    maxBottom = viewport.bottom - EDGE,
    room = Math.max(120, maxBottom - minTop);
  const clampLeft = (left: number) =>
    Math.max(viewport.left + EDGE, Math.min(left, viewport.right - EDGE - size.width));
  // Beside the text, where the window has room right of the text column.
  if (beside && text && viewport.right - EDGE - (text.right + gap) >= size.width) {
    const top = Math.max(minTop, Math.min(passage.top, maxBottom - Math.min(size.height, room)));
    return { side: "beside", left: text.right + gap, top, maxHeight: Math.max(120, maxBottom - top) };
  }
  const left = clampLeft(passage.left);
  const below = maxBottom - (passage.bottom + gap),
    above = passage.top - gap - minTop;
  if (size.height <= below || below >= above)
    return { side: "below", left, top: passage.bottom + gap, maxHeight: Math.max(120, below) };
  const height = Math.min(size.height, above);
  return { side: "above", left, top: passage.top - gap - height, maxHeight: Math.max(120, above) };
}

// The union of a passage's line boxes (null without any drawn box).
export function unionBox(rects: Iterable<Box & { width?: number; height?: number }>): Box | null {
  let box: Box | null = null;
  for (const r of rects) {
    if (r.width === 0 && r.height === 0) continue;
    box = box
      ? { left: Math.min(box.left, r.left), top: Math.min(box.top, r.top), right: Math.max(box.right, r.right), bottom: Math.max(box.bottom, r.bottom) }
      : { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  }
  return box;
}

// The first comment shortened for the hover preview: whitespace folded, at
// most `max` characters, cut at a word where one is near.
export function shortComment(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1),
    space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

// The visible area of the window (the visual viewport where there is one:
// the on-screen keyboard and pinch zoom leave less of it).
export function visibleViewport(): Box {
  const vv = window.visualViewport;
  const top = vv?.offsetTop ?? 0,
    left = vv?.offsetLeft ?? 0;
  return { left, top, right: left + (vv?.width ?? window.innerWidth), bottom: top + (vv?.height ?? window.innerHeight) };
}

// Sets --popover-left/--popover-top so the element's box lands at (x, y) on
// screen, whatever its containing block is.
export function placeFixed(el: HTMLElement, x: number, y: number) {
  el.style.setProperty("--popover-left", `${Math.round(x)}px`);
  el.style.setProperty("--popover-top", `${Math.round(y)}px`);
  const box = el.getBoundingClientRect();
  const dx = Math.round(box.left - x),
    dy = Math.round(box.top - y);
  if (dx || dy) {
    el.style.setProperty("--popover-left", `${Math.round(x - dx)}px`);
    el.style.setProperty("--popover-top", `${Math.round(y - dy)}px`);
  }
}

