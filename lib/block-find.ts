// Blocks by their id in a document (#88, lib/block-ids.ts): no editor
// needed, so a jump (lib/jump.ts) finds a block without loading TipTap.
// Shared by server and browser.
import type { Node } from "@tiptap/pm/model";

// Generated ids are 8 lowercase letters and digits; imported ones (Obsidian
// "^id", AFFiNE block ids …) keep this simple alphabet too.
export const BLOCK_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const validBlockId = (value: unknown): string | null =>
  typeof value === "string" && BLOCK_ID.test(value) ? value : null;

// The first paragraph of a list item is the item's text: the item has the id.
const ITEMS = ["listItem", "taskItem"];

export type LinkableBlock = { node: Node; pos: number; parent: Node | null };
const hasIdAttribute = (node: Node) => "blockId" in node.attrs;
// The blocks a link can point to, in document order: inside callouts,
// quotes, toggles, columns and lists, not inside tables or atoms.
export function linkableBlocks(doc: Node): LinkableBlock[] {
  const found: LinkableBlock[] = [];
  const visit = (parent: Node, start: number) =>
    parent.forEach((node, offset, index) => {
      const pos = start + offset;
      if (!node.isBlock) return;
      const itemText = index === 0 && node.type.name === "paragraph" && ITEMS.includes(parent.type.name);
      if (hasIdAttribute(node) && !itemText) found.push({ node, pos, parent: parent === doc ? null : parent });
      if (!node.isAtom && node.type.name !== "table") visit(node, pos + 1);
    });
  visit(doc, 0);
  return found;
}

export function findBlock(doc: Node, blockId: string): LinkableBlock | null {
  if (!validBlockId(blockId)) return null;
  return linkableBlocks(doc).find((b) => b.node.attrs.blockId === blockId) || null;
}
