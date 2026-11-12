import { Node, canInsertNode, isNodeSelection, mergeAttributes } from "@tiptap/core";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";

// The page break block (#216): an empty block, selected and deleted like a
// divider. On screen a dashed line with "Seitenumbruch" (app/print-options.css,
// the label in the reader's language); in print, the combined PDF, Word,
// e-books and Markdown the next content starts on a new page. Stored as
// <div data-page-break class="page-break"></div>.
declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    pageBreak: {
      setPageBreak: () => ReturnType;
    };
  }
}

export const PAGE_BREAK_HTML = '<div data-page-break="" class="page-break"></div>';
// A style with break-before/after (page-break-before/after) that forces a
// new page: how Word, Google Docs and Markdown tools write a page break.
export const isPageBreakStyle = (style: string | null | undefined) =>
  !!style && /(?:^|;)\s*(?:page-)?break-(?:after|before)\s*:\s*(?:always|page|left|right)\b/i.test(style);

export const PageBreak = Node.create({
  name: "pageBreak",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,
  // Also an empty <div> or Word's <br> with a page break style, pasted
  // into the editor.
  parseHTML: () => [
    { tag: "div[data-page-break]" },
    { tag: "div[style]", priority: 40, getAttrs: (el) => (isPageBreakStyle((el as HTMLElement).getAttribute("style")) && !(el as HTMLElement).textContent?.trim() ? null : false) },
    { tag: "br[style]", priority: 60, getAttrs: (el) => (isPageBreakStyle((el as HTMLElement).getAttribute("style")) ? null : false) },
  ],
  // Block ids and reactions (global attributes) come along.
  renderHTML: ({ HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-page-break": "", class: "page-break" })],
  renderText: () => "\n",
  // Inserted like the divider: the caret goes to the block after it, a new
  // paragraph at the end of the document.
  addCommands() {
    return {
      setPageBreak:
        () =>
        ({ chain, state }) => {
          if (!canInsertNode(state, state.schema.nodes[this.name])) return false;
          const { selection } = state;
          const current = chain();
          if (isNodeSelection(selection)) current.insertContentAt(selection.$to.pos, { type: this.name });
          else current.insertContent({ type: this.name });
          return current
            .command(({ tr, dispatch }) => {
              if (!dispatch) return true;
              const { $to } = tr.selection;
              if ($to.nodeAfter) {
                if ($to.nodeAfter.isTextblock) tr.setSelection(TextSelection.create(tr.doc, $to.pos + 1));
                else if ($to.nodeAfter.isBlock) tr.setSelection(NodeSelection.create(tr.doc, $to.pos));
                else tr.setSelection(TextSelection.create(tr.doc, $to.pos));
              } else {
                const paragraph = state.schema.nodes.paragraph?.create();
                if (paragraph) {
                  const after = $to.end();
                  tr.insert(after, paragraph);
                  tr.setSelection(TextSelection.create(tr.doc, after + 1));
                }
              }
              tr.scrollIntoView();
              return true;
            })
            .run();
        },
    };
  },
});
