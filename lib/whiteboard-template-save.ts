// A board or a selection as template elements: positions from the top left
// corner, in their depth order, without what belongs to people (comments,
// votes, stamps, authors, locks, covers). Connectors to elements outside
// keep their end where it is. The server checks the result again
// (lib/whiteboard-user-templates.ts cleanTemplateItems).
import { connectorPoint, type WhiteboardItem } from "./whiteboard-model";
import { contentBounds } from "./whiteboard-geometry";
import type { Draft } from "./whiteboard-template-gallery";

const personal = ["votes", "stamps", "messages", "author", "locked", "covered", "resolved", "z"] as const;
export function templateDrafts(list: WhiteboardItem[], all: WhiteboardItem[] = list): Draft[] {
  const map = new Map(all.map((i) => [i.id, i]));
  const chosen = list.filter((i) => i.type !== "comment").sort((a, b) => (a.z || 0) - (b.z || 0));
  const ids = new Set(chosen.map((i) => i.id));
  const box = contentBounds(chosen, map);
  if (!box) return [];
  const dx = -Math.round(box.x),
    dy = -Math.round(box.y);
  return chosen.map((item, index) => {
    const draft: Record<string, unknown> = { ...item, x: item.x + dx, y: item.y + dy, z: index };
    for (const key of personal) if (key !== "z") delete draft[key];
    for (const end of ["from", "to"] as const) {
      const e = item[end];
      if (!e) continue;
      if (e.id && ids.has(e.id)) draft[end] = { id: e.id, x: e.x + dx, y: e.y + dy };
      else {
        const p = connectorPoint(e, map);
        draft[end] = { x: Math.round(p.x + dx), y: Math.round(p.y + dy) };
      }
    }
    return draft as Draft;
  });
}
