// Clickable prototypes: frames are screens, any element can link to a frame
// ("Bei Klick → zu Rahmen X") or back to the previous one. Pure helpers for
// the player (components/whiteboard/prototype-player.tsx) and the tests.
import { connectorPoint, type WhiteboardItem } from "./whiteboard-model";
import { linkTarget } from "./whiteboard-diagram-model";

// Frames in reading order: top to bottom, then left to right.
export const prototypeFrames = (items: WhiteboardItem[]) =>
  items.filter((i) => i.type === "frame").sort((a, b) => a.y - b.y || a.x - b.x);

const inside = (item: { x: number; y: number; w: number; h: number }, frame: WhiteboardItem) =>
  item.x >= frame.x && item.y >= frame.y && item.x + item.w <= frame.x + frame.w && item.y + item.h <= frame.y + frame.h;
// What is drawn on a frame: the items lying fully inside it (like moving a
// frame carries them), connectors with both ends inside.
export function frameContents(frame: WhiteboardItem, items: WhiteboardItem[]) {
  const map = new Map(items.map((i) => [i.id, i]));
  return items.filter((item) => {
    if (item.id === frame.id || item.type === "comment" || item.type === "frame") return false;
    if (item.type === "connector") {
      const a = connectorPoint(item.from, map),
        b = connectorPoint(item.to, map);
      return inside({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) }, frame);
    }
    return inside(item, frame);
  });
}
// The frame a prototype starts on: the selected frame, the frame around the
// selection, or the first frame.
export function startFrame(items: WhiteboardItem[], selection: ReadonlySet<string>) {
  const frames = prototypeFrames(items);
  const picked = items.filter((i) => selection.has(i.id));
  const frame = picked.find((i) => i.type === "frame") || frames.find((f) => picked.some((i) => inside(i, f)));
  return (frame || frames[0])?.id || null;
}
export type Hotspot = { id: string; x: number; y: number; w: number; h: number; target: { frame: string } | { back: true }; valid: boolean };
// The clickable elements of a frame and where they lead.
export function hotspots(frame: WhiteboardItem, items: WhiteboardItem[]): Hotspot[] {
  const frames = new Set(items.filter((i) => i.type === "frame").map((i) => i.id));
  return frameContents(frame, items)
    .filter((i) => i.type !== "connector" && i.link)
    .flatMap((i) => {
      const target = linkTarget(i.link);
      if (!target) return [];
      return [{ id: i.id, x: i.x, y: i.y, w: i.w, h: i.h, target, valid: "back" in target || frames.has(target.frame) }];
    });
}
// The path through the prototype: the current frame is the last entry.
export function followLink(history: string[], target: Hotspot["target"], frames: Set<string>): string[] {
  if ("back" in target) return history.length > 1 ? history.slice(0, -1) : history;
  if (!frames.has(target.frame) || history[history.length - 1] === target.frame) return history;
  return [...history, target.frame].slice(-100);
}
