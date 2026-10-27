// Frames as slides: the order of the presentation, frames left out of it,
// and what belongs to a frame. The order is a number on each frame
// ("slide", set by dragging in the frames panel), so it syncs and undoes
// like any other change; frames without one – every frame of older boards,
// new frames – follow in reading order (top to bottom, left to right).
import type { WhiteboardItem } from "./whiteboard-model";

type Frame = Pick<WhiteboardItem, "id" | "type" | "x" | "y" | "w" | "h" | "presentHidden" | "slide">;
export const readingOrder = <T extends Pick<WhiteboardItem, "x" | "y">>(frames: T[]) =>
  [...frames].sort((a, b) => a.y - b.y || a.x - b.x);

const placed = (f: Frame) => typeof f.slide === "number" && Number.isFinite(f.slide);
// Every frame in presentation order (hidden ones too, for the panel).
export function frameSequence<T extends Frame>(items: T[]): T[] {
  const frames = items.filter((i) => i.type === "frame");
  const listed = readingOrder(frames.filter(placed)).sort((a, b) => a.slide! - b.slide!);
  const rest = readingOrder(frames.filter((f) => !placed(f)));
  return [...listed, ...rest];
}
// The slides of the presentation: in order, without the hidden frames.
export function presentationSlides<T extends Frame>(items: T[]): T[] {
  return frameSequence(items).filter((f) => !f.presentHidden);
}
// The places after moving the frame at `from` to `to` (indexes of the
// full sequence): every frame gets its number, so the order holds for
// everyone even when frames move on the board later.
export function moveFrame(sequence: string[], from: number, to: number): Map<string, number> {
  const next = [...sequence];
  if (from >= 0 && from < next.length) {
    const [moved] = next.splice(from, 1);
    next.splice(Math.max(0, Math.min(next.length, to)), 0, moved);
  }
  return new Map(next.map((id, i) => [id, i + 1]));
}
// What a frame shows: elements whose middle lies inside it (connectors by
// both ends). Frames inside frames count too.
export function frameMembers<T extends WhiteboardItem>(
  frame: Pick<WhiteboardItem, "id" | "x" | "y" | "w" | "h">,
  items: T[],
  point: (end: WhiteboardItem["from"]) => { x: number; y: number },
): Set<string> {
  const inside = (p: { x: number; y: number }) =>
    p.x >= frame.x && p.x <= frame.x + frame.w && p.y >= frame.y && p.y <= frame.y + frame.h;
  const out = new Set<string>([frame.id]);
  for (const item of items) {
    if (item.id === frame.id) continue;
    if (item.type === "connector") {
      if (inside(point(item.from)) && inside(point(item.to))) out.add(item.id);
    } else if (inside({ x: item.x + item.w / 2, y: item.y + item.h / 2 })) out.add(item.id);
  }
  return out;
}
