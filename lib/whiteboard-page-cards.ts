// Page cards with the whole document (#549): when a card of a document
// page shows its content, and how a new page's card is sized. Kept apart
// from the drawing so it can be tested without a browser.
import type { WhiteboardItem } from "./whiteboard-model";

// What of the board is in view (world coordinates) and its zoom.
export type CardView = { x: number; y: number; w: number; h: number; zoom: number };

// From this size on (world units) a page card shows the whole document;
// smaller cards keep their title and first lines.
export const FULL_CARD_MIN = { w: 300, h: 220 };
// …and only while it is large enough on screen to be read (pixels).
export const FULL_CARD_SCREEN_MIN = { w: 180, h: 130 };

// Whether a document card is drawn with its whole document: large enough,
// readable at the zoom, and in view (or just beside it, so panning a
// little does not load and unload it).
export function fullPageCard(item: Pick<WhiteboardItem, "x" | "y" | "w" | "h" | "rotation">, view: CardView) {
  if (item.w < FULL_CARD_MIN.w || item.h < FULL_CARD_MIN.h) return false;
  if (item.w * view.zoom < FULL_CARD_SCREEN_MIN.w || item.h * view.zoom < FULL_CARD_SCREEN_MIN.h) return false;
  const mx = view.w / 2,
    my = view.h / 2;
  return item.x + item.w >= view.x - mx && item.x <= view.x + view.w + mx && item.y + item.h >= view.y - my && item.y <= view.y + view.h + my;
}

// The card of a page made on the board: large enough for its document,
// at most 85 % of the visible board, centred on `at`.
export function newPageCard(at: { x: number; y: number }, view: Pick<CardView, "w" | "h">) {
  const scale = Math.min(1, (view.w * 0.85) / 440, (view.h * 0.85) / 340);
  const w = Math.max(FULL_CARD_MIN.w, Math.round(440 * scale)),
    h = Math.max(FULL_CARD_MIN.h, Math.round(340 * scale));
  return { x: Math.round(at.x - w / 2), y: Math.round(at.y - h / 2), w, h };
}

// Whether a wheel turn over a card's document scrolls the document rather
// than the board: the card is selected, or the pointer has rested on it
// (a moment after the board last scrolled under it – a pan that passes
// over a card goes on panning), and the document can still scroll that way.
export function wheelScrollsCard(input: {
  selected: boolean;
  // Since when the pointer is over this card, and when the board last panned (ms).
  hoverSince: number | null;
  lastPan: number;
  now: number;
  deltaY: number;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}) {
  const resting = input.hoverSince !== null && input.now - input.hoverSince >= 350 && input.now - input.lastPan >= 350;
  if (!input.selected && !resting) return false;
  if (input.deltaY < 0) return input.scrollTop > 0;
  if (input.deltaY > 0) return input.scrollTop + input.clientHeight < input.scrollHeight - 1;
  return false;
}
