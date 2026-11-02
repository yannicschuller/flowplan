// Stable block ids and block links (#88). Every block a link can point to
// carries an id of its own (data-block-id): it travels with the block
// through edits, moves, cut and paste, Yjs and the stored HTML. Duplicates
// and copies pasted into the same document get new ids
// (lib/block-ids-plugin.ts assigns them in the editor). A block link is the
// page address plus the block: /#page=<page>&block=<id> (a record's
// document: /#page=<database>&row=<record>&block=<id>). Ids only need to
// be unique within their document. Shared by server and browser.
import { Extension } from "@tiptap/core";
import { Fragment, Slice, type Node } from "@tiptap/pm/model";

// Generated ids are 8 lowercase letters and digits; imported ones (Obsidian
// "^id", AFFiNE block ids …) keep this simple alphabet too.
export const BLOCK_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const validBlockId = (value: unknown): string | null =>
  typeof value === "string" && BLOCK_ID.test(value) ? value : null;

// The blocks that get an id (the first paragraph of a list item is the
// item's text: the item has the id).
export const BLOCK_ID_TYPES = [
  "paragraph",
  "heading",
  "blockquote",
  "codeBlock",
  "bulletList",
  "orderedList",
  "taskList",
  "listItem",
  "taskItem",
  "table",
  "image",
  "callout",
  "toggle",
  "mathBlock",
  "mermaidBlock",
  "functionPlot",
  "metricBlock",
  "pluginBlock",
  "horizontalRule",
  "media",
  "linkCard",
  "linkedDatabase",
  "whiteboardEmbed",
  "drawBlock",
  "syncedBlock",
  "columns",
  "bibliography",
];
const ITEMS = ["listItem", "taskItem"];

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
export function newBlockId() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

// Schema part (server and editor): the attribute on every linkable block.
// A block split in two (Enter) leaves the id with the first part.
export const BlockIdAttribute = Extension.create({
  name: "blockIdAttribute",
  addGlobalAttributes() {
    return [
      {
        types: BLOCK_ID_TYPES,
        attributes: {
          blockId: {
            default: null,
            keepOnSplit: false,
            parseHTML: (element) => validBlockId(element.getAttribute("data-block-id")),
            renderHTML: (attributes) =>
              validBlockId(attributes.blockId) ? { "data-block-id": attributes.blockId } : {},
          },
        },
      },
    ];
  },
});

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

// The linkable block at a position (the innermost one containing it).
export function linkableBlockAt(doc: Node, pos: number): LinkableBlock | null {
  let best: LinkableBlock | null = null;
  for (const block of linkableBlocks(doc))
    if (block.pos <= pos && pos <= block.pos + block.node.nodeSize) best = block;
  return best;
}

// The start of a block's text for link texts and previews.
export function blockText(node: Node, max = 60): string {
  const raw = String(
    node.textContent ||
      node.attrs.title ||
      node.attrs.alt ||
      node.attrs.caption ||
      node.attrs.expression ||
      node.attrs.source ||
      "",
  )
    .replace(/\s+/g, " ")
    .trim();
  const chars = [...raw];
  return chars.length > max ? chars.slice(0, max - 1).join("").trimEnd() + "…" : raw;
}

// "Page › start of the block", the text of a pasted block link.
export const BLOCK_LINK_SEPARATOR = " › ";
export function blockLinkLabel(pageTitle: string, text: string) {
  const title = pageTitle.replace(/\s+/g, " ").trim();
  return text ? `${title}${BLOCK_LINK_SEPARATOR}${text}` : title;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type BlockTarget = { pageId: string; rowId?: string; blockId: string };
// The link (relative, as the editor stores it).
export function blockLinkHref(target: BlockTarget) {
  const params = new URLSearchParams({ page: target.pageId });
  if (target.rowId) params.set("row", target.rowId);
  params.set("block", target.blockId);
  return `/#${params}`;
}
// A block link as stored ("/#page=…&block=…", "#page=…") or as copied (a
// full address of this Flowplan, `origin`). Null for anything else.
export function parseBlockLink(raw: string, origin?: string): BlockTarget | null {
  const value = raw.trim();
  if (!value || value.length > 1000) return null;
  let hash: string;
  if (value.startsWith("#")) hash = value;
  else if (value.startsWith("/#")) hash = value.slice(1);
  else {
    if (!origin) return null;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return null;
    }
    if (url.origin !== new URL(origin).origin || (url.pathname !== "/" && url.pathname !== "")) return null;
    hash = url.hash;
  }
  const params = new URLSearchParams(hash.replace(/^#/, "").replaceAll("&amp;", "&"));
  if ([...params.keys()].some((key) => !["page", "row", "block"].includes(key))) return null;
  if (["page", "row", "block"].some((key) => params.getAll(key).length > 1)) return null;
  const pageId = params.get("page") || "",
    rowId = params.get("row"),
    blockId = params.get("block") || "";
  if (!UUID.test(pageId) || !validBlockId(blockId) || (rowId !== null && !UUID.test(rowId))) return null;
  return rowId ? { pageId, rowId, blockId } : { pageId, blockId };
}

function mapSlice(slice: Slice, map: (node: Node) => Node) {
  const visit = (node: Node): Node => {
    const next = map(node);
    if (!next.childCount) return next;
    const children: Node[] = [];
    next.forEach((child) => children.push(visit(child)));
    return next.copy(Fragment.fromArray(children));
  };
  const top: Node[] = [];
  slice.content.forEach((node) => top.push(visit(node)));
  return new Slice(Fragment.fromArray(top), slice.openStart, slice.openEnd);
}
const withoutId = (node: Node) =>
  node.attrs.blockId ? node.type.create({ ...node.attrs, blockId: null }, node.content, node.marks) : node;

// Duplicated blocks start without ids (the editor gives them new ones).
export function withoutBlockIds(slice: Slice) {
  return mapSlice(slice, withoutId);
}
// Pasted content: blocks whose id the document already has are copies and
// lose it; cut-and-pasted or moved blocks keep theirs.
export function withoutTakenBlockIds(slice: Slice, doc: Node) {
  const taken = new Set(linkableBlocks(doc).map((b) => b.node.attrs.blockId).filter(Boolean));
  if (!taken.size) return slice;
  return mapSlice(slice, (node) => (node.attrs.blockId && taken.has(node.attrs.blockId) ? withoutId(node) : node));
}
