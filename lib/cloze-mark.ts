// The mark "Lücke" (docs/specs/flashcards.md §5.2, decided: a mark of its
// own, not the spoiler): text of a record's document that a flashcard asks
// for. Stored as <span data-cloze="N"> (and data-cloze-hint="…"); the
// same number twice is one card with two gaps (lib/study-cloze.ts).
// Outside studying it reads like a spoiler – covered until clicked
// (components/link-preview.tsx revealSpoiler) – and while writing it is
// tinted with its number (app/globals.css). Markdown writes it as
// {{cN::…}} and reads that back (lib/markdown.ts, lib/markdown-html.ts).
//
// ⌘⌥G / Ctrl+Alt+G makes the selection a gap with a new number, with Shift
// one with the number of the gap before it (several gaps on one card);
// on a gap it removes the mark. Not ⌘⇧C / Ctrl+Shift+C as in Anki: the
// browsers keep it for their developer tools.
import { Mark, mergeAttributes } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { EditorState } from "@tiptap/pm/state";

export const CLOZE_MAX = 99;
const numberOf = (value: unknown) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= CLOZE_MAX ? n : 1;
};
// The highest number of a document's gaps (0: none).
export function highestCloze(doc: PMNode) {
  let max = 0;
  doc.descendants((node) => {
    for (const mark of node.marks) if (mark.type.name === "cloze") max = Math.max(max, numberOf(mark.attrs.n));
  });
  return max;
}
// The number of the last gap before a position, else the highest, else 1.
export function clozeBefore(doc: PMNode, pos: number) {
  let found = 0;
  doc.nodesBetween(0, Math.max(0, Math.min(pos, doc.content.size)), (node, at) => {
    if (at >= pos) return false;
    for (const mark of node.marks) if (mark.type.name === "cloze") found = numberOf(mark.attrs.n);
  });
  return found || highestCloze(doc) || 1;
}
export function clozeNumberFor(state: EditorState, same: boolean) {
  return same ? clozeBefore(state.doc, state.selection.from) : Math.min(CLOZE_MAX, highestCloze(state.doc) + 1);
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    cloze: {
      // A gap over the selection: a new number, or (same) the one before.
      setCloze: (options?: { same?: boolean; n?: number; hint?: string }) => ReturnType;
      unsetCloze: () => ReturnType;
      toggleCloze: (options?: { same?: boolean }) => ReturnType;
    };
  }
}

export const Cloze = Mark.create({
  name: "cloze",
  inclusive: false,
  excludes: "spoiler",
  addAttributes() {
    return {
      n: {
        default: 1,
        parseHTML: (element) => numberOf(element.getAttribute("data-cloze")),
        renderHTML: (attributes) => ({ "data-cloze": String(numberOf(attributes.n)) }),
      },
      hint: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-cloze-hint")?.slice(0, 200) || null,
        renderHTML: (attributes) => (attributes.hint ? { "data-cloze-hint": String(attributes.hint).slice(0, 200) } : {}),
      },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-cloze]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes), 0];
  },
  addCommands() {
    return {
      setCloze:
        (options = {}) =>
        ({ state, commands }) =>
          commands.setMark(this.name, { n: options.n ?? clozeNumberFor(state, !!options.same), hint: options.hint || null }),
      unsetCloze:
        () =>
        ({ commands }) =>
          commands.unsetMark(this.name, { extendEmptyMarkRange: true }),
      toggleCloze:
        (options = {}) =>
        ({ editor, commands }) =>
          editor.isActive(this.name) ? commands.unsetCloze() : commands.setCloze(options),
    };
  },
  addKeyboardShortcuts() {
    return {
      "Mod-Alt-g": () => this.editor.commands.toggleCloze(),
      "Mod-Alt-Shift-g": () => this.editor.commands.toggleCloze({ same: true }),
    };
  },
});
