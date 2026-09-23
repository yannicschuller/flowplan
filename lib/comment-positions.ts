import * as Y from "yjs";
import {
  absolutePositionToRelativePosition,
  relativePositionToAbsolutePosition,
} from "@tiptap/y-tiptap";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { CommentAnchor } from "./inline-comment-types";

// Same structural mapping on server and client; never fall back to matching a
// repeated quote elsewhere in a document when an anchor can no longer resolve.
export type CommentBinding = {
  doc: Y.Doc;
  type: Y.XmlFragment;
  mapping: Parameters<typeof absolutePositionToRelativePosition>[2];
  content: ProseMirrorNode;
};
export function commentQuote(
  content: ProseMirrorNode,
  from: number,
  to: number,
) {
  return content.textBetween(from, to, "\n", "\uFFFC");
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
