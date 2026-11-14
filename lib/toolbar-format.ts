// The alignment and block style menus of the formatting toolbar (#278):
// what the text at the caret is now, the choices and their shortcuts. Pure,
// on the editor state, so the toolbar of the app and of shared pages
// (components/format-menus.tsx) and the tests read the same answer.
import type { EditorState } from "@tiptap/pm/state";

// What TextAlign is configured with (components/editor.tsx, lib/document-schema.ts):
// its default alignments on paragraphs and headings.
export const ALIGNMENTS = ["left", "center", "right", "justify"] as const;
export type Alignment = (typeof ALIGNMENTS)[number];
// TipTap's own keys; "align left" gave its ⌘⇧L to the block link (#88).
export const ALIGN_SHORTCUTS: Record<Alignment, string | undefined> = {
  left: undefined,
  center: "Mod+Shift+E",
  right: "Mod+Shift+R",
  justify: "Mod+Shift+J",
};
const ALIGNABLE = ["paragraph", "heading"];

// The alignment of the text block at the caret ("left" when none is set),
// or null where text cannot be aligned (code, a selected image).
export function alignmentAt(state: EditorState): Alignment | null {
  const block = state.selection.$from.parent;
  if (!ALIGNABLE.includes(block.type.name)) return null;
  const value = block.attrs.textAlign as string | null | undefined;
  return (ALIGNMENTS as readonly string[]).includes(value || "") ? (value as Alignment) : "left";
}

// The block styles of the menu: text and the heading levels the editor
// offers everywhere else ("/" menu, "Turn into").
export const HEADING_LEVELS = [1, 2, 3, 4] as const;
export type BlockStyle = "paragraph" | (typeof HEADING_LEVELS)[number];
export const BLOCK_STYLES: BlockStyle[] = ["paragraph", ...HEADING_LEVELS];
// StarterKit's keys (Mod+Alt+0 text, Mod+Alt+1… headings).
export const blockStyleShortcut = (style: BlockStyle) => `Mod+Alt+${style === "paragraph" ? 0 : style}`;

// The style of the text block at the caret; null for any other block
// (code, a selected image), where the button shows no level.
export function blockStyleAt(state: EditorState): BlockStyle | null {
  const block = state.selection.$from.parent;
  if (block.type.name === "paragraph") return "paragraph";
  if (block.type.name !== "heading") return null;
  const level = Number(block.attrs.level);
  return (HEADING_LEVELS as readonly number[]).includes(level) ? (level as BlockStyle) : null;
}

// The short name on the button: "Text", "H1" … "H4".
export const blockStyleShort = (style: BlockStyle | null) => (style === null || style === "paragraph" ? "Text" : `H${style}`);
