// "Umwandeln in" of the block menu beyond what the editor's own commands do
// (#238): toggle headings, a toggle back into another block (#244), a
// block equation, columns, and block colours. Plain ProseMirror
// transactions – one undo step each – shared by the block menu and tests.
// The toggle helpers of #230 (lib/toggle-commands.ts) stay as they are.
import { Fragment, type Node as PMNode } from "@tiptap/pm/model";
import { Selection, TextSelection, type Transaction } from "@tiptap/pm/state";
import { newBlockId, validBlockId } from "./block-ids";
import { titleText, turnIntoToggle } from "./toggle-commands";
import { toggleHeading } from "./document-schema";
import { BLOCK_COLOR_TYPES, blockColor } from "./block-colors";
import { MAX_COLUMNS } from "./document-blocks";

const LIST_ITEMS = ["listItem", "taskItem"];

// The blocks a toggle's title can become.
export type TitleBlock =
  | { type: "paragraph" }
  | { type: "heading"; level: number }
  | { type: "bulletList" | "orderedList" | "taskList" }
  | { type: "blockquote" }
  | { type: "callout" }
  | { type: "codeBlock" }
  | { type: "mathBlock" };

function canReplace(trn: Transaction, from: number, to: number, content: Fragment) {
  const $from = trn.doc.resolve(from);
  return $from.parent.canReplace($from.index(), trn.doc.resolve(to).index(), content);
}

// A block of the given kind holding a line of text (its block id: the one
// given, so links to the block keep working).
function textBlock(trn: Transaction, kind: TitleBlock, text: string, blockId?: unknown): PMNode {
  const { schema } = trn.doc.type;
  const inline = text ? schema.text(text) : null;
  const id = validBlockId(blockId) || null;
  const paragraph = (attrs?: Record<string, unknown>) => schema.nodes.paragraph.create(attrs ?? null, inline);
  switch (kind.type) {
    case "heading":
      return schema.nodes.heading.create({ level: kind.level, blockId: id }, inline);
    case "bulletList":
    case "orderedList":
      return schema.nodes[kind.type].create({ blockId: id }, schema.nodes.listItem.create(null, paragraph()));
    case "taskList":
      return schema.nodes.taskList.create({ blockId: id }, schema.nodes.taskItem.create({ checked: false }, paragraph()));
    case "blockquote":
      return schema.nodes.blockquote.create({ blockId: id }, paragraph());
    case "callout":
      return schema.nodes.callout.create({ type: "note", blockId: id }, paragraph());
    case "codeBlock":
      return schema.nodes.codeBlock.create({ blockId: id }, inline);
    case "mathBlock":
      return schema.nodes.mathBlock.create({ ...(text ? { expression: text } : {}), blockId: id });
    default:
      return paragraph({ blockId: id });
  }
}

// A toggle becomes another block (#244): its title becomes that block's
// text, its content follows right after on the same level (an empty
// paragraph alone is dropped). The caret goes to the end of the title.
export function toggleToBlock(trn: Transaction, pos: number, kind: TitleBlock): boolean {
  const node = trn.doc.nodeAt(pos);
  if (node?.type.name !== "toggle") return false;
  const title = String(node.attrs.title ?? "").replace(/\s+/g, " ").trim();
  const head = textBlock(trn, kind, title, node.attrs.blockId);
  const only = node.childCount === 1 ? node.firstChild : null;
  const rest = only?.type.name === "paragraph" && !only.content.size ? Fragment.empty : node.content;
  const fragment = Fragment.from(head).append(rest);
  if (!canReplace(trn, pos, pos + node.nodeSize, fragment)) return false;
  trn.replaceWith(pos, pos + node.nodeSize, fragment);
  // The end of the title's text.
  let end = pos + head.nodeSize - 1;
  head.descendants((child, offset) => {
    if (child.isTextblock) end = pos + 1 + offset + child.nodeSize - 1;
  });
  if (head.isTextblock) end = pos + head.nodeSize - 1;
  const $end = trn.doc.resolve(Math.min(end, trn.doc.content.size));
  trn.setSelection($end.parent.inlineContent ? TextSelection.create(trn.doc, $end.pos) : Selection.near($end, -1));
  return true;
}

