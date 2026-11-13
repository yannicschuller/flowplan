// "Umwandeln in" at the start of the full text menu (#235,
// components/text-menu.tsx): the type of the block the selection starts in,
// shown as "Text ›", and the formatting "Formatierung entfernen" clears.
import type { EditorState } from "@tiptap/pm/state";
import { toggleHeading } from "./document-schema";

export type TextBlockKind =
  | { type: "paragraph" }
  | { type: "heading"; level: number }
  | { type: "bulletList" | "orderedList" | "taskList" }
  | { type: "toggle"; heading: number | null }
  | { type: "blockquote" }
  | { type: "callout" }
  | { type: "codeBlock" };

// The innermost block around the selection's start that "Turn into"
// changes, with its position: a list item, a toggle, a quote or callout
// around a paragraph, or the text block itself.
export function currentTextBlock(state: EditorState): { kind: TextBlockKind; pos: number } | null {
  const { $from } = state.selection;
  if (!$from.parent.isTextblock) return null;
  const depth = $from.depth;
  const textblock = $from.parent;
  const textPos = $from.before(depth);
  if (textblock.type.name === "codeBlock") return { kind: { type: "codeBlock" }, pos: textPos };
  if (textblock.type.name === "heading") return { kind: { type: "heading", level: Number(textblock.attrs.level) || 1 }, pos: textPos };
  // The paragraph's parent decides: a list item (its list), a quote, a
  // callout or a toggle whose first paragraph it is.
  if (depth > 1) {
    const parent = $from.node(depth - 1);
    const name = parent.type.name;
    if ((name === "listItem" || name === "taskItem") && depth > 2) {
      const list = $from.node(depth - 2).type.name;
      if (list === "bulletList" || list === "orderedList" || list === "taskList") return { kind: { type: list }, pos: $from.before(depth - 1) };
    }
    if ((name === "blockquote" || name === "callout") && $from.index(depth - 1) === 0) return { kind: { type: name }, pos: $from.before(depth - 1) };
  }
  return { kind: { type: "paragraph" }, pos: textPos };
}

// Whether a kind is the one shown.
export const sameKind = (a: TextBlockKind, b: TextBlockKind) =>
  a.type === b.type &&
  (a.type !== "heading" || a.level === (b as { level: number }).level) &&
  (a.type !== "toggle" || toggleHeading(a.heading) === toggleHeading((b as { heading: number | null }).heading));

// The marks "Formatierung entfernen" takes off the selection. Links,
// comments, suggestions and other marks that carry content stay.
export const CLEARED_MARKS = ["bold", "italic", "underline", "strike", "code", "highlight", "textColor", "superscript", "subscript", "spoiler"];
