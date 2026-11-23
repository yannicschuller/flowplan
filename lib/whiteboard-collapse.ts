// Collapsible frames (#455). A collapsed frame keeps its place and width and
// shows only its title bar; what lies in it is hidden – not drawn, not
// selectable, not hit – until it is expanded again. Frames inside frames
// collapse the same way.
//
// Stored in the frame as `collapsed`: the ids of what it hid when it was
// collapsed (present = collapsed). An element counts as hidden while it is
// listed there and still lies in the frame (lib/whiteboard-frames.ts,
// frameMembers), so what is dropped onto the collapsed bar later stays
// visible, and what someone moved out with an older version shows up
// again. Older versions ignore the property and show the frame open.
//
// The board draws the folded view of its items (foldView): hidden elements
// left out, collapsed frames as their bar, connectors to hidden elements
// ending at the collapsed frame. The real items stay in the document; the
// board moves hidden elements along with their frame and copies them with
// it.
import { frameMembers } from "./whiteboard-frames";
import { connectorPoint, type WhiteboardItem } from "./whiteboard-model";

// The height of a collapsed frame's bar (the title sits above it).
export const COLLAPSED_HEIGHT = 36;
// At most this many ids are stored in a frame (larger frames hide the
// first ones listed and show the rest).
export const MAX_COLLAPSED = 5000;

export const isCollapsed = (item: Pick<WhiteboardItem, "type" | "collapsed"> | undefined) =>
  !!item && item.type === "frame" && Array.isArray(item.collapsed);

// What lies in a frame (lib/whiteboard-frames.ts: by the middle, connectors
// by both ends); other frames only when they lie in it as a whole, so a
// frame never hides the frame around it.
function inFrame(frame: WhiteboardItem, items: WhiteboardItem[], byId: Map<string, WhiteboardItem>): string[] {
  const inside = frameMembers(frame, items, (end) => connectorPoint(end, byId));
  inside.delete(frame.id);
  return [...inside].filter((id) => {
    const item = byId.get(id);
    return item?.type !== "frame" || (item.x >= frame.x && item.y >= frame.y && item.x + item.w <= frame.x + frame.w && item.y + item.h <= frame.y + frame.h);
  });
}
// What a frame hides when it is collapsed now.
export function collapseMembers(frame: WhiteboardItem, items: WhiteboardItem[]): string[] {
  return inFrame(frame, items, new Map(items.map((i) => [i.id, i]))).slice(0, MAX_COLLAPSED);
}

export type FoldView = {
  // The items as the board shows them.
  items: WhiteboardItem[];
  // Hidden element → the visible collapsed frame it is folded into.
  hiddenIn: Map<string, string>;
  // Collapsed frame → every element it hides (nested ones too).
  hidden: Map<string, string[]>;
};

// `open` overrides the stored state for this viewer only: true shows a
// collapsed frame open, false collapses an open one (people who may not
// change the board fold frames for themselves).
export function foldView(all: WhiteboardItem[], open: ReadonlyMap<string, boolean> = new Map()): FoldView {
  const byId = new Map(all.map((i) => [i.id, i]));
  const folded = all.filter((i) => i.type === "frame" && (open.has(i.id) ? !open.get(i.id) : isCollapsed(i)));
  const hidden = new Map<string, string[]>();
  const by = new Map<string, string[]>();
  for (const frame of folded) {
    const listed = Array.isArray(frame.collapsed) && !open.has(frame.id) ? new Set(frame.collapsed) : null;
    const ids = inFrame(frame, all, byId).filter((id) => !listed || listed.has(id));
    hidden.set(frame.id, ids);
    for (const id of ids) by.set(id, [...(by.get(id) || []), frame.id]);
  }
  if (!hidden.size && !open.size) return { items: all, hiddenIn: new Map(), hidden };
  // An element is shown in the outermost collapsed frame that is itself
  // visible.
  const hiddenIn = new Map<string, string>();
  for (const [id, frames] of by) hiddenIn.set(id, frames.find((f) => !by.has(f)) ?? frames[0]);
  const items: WhiteboardItem[] = [];
  for (const item of all) {
    if (hiddenIn.has(item.id)) continue;
    if (hidden.has(item.id)) {
      items.push({ ...item, h: Math.min(item.h, COLLAPSED_HEIGHT), collapsed: hidden.get(item.id) });
      continue;
    }
    if (item.type === "frame" && item.collapsed !== undefined) {
      // Shown open for this viewer.
      const { collapsed: _collapsed, ...rest } = item;
      items.push(rest);
      continue;
    }
    if (item.type === "connector") {
      const from = item.from?.id ? hiddenIn.get(item.from.id) : undefined,
        to = item.to?.id ? hiddenIn.get(item.to.id) : undefined;
      if (from || to) {
        // Both ends folded into the same frame: nothing to show.
        const fromAt = from ?? item.from?.id,
          toAt = to ?? item.to?.id;
        if (fromAt && fromAt === toAt) {
          hiddenIn.set(item.id, fromAt);
          continue;
        }
        items.push({
          ...item,
          ...(from && item.from ? { from: { x: item.from.x, y: item.from.y, id: from } } : {}),
          ...(to && item.to ? { to: { x: item.to.x, y: item.to.y, id: to } } : {}),
        });
        continue;
      }
    }
    items.push(item);
  }
  return { items, hiddenIn, hidden };
}

// The collapsed frames that keep an element out of sight, outermost first,
// and the element itself when it is a collapsed frame: what to expand to
// show it.
export function foldersOf(id: string, view: FoldView, byId: Map<string, WhiteboardItem>): string[] {
  const out: string[] = [];
  for (const [frame, ids] of view.hidden) if (frame === id || ids.includes(id)) out.push(frame);
  return out.sort((a, b) => depth(a, view) - depth(b, view)).filter((f) => byId.has(f));
}
const depth = (frame: string, view: FoldView) => [...view.hidden.values()].filter((ids) => ids.includes(frame)).length;

// The elements to copy for a selection on the folded board: the stored
// items (collapsed frames at full height, connectors to their real ends)
// with everything a collapsed frame of the selection hides.
export function unfoldForCopy<T extends WhiteboardItem>(selected: T[], view: FoldView, all: Map<string, WhiteboardItem>): WhiteboardItem[] {
  const out = new Map<string, WhiteboardItem>();
  for (const item of selected) {
    out.set(item.id, all.get(item.id) ?? item);
    for (const id of view.hidden.get(item.id) || []) {
      const inner = all.get(id);
      if (inner) out.set(id, inner);
    }
  }
  // Connectors between hidden elements of the copy go along.
  for (const [id, frame] of view.hiddenIn) {
    const item = all.get(id);
    if (item?.type === "connector" && out.has(frame) && !out.has(id)) out.set(id, item);
  }
  return [...out.values()].sort((a, b) => (a.z || 0) - (b.z || 0));
}
