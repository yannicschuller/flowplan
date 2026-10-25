import { Node } from "@tiptap/core";
// A handwriting block in a document ("/draw"): an ink canvas over the full
// width with lined, blank or grid paper. The node holds only its id, height
// and paper; the ink lives in page_ink under (page, id) with its own
// versions and merging (lib/page-ink-store.ts), so concurrent strokes of
// collaborators are merged by stroke id instead of one Yjs attribute
// replacing the other. components/ink/draw-block.tsx draws and edits it.
//
// Coordinates: the block is DRAW_BLOCK_WIDTH points wide whatever the
// screen; `height` is in the same points (the block scales as a whole).
export const DRAW_BLOCK_WIDTH = 720;
export const DRAW_BLOCK_HEIGHTS = { min: 120, max: 2400, default: 300 };
export const DRAW_BLOCK_PAPERS = ["blank", "lined", "grid"] as const;
export type DrawBlockPaper = (typeof DRAW_BLOCK_PAPERS)[number];

export const drawBlockHeight = (value: unknown) => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(DRAW_BLOCK_HEIGHTS.max, Math.max(DRAW_BLOCK_HEIGHTS.min, n)) : DRAW_BLOCK_HEIGHTS.default;
};
export const drawBlockPaper = (value: unknown): DrawBlockPaper => (DRAW_BLOCK_PAPERS.includes(value as DrawBlockPaper) ? (value as DrawBlockPaper) : "blank");
const BLOCK_ID = /^[\w-]{1,40}$/;
export const drawBlockId = (value: unknown) => (typeof value === "string" && BLOCK_ID.test(value) ? value : "");
// "pageId/blockId" of the block a pasted copy came from.
const FROM = /^[0-9a-f-]{36}\/[\w-]{1,40}$/i;
export const drawBlockFrom = (value: unknown) => (typeof value === "string" && FROM.test(value) ? value : "");
export const newDrawBlockId = () => `ink-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

export const DrawBlock = Node.create({
  name: "drawBlock",
  group: "block",
  atom: true,
  // Not dragged natively: a pen or mouse moving on it draws (the block
  // handles move it like any block).
  draggable: false,
  addAttributes() {
    return {
      id: { default: "" },
      height: { default: DRAW_BLOCK_HEIGHTS.default },
      paper: { default: "blank" },
      // The page whose ink this block has (where it was drawn).
      page: { default: "" },
      // A copy from another block that has no ink of its own yet.
      from: { default: "" },
    };
  },
  parseHTML: () => [
    {
      tag: "div[data-ink-block]",
      getAttrs: (element) => {
        const el = element as HTMLElement;
        return {
          id: drawBlockId(el.getAttribute("data-ink-block")),
          height: drawBlockHeight(el.getAttribute("data-ink-height")),
          paper: drawBlockPaper(el.getAttribute("data-ink-paper")),
          page: /^[0-9a-f-]{36}$/i.test(el.getAttribute("data-ink-page") || "") ? el.getAttribute("data-ink-page") : "",
          from: drawBlockFrom(el.getAttribute("data-ink-from")),
        };
      },
    },
  ],
  renderHTML: ({ node }) => [
    "div",
    {
      "data-ink-block": drawBlockId(node.attrs.id),
      "data-ink-height": String(drawBlockHeight(node.attrs.height)),
      "data-ink-paper": drawBlockPaper(node.attrs.paper),
      ...(node.attrs.page ? { "data-ink-page": String(node.attrs.page) } : {}),
      ...(drawBlockFrom(node.attrs.from) ? { "data-ink-from": drawBlockFrom(node.attrs.from) } : {}),
      class: "ink-block-placeholder",
    },
    "Handschrift",
  ],
});
