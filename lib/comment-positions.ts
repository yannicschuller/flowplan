import * as Y from "yjs";
import {
  absolutePositionToRelativePosition,
  relativePositionToAbsolutePosition,
} from "@tiptap/y-tiptap";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { Mappable } from "@tiptap/pm/transform";
import type { CommentAnchor } from "./inline-comment-types";

// Same structural mapping on server and client; never fall back to matching a
// repeated quote elsewhere in a document when an anchor can no longer resolve.
export type CommentBinding = {
  doc: Y.Doc;
  type: Y.XmlFragment;
  mapping: Parameters<typeof absolutePositionToRelativePosition>[2];
  content: ProseMirrorNode;
};
// The quoted passage: blocks and hard line breaks (Shift+Enter) become line
// breaks, every other embedded node (image, formula, mention …) U+FFFC,
// which the comment panel shows as a "media block" placeholder.
export const QUOTE_OBJECT = "\uFFFC";
export function commentQuote(
  content: ProseMirrorNode,
  from: number,
  to: number,
) {
  return content.textBetween(from, to, "\n", (node) =>
    node.type.name === "hardBreak" ? "\n" : QUOTE_OBJECT,
  );
}
// Quotes stored before hard breaks became line breaks had U+FFFC there.
function legacyCommentQuote(content: ProseMirrorNode, from: number, to: number) {
  return content.textBetween(from, to, "\n", QUOTE_OBJECT);
}
// Whether the passage at from–to is the one a thread quotes.
export function sameCommentQuote(
  content: ProseMirrorNode,
  from: number,
  to: number,
  quote: string,
) {
  return (
    commentQuote(content, from, to) === quote ||
    legacyCommentQuote(content, from, to) === quote
  );
}
export function commentAnchor(
  binding: CommentBinding,
  from: number,
  to: number,
  generation: string,
): CommentAnchor {
  if (from < 0 || to > binding.content.content.size || from >= to)
    throw new Error("Bitte eine Textstelle oder einen Block auswählen.");
  const quote = commentQuote(binding.content, from, to);
  if (!quote.trim() || quote.length > 4000)
    throw new Error(
      "Bitte eine Textstelle mit höchstens 4.000 Zeichen auswählen.",
    );
  return {
    generation,
    quote,
    positions: {
      anchor: Y.relativePositionToJSON(
        absolutePositionToRelativePosition(from, binding.type, binding.mapping),
      ),
      head: Y.relativePositionToJSON(
        absolutePositionToRelativePosition(to, binding.type, binding.mapping),
      ),
    },
  } as CommentAnchor;
}
export function commentRange(
  binding: CommentBinding,
  anchor: CommentAnchor,
  generation: string,
) {
  if (anchor.generation !== generation) return null;
  try {
    const resolve = (p: CommentAnchor["positions"]["anchor"]) =>
      relativePositionToAbsolutePosition(
        binding.doc,
        binding.type,
        Y.createRelativePositionFromJSON(p),
        binding.mapping,
      );
    const a = resolve(anchor.positions.anchor),
      b = resolve(anchor.positions.head);
    if (a === null || b === null) return null;
    const from = Math.min(a, b),
      to = Math.max(a, b);
    if (
      from >= to ||
      from < 0 ||
      to > binding.content.content.size ||
      !commentQuote(binding.content, from, to).trim()
    )
      return null;
    return { from, to };
  } catch {
    return null;
  }
}

// Where blocks moved by changeBlocks (lib/document-blocks.ts) came from
// (from–to, before the transaction) and where they are now (start–end).
export type BlockMove = { from: number; to: number; start?: number; end?: number };
type Range = { from: number; to: number };
function textblocksIn(doc: ProseMirrorNode, from: number, to: number) {
  const blocks: { pos: number; node: ProseMirrorNode }[] = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isTextblock) return true;
    if (pos >= from && pos + node.nodeSize <= to) blocks.push({ pos, node });
    return false;
  });
  return blocks;
}
// Yjs has no move: a moved block (or the neighbour it swapped places with)
// is deleted and inserted again, so relative positions inside it no longer
// resolve (#314). This is where a passage of the old document is after the
// move, by the structure of the transaction, or null when it cannot be
// followed exactly (the quoted text must be unchanged).
export function movedCommentRange(
  before: ProseMirrorNode,
  after: ProseMirrorNode,
  mapping: Mappable,
  move: BlockMove,
  range: Range,
): Range | null {
  if (range.from >= range.to) return null;
  let next: Range | null = null;
  if (range.from >= move.from && range.to <= move.to) {
    if (move.start === undefined || move.end === undefined) return null;
    const moved = before.slice(move.from, move.to).content,
      placed = after.slice(move.start, move.end).content;
    if (moved.eq(placed)) {
      const shift = move.start - move.from;
      next = { from: range.from + shift, to: range.to + shift };
    } else {
      // Blocks that adapted to their new place (a paragraph that became a
      // list item …) keep their text blocks in order.
      const old = textblocksIn(before, move.from, move.to),
        now = textblocksIn(after, move.start, move.end);
      if (old.length !== now.length) return null;
      const at = (pos: number) => {
        const i = old.findIndex(
          (b) => pos > b.pos && pos < b.pos + b.node.nodeSize,
        );
        return i >= 0 && old[i].node.textContent === now[i].node.textContent
          ? now[i].pos + (pos - old[i].pos)
          : null;
      };
      const from = at(range.from),
        to = at(range.to);
      next = from === null || to === null ? null : { from, to };
    }
  } else if (range.to <= move.from || range.from >= move.to)
    next = { from: mapping.map(range.from, 1), to: mapping.map(range.to, -1) };
  if (!next || next.from >= next.to || next.from < 0 || next.to > after.content.size)
    return null;
  return commentQuote(after, next.from, next.to) ===
    commentQuote(before, range.from, range.to)
    ? next
    : null;
}
