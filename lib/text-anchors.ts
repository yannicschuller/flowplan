// Positions that mean the same in a member's document and in a guest's
// projection (lib/shared-live.ts): the n-th text block and the character
// offset in it. The projection keeps the block structure (hidden content
// becomes placeholders), so these addresses carry over, unlike Yjs
// positions, which belong to one Yjs document.
import type { Node } from "@tiptap/pm/model";

export type TextPoint = { b: number; o: number };
export type TextCursor = { anchor: TextPoint; head: TextPoint };

export function toTextPoint(doc: Node, pos: number): TextPoint | null {
  let index = -1,
    found: TextPoint | null = null;
  doc.descendants((node, start) => {
    if (found) return false;
    if (!node.isTextblock) return true;
    index++;
    const from = start + 1,
      to = from + node.content.size;
    if (pos >= from && pos <= to) found = { b: index, o: pos - from };
    return false;
  });
  return found;
}

export function fromTextPoint(doc: Node, point: TextPoint): number | null {
  let index = -1,
    found: number | null = null;
  doc.descendants((node, start) => {
    if (found !== null) return false;
    if (!node.isTextblock) return true;
    index++;
    if (index === point.b) found = start + 1 + Math.min(point.o, node.content.size);
    return false;
  });
  return found;
}

export function toTextCursor(doc: Node, anchor: number, head: number): TextCursor | null {
  const a = toTextPoint(doc, anchor),
    h = toTextPoint(doc, head);
  return a && h ? { anchor: a, head: h } : null;
}