// A paragraph, heading or list item becomes a toggle, a toggle heading
// when `heading` is a level (1–4); a toggle changes its heading level.
// A heading's text becomes the title.
export function blockToToggle(trn: Transaction, pos: number, heading: number | null): boolean {
  const node = trn.doc.nodeAt(pos);
  if (!node) return false;
  const level = toggleHeading(heading);
  if (node.type.name === "toggle") {
    trn.setNodeAttribute(pos, "heading", level);
    return true;
  }
  if (node.type.name === "heading") {
    const { schema } = trn.doc.type;
    const toggle = schema.nodes.toggle.create(
      { title: titleText(node), heading: level, blockId: validBlockId(node.attrs.blockId) || newBlockId() },
      schema.nodes.paragraph.create(),
    );
    const fragment = Fragment.from(toggle);
    if (!canReplace(trn, pos, pos + node.nodeSize, fragment)) return false;
    trn.replaceWith(pos, pos + node.nodeSize, fragment);
    const target = Selection.findFrom(trn.doc.resolve(pos + 1), 1, true);
    if (target) trn.setSelection(target);
    return true;
  }
  if (!turnIntoToggle(trn, pos)) return false;
  if (level) {
    const { $from } = trn.selection;
    for (let d = $from.depth; d > 0; d--)
      if ($from.node(d).type.name === "toggle") {
        trn.setNodeAttribute($from.before(d), "heading", level);
        break;
      }
  }
  return true;
}

// A text block becomes a block equation: its text is the formula.
export function blockToMath(trn: Transaction, pos: number): boolean {
  const node = trn.doc.nodeAt(pos);
  if (!node?.isTextblock) return false;
  const math = textBlock(trn, { type: "mathBlock" }, node.textContent.trim(), node.attrs.blockId);
  const fragment = Fragment.from(math);
  if (!canReplace(trn, pos, pos + node.nodeSize, fragment)) return false;
  trn.replaceWith(pos, pos + node.nodeSize, fragment);
  trn.setSelection(Selection.near(trn.doc.resolve(pos)));
  return true;
}

// Neighbouring blocks (from `from` to `to`, one level) become `count`
// columns side by side: the blocks spread over them in order, a column
// without a block starts with an empty paragraph.
export function blocksToColumns(trn: Transaction, from: number, to: number, count: number): boolean {
  const { schema } = trn.doc.type;
  const { columns, column, paragraph } = schema.nodes;
  if (!columns || !column || count < 2 || count > MAX_COLUMNS) return false;
  const blocks: PMNode[] = [];
  trn.doc.slice(from, to).content.forEach((node) => blocks.push(node));
  if (!blocks.length || blocks.some((b) => b.type === column || LIST_ITEMS.includes(b.type.name))) return false;
  const per = Math.ceil(blocks.length / count);
  const parts: PMNode[] = [];
  for (let i = 0; i < count; i++) {
    const own = blocks.slice(i * per, (i + 1) * per);
    parts.push(column.create(null, own.length ? own : paragraph.create()));
  }
  const fragment = Fragment.from(columns.create(null, parts));
  if (!canReplace(trn, from, to, fragment)) return false;
  // Not inside another column layout.
  const $from = trn.doc.resolve(from);
  for (let d = $from.depth; d > 0; d--) if ($from.node(d).type === column) return false;
  trn.replaceWith(from, to, fragment);
  trn.setSelection(Selection.near(trn.doc.resolve(from + 2)));
  return true;
}

// The colour of blocks (#238): text or background, null for the default.
// A list takes it on its items. Returns whether anything changed.
export function setBlockColors(trn: Transaction, positions: number[], value: string | null): boolean {
  const color = value === null ? null : blockColor(value);
  if (value !== null && !color) return false;
  let changed = false;
  const paint = (pos: number) => {
    const node = trn.doc.nodeAt(pos);
    if (!node) return;
    if (BLOCK_COLOR_TYPES.includes(node.type.name)) {
      if ((node.attrs.blockColor ?? null) !== color) {
        trn.setNodeAttribute(pos, "blockColor", color);
        changed = true;
      }
      return;
    }
    if (["bulletList", "orderedList", "taskList"].includes(node.type.name))
      node.forEach((_item, offset) => paint(pos + 1 + offset));
  };
  for (const pos of positions) paint(pos);
  return changed;
}

// Whether blocks can take a colour (a list through its items).
export const colorable = (node: PMNode) =>
  BLOCK_COLOR_TYPES.includes(node.type.name) || ["bulletList", "orderedList", "taskList"].includes(node.type.name);
