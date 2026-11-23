// The highlight colour of a text comment thread (#450): the author (or an
// editor) picks one of the text background colours – the same nine names as
// the block colours and highlights (lib/block-colors.ts) –, everyone sees
// it. Stored as a name in inline_threads.color, never as a colour value, so
// the theme decides the shade (app/comment-margin.css, light and dark).
// NULL – and "yellow", the default – is the yellow every thread had before.
// Kept free of imports: the comments panel in the shell reads it (the
// editor's lib/block-colors.ts would bring Tiptap along);
// tests/comment-popover-layout.test.ts checks the names are the same.
export const COMMENT_COLORS = ["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"] as const;
export type CommentColor = (typeof COMMENT_COLORS)[number];
export const DEFAULT_COMMENT_COLOR: CommentColor = "yellow";

// What is stored: null for the default, else the palette name.
export function storedCommentColor(value: unknown): CommentColor | null {
  if (typeof value !== "string" || value === DEFAULT_COMMENT_COLOR) return null;
  return (COMMENT_COLORS as readonly string[]).includes(value) ? (value as CommentColor) : null;
}

// The colour a thread shows (stored NULL or an unknown name: yellow).
export function commentColorOf(value: unknown): CommentColor {
  return storedCommentColor(value) || DEFAULT_COMMENT_COLOR;
}
