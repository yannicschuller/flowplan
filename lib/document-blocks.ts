import { tr } from "./locale-tag";
import { Fragment, Slice, type Node, type NodeType } from "@tiptap/pm/model";
import {
  NodeSelection,
  Selection,
  type EditorState,
  type Transaction,
} from "@tiptap/pm/state";
import { freshLinkedIds } from "./linked-paste";
import { withoutBlockIds } from "./block-ids";
export type DocumentBlock = {
  pos: number;
  end: number;
  depth: number;
  parentPos: number;
  index: number;
  node: Node;
  label: string;
};
const names: Record<string, string> = {
  paragraph: tr("Absatz", "Paragraph"),
  heading: tr("Überschrift", "Heading"),
  bulletList: tr("Aufzählung", "Bulleted list"),
  orderedList: tr("Nummerierte Liste", "Numbered list"),
  taskList: tr("Aufgabenliste", "Task list"),
  listItem: tr("Listeneintrag", "List item"),
  taskItem: tr("Aufgabe", "Task"),
  blockquote: tr("Zitat", "Quote"),
  codeBlock: tr("Code", "Code"),
  table: tr("Tabelle", "Table"),
  image: tr("Bild", "Image"),
  callout: tr("Hinweis", "Callout"),
  toggle: tr("Toggle", "Toggle"),
  mathBlock: tr("Formel", "Formula"),
  mermaidBlock: tr("Diagramm", "Diagram"),
  drawioBlock: tr("draw.io-Diagramm", "draw.io diagram"),
  columns: tr("Spalten", "Columns"),
  media: tr("Medium", "Media"),
  linkedDatabase: tr("Verknüpfte Datenbank", "Linked database"),
  horizontalRule: tr("Trennlinie", "Divider"),
  pageBreak: tr("Seitenumbruch", "Page break"),
  meeting: tr("Besprechung", "Meeting"),
};
// Containers without a handle of their own: a column belongs to its
// layout, the parts of a meeting (#252) to the meeting – their blocks keep
// their handles.
const WITHOUT_HANDLE = ["column", "meetingSummary", "meetingAgenda", "meetingTranscript"];
// The kind of a block in words ("Aufgabenliste"), for the heading of its
// menu (#253): a list item by its list, as the list is what one turns into.
export function blockTypeName(node: Node, parent?: Node | null) {
  const name = ["listItem", "taskItem"].includes(node.type.name) && parent ? parent.type.name : node.type.name;
  return names[name] || names[node.type.name] || name;
}
export function documentBlocks(doc: Node): DocumentBlock[] {
  const blocks: DocumentBlock[] = [];
  // Diagrams are named after the heading above them, not their source.
  let heading = "";
  function visit(
    parent: Node,
    start: number,
    parentPos: number,
    depth: number,
  ) {
    parent.forEach((node, offset, index) => {
      const pos = start + offset;
      if (!node.isBlock) return;
      const firstListParagraph =
        index === 0 &&
        node.type.name === "paragraph" &&
        ["listItem", "taskItem"].includes(parent.type.name);
      if (!WITHOUT_HANDLE.includes(node.type.name) && !firstListParagraph) {
        // A toggle by its title (its content may be closed), a meeting too.
        const text = String(
          (["toggle", "meeting"].includes(node.type.name) && node.attrs.title) ||
            node.textContent ||
            node.attrs.title ||
            node.attrs.expression ||
            (["mermaidBlock", "drawioBlock"].includes(node.type.name) && heading
              ? tr(`unter „${heading}“`, `below “${heading}”`)
              : "") ||
            node.attrs.alt ||
            "",
        )
          .replace(/\s+/g, " ")
          .slice(0, 65);
        if (node.type.name === "heading")
          heading = node.textContent.replace(/\s+/g, " ").trim().slice(0, 40);
        blocks.push({
          pos,
          end: pos + node.nodeSize,
          depth,
          parentPos,
          index,
          node,
          label: `${names[node.type.name] || node.type.name}${text ? " · " + text : ""}`,
        });
      }
      if (!node.isAtom && node.type.name !== "table")
        visit(node, pos + 1, pos, depth + 1);
    });
  }
  visit(doc, 0, -1, 0);
  return blocks;
}
export function selectedDocumentBlock(state: EditorState) {
  const blocks = documentBlocks(state.doc);
  if (state.selection instanceof NodeSelection)
    return blocks.find((b) => b.pos === state.selection.from);
  return blocks
    .filter((b) => b.pos < state.selection.from && b.end >= state.selection.to)
    .at(-1);
}
export function blockRange(doc: Node, positions: number[]) {
  const blocks = documentBlocks(doc),
    unique = [...new Set(positions)].sort((a, b) => a - b);
  const selected = unique.map((pos) => blocks.find((b) => b.pos === pos));
  if (!selected.length || selected.some((b) => !b))
    throw new Error("Bitte gültige Blöcke auswählen.");
  const found = selected as DocumentBlock[];
  if (
    found.some(
      (b, i) =>
        b.parentPos !== found[0].parentPos ||
        (i > 0 && b.pos !== found[i - 1].end),
    )
  )
    throw new Error("Bitte benachbarte Blöcke derselben Ebene auswählen.");
  return {
    blocks: found,
    from: found[0].pos,
    to: found.at(-1)!.end,
    content: Fragment.fromArray(found.map((b) => b.node)),
  };
}
export function hasLinkedBlocks(node: Node) {
  let linked = node.type.name === "linkedDatabase";
  node.descendants((n) => {
    if (n.type.name === "linkedDatabase") linked = true;
  });
  return linked;
}
export const BLOCK_SELECTION_META = "flowplanBlockSelection";
// Where moved blocks came from, for the slide animation.
export const BLOCK_MOVE_META = "flowplanBlockMove";
function finish(tr: Transaction, start: number, content?: Fragment, lead?: { pos: number; content: Fragment }) {
  tr.doc.check();
  const positions: number[] = [];
  // Blocks that went to the end of the item before (see placeFitted).
  lead?.content.forEach((node, offset) => {
    positions.push(lead.pos + offset);
  });
  if (content)
    content.forEach((node, offset) => {
      positions.push(start + offset);
    });
  if (lead?.content.size) {
    content = lead.content;
    start = lead.pos;
  }
  const pos = Math.min(start, tr.doc.content.size);
  tr.setSelection(
    content && NodeSelection.isSelectable(content.firstChild!)
      ? NodeSelection.create(tr.doc, pos)
      : Selection.near(tr.doc.resolve(pos)),
  );
  return tr.setMeta(BLOCK_SELECTION_META, positions).scrollIntoView();
}
// A place between blocks: before or after a block, or between the
// children of a block that holds blocks (the end of a list item or a
// toggle's content: a drop as its child, #239) – never inside text.
export function blockBoundary(doc: Node, target: number) {
  if (documentBlocks(doc).some((b) => b.pos === target || b.end === target)) return true;
  const $target = doc.resolve(target);
  return $target.depth > 0 && !$target.parent.inlineContent && $target.textOffset === 0;
}
export function changeBlocks(
  state: EditorState,
  positions: number[],
  action: "duplicate" | "delete" | "move" | "copy",
  target?: number,
) {
  const range = blockRange(state.doc, positions);
  if (action === "duplicate") {
    // Copies get block ids of their own (#88).
    const content = withoutBlockIds(freshLinkedIds(new Slice(range.content, 0, 0))).content;
    const $pos = state.doc.resolve(range.to);
    if (!$pos.parent.canReplace($pos.index(), $pos.index(), content))
      throw new Error("Diese Blöcke können hier nicht dupliziert werden.");
    return finish(state.tr.insert(range.to, content), range.to, content);
  }
  if (action === "delete")
    return finish(state.tr.deleteRange(range.from, range.to), range.from);
  if (
    typeof target !== "number" ||
    target < 0 ||
    target > state.doc.content.size
  )
    throw new Error("Bitte eine gültige Zielposition auswählen.");
  if (target >= range.from && target <= range.to)
    throw new Error("Der Zielort liegt innerhalb der Auswahl.");
  // Boundaries, not arbitrary text offsets, are valid destinations.
  if (!blockBoundary(state.doc, target))
    throw new Error("Das Ziel muss vor oder nach einem Block liegen.");
  // A copy at the target (⌥ while dropping, #239): the blocks stay, the
  // copy gets block ids of its own and adapts to where it lands.
  if (action === "copy") {
    const copy = withoutBlockIds(freshLinkedIds(new Slice(range.content, 0, 0))).content;
    const $at = state.doc.resolve(target);
    const $first = state.doc.resolve(range.from);
    const kind = range.blocks.every((b) => LIST_ITEMS.includes(b.node.type.name)) ? $first.parent : null;
    const tr = state.tr;
    const placed = placeFitted(tr, target, fitInto($at.parent, $at.index(), copy, kind ? kind.type.create(kind.attrs) : null));
    if (!placed) throw new Error("Diese Blocktypen passen nicht an den gewählten Zielort.");
    return finish(tr, placed.start, placed.content, placed.lead);
  }
  // List items moved out of their list keep it: the list they came from
  // (kind, attributes; a numbered item its number).
  const $from = state.doc.resolve(range.from);
  const source = range.blocks.every((b) => LIST_ITEMS.includes(b.node.type.name))
    ? $from.parent
    : null;
  const origin = source
    ? source.type.create(
        source.type.name === "orderedList"
          ? { ...source.attrs, start: (Number(source.attrs.start) || 1) + $from.index() }
          : source.attrs,
      )
    : null;
  const tr = state.tr.deleteRange(range.from, range.to),
    mapped = tr.mapping.map(target, target < range.from ? -1 : 1),
    $target = tr.doc.resolve(mapped);
  const placed = placeFitted(tr, mapped, fitInto($target.parent, $target.index(), range.content, origin));
  if (!placed)
    throw new Error("Diese Blocktypen passen nicht an den gewählten Zielort.");
  const content = placed.content;
  const wrapped =
    !placed.lead && origin && content.childCount === 1 && content.firstChild!.type === origin.type
      ? content.firstChild!
      : null;
  if (!wrapped)
    return finish(tr, placed.start, content, placed.lead).setMeta(BLOCK_MOVE_META, {
      from: range.from,
      to: range.to,
    });
  // Next to a list of the same kind it joins that list (numbering goes on).
  const after = tr.doc.resolve(mapped + wrapped.nodeSize).nodeAfter;
  if (after?.type === wrapped.type) tr.join(mapped + wrapped.nodeSize);
  const before = tr.doc.resolve(mapped).nodeBefore;
  const joined = before?.type === wrapped.type;
  if (joined) tr.join(mapped);
  // The moved items: inside the new list, or where the joined list ended.
  const itemsStart = joined ? mapped - 1 : mapped + 1;
  return finish(tr, itemsStart, wrapped.content).setMeta(BLOCK_MOVE_META, {
    from: range.from,
    to: range.to,
  });
}
const LIST_ITEMS = ["listItem", "taskItem"];
const LISTS = ["bulletList", "orderedList", "taskList"];
type Fitted = { content: Fragment; lead?: Fragment };
// Inserts what fitInto gave at `pos`: blocks that lead it go to the end of
// the item before (children of that item, never an empty item of their
// own). Undefined when they have no item to go to.
function placeFitted(tr: Transaction, pos: number, fitted: Fitted | undefined) {
  if (!fitted) return undefined;
  const { content, lead } = fitted;
  if (!lead?.size) {
    tr.insert(pos, content);
    return { start: pos, content };
  }
  const $pos = tr.doc.resolve(pos);
  const before = $pos.nodeBefore;
  if (!before || !LIST_ITEMS.includes(before.type.name) || !before.type.validContent(before.content.append(lead)))
    return undefined;
  if (content.size) tr.insert(pos, content);
  tr.insert(pos - 1, lead);
  return { start: pos + lead.size, content, lead: { pos: pos - 1, content: lead } };
}
// Moved blocks adapt to where they land, like in a word processor: a
// paragraph dropped into a task list becomes a task, items switch between
// list kinds, and items dropped outside any list stay items of a list of
// their former kind (`origin`); only where that cannot go they become text.
export function fitBlocks(
  parent: Node,
  index: number,
  content: Fragment,
  origin?: Node | null,
) {
  const fitted = fitInto(parent, index, content, origin);
  return fitted && !fitted.lead?.size ? fitted.content : undefined;
}
// Into a list (#254): items stay items at the level of the drop, the items
// of a moved list become items there too, paragraphs become items, and
// other blocks (a table, a heading …) become children of the item before
// them – of the list's item before the drop when they come first (`lead`).
function fitInto(
  parent: Node,
  index: number,
  content: Fragment,
  origin?: Node | null,
): Fitted | undefined {
  const fits = (f: Fragment) => parent.canReplace(index, index, f);
  if (fits(content)) return { content };
  const nodes: Node[] = [];
  content.forEach((n) => nodes.push(n));
  // Items to another list kind, or out of the list.
  const itemType = LIST_ITEMS.map((name) => parent.type.schema.nodes[name])
    .filter(Boolean)
    .find((type) => parent.type.contentMatch.matchType(type));
  // Out of the list: in a list of the kind they came from.
  if (!itemType && origin && nodes.every((n) => LIST_ITEMS.includes(n.type.name)))
    try {
      const list = Fragment.from(origin.type.createChecked(origin.attrs, nodes));
      if (fits(list)) return { content: list };
    } catch {}
  try {
    if (itemType) {
      const { items, lead } = asItems(itemType, nodes);
      const converted = Fragment.fromArray(items);
      if ((converted.size || lead.length) && fits(converted))
        return { content: converted, lead: lead.length ? Fragment.fromArray(lead) : undefined };
      return undefined;
    }
    const unwrapped = Fragment.fromArray(
      nodes.flatMap((n) => (LIST_ITEMS.includes(n.type.name) ? (n.content.content as Node[]) : [n])),
    );
    if (unwrapped.size && fits(unwrapped)) return { content: unwrapped };
  } catch {}
  return undefined;
}
function asItems(itemType: NodeType, nodes: Node[]) {
  const items: Node[] = [],
    lead: Node[] = [];
  const item = (n: Node) =>
    n.type === itemType
      ? n
      : itemType.createChecked(itemType.name === "taskItem" ? { checked: !!n.attrs.checked } : null, n.content);
  for (const n of nodes) {
    if (LISTS.includes(n.type.name)) n.forEach((child) => items.push(item(child)));
    else if (LIST_ITEMS.includes(n.type.name)) items.push(item(n));
    // Items start with a paragraph.
    else if (itemType.contentMatch.matchType(n.type)) items.push(itemType.createChecked(null, n));
    else if (items.length) {
      const last = items.pop()!;
      items.push(last.type.createChecked(last.attrs, last.content.addToEnd(n), last.marks));
    } else lead.push(n);
  }
  return { items, lead };
}
export function adjacentBlockTarget(
  state: EditorState,
  positions: number[],
  direction: -1 | 1,
) {
  const range = blockRange(state.doc, positions);
  const siblings = documentBlocks(state.doc).filter(
    (b) => b.parentPos === range.blocks[0].parentPos,
  );
  const neighbor =
    direction < 0
      ? siblings.find((b) => b.end === range.from)
      : siblings.find((b) => b.pos === range.to);
  return neighbor ? (direction < 0 ? neighbor.pos : neighbor.end) : undefined;
}
export const MAX_COLUMNS = 3;
// Dropping blocks at the side of another block places them next to it:
// the target is wrapped into two columns, or the blocks become a new column
// of an existing column layout (at most three).
export function columnBlocks(
  state: EditorState,
  positions: number[],
  targetPos: number,
  side: "left" | "right",
) {
  const range = blockRange(state.doc, positions);
  const blocks = documentBlocks(state.doc),
    target = blocks.find((b) => b.pos === targetPos);
  if (!target) throw new Error("Bitte einen Zielblock wählen.");
  if (target.pos < range.to && target.end > range.from)
    throw new Error("Der Zielort liegt innerhalb der Auswahl.");
  const { columns, column } = state.schema.nodes;
  if (!columns || !column) throw new Error("Spalten sind nicht verfügbar.");
  const $target = state.doc.resolve(target.pos);
  const inColumn = $target.parent.type === column;
  // The column layout that receives the blocks, if there is one.
  const layout =
    target.node.type === columns
      ? { pos: target.pos, node: target.node }
      : inColumn
        ? {
            pos: $target.before($target.depth - 1),
            node: $target.node($target.depth - 1),
          }
        : null;
  // Moving a column's only blocks removes that column.
  const $source = state.doc.resolve(range.from);
  const wholeColumn =
    $source.parent.type === column &&
    range.from === $source.start() &&
    range.to === $source.end();
  // A whole column moved within its own layout just changes the order.
  if (wholeColumn && inColumn) {
    const depth = $source.depth - 1,
      layoutPos = $source.before(depth),
      layoutNode = $source.node(depth);
    if (layoutPos === $target.before($target.depth - 1)) {
      const from = $source.index(depth),
        to = $target.index($target.depth - 1);
      const order: Node[] = [];
      layoutNode.forEach((child) => order.push(child));
      const [moving] = order.splice(from, 1);
      const at =
        order.indexOf(layoutNode.child(to)) + (side === "right" ? 1 : 0);
      order.splice(at, 0, moving);
      const tr = state.tr.replaceWith(
        layoutPos,
        layoutPos + layoutNode.nodeSize,
        layoutNode.copy(Fragment.from(order)),
      );
      let offset = layoutPos + 1;
      for (const child of order.slice(0, at)) offset += child.nodeSize;
      return finish(tr, offset + 1, range.content);
    }
  }
  if (layout && layout.node.childCount >= MAX_COLUMNS)
    throw new Error(`Höchstens ${MAX_COLUMNS} Spalten nebeneinander.`);
  if (
    layout &&
    range.from >= layout.pos &&
    range.to <= layout.pos + layout.node.nodeSize &&
    !inColumn
  )
    throw new Error("Blöcke liegen bereits in diesen Spalten.");
  const tr = state.tr;
  if (wholeColumn) {
    // Rebuild the layout without that column; one column dissolves.
    const depth = $source.depth - 1,
      layoutNode = $source.node(depth),
      layoutPos = $source.before(depth),
      rest: Node[] = [];
    layoutNode.forEach((child, _offset, index) => {
      if (index !== $source.index(depth)) rest.push(child);
    });
    tr.replaceWith(
      layoutPos,
      layoutPos + layoutNode.nodeSize,
      rest.length > 1 ? layoutNode.copy(Fragment.from(rest)) : rest[0].content,
    );
  } else tr.delete(range.from, range.to);
  const created = column.create(null, range.content);
  let start: number;
  if (layout) {
    // Insert a new column next to the target's column (or at the layout edge).
    const anchor =
      target.node.type === columns
        ? side === "left"
          ? layout.pos + 1
          : layout.pos + layout.node.nodeSize - 1
        : side === "left"
          ? $target.before($target.depth)
          : $target.after($target.depth);
    start = tr.mapping.map(anchor, side === "left" ? -1 : 1);
    tr.insert(start, created);
  } else {
    const from = tr.mapping.map(target.pos),
      to = tr.mapping.map(target.end);
    const existing = column.create(null, tr.doc.slice(from, to).content);
    const pair = columns.create(
      null,
      side === "left" ? [created, existing] : [existing, created],
    );
    const $from = tr.doc.resolve(from);
    if (!$from.parent.canReplaceWith($from.index(), $from.index() + 1, columns))
      throw new Error("Hier können keine Spalten entstehen.");
    tr.replaceWith(from, to, pair);
    start = from + 1 + (side === "left" ? 0 : existing.nodeSize);
  }
  // A layout left with a single column dissolves into its blocks.
  let single: { pos: number; size: number; content: Fragment } | undefined;
  tr.doc.descendants((node, pos) => {
    if (single) return false;
    if (node.type === columns && node.childCount === 1)
      single = { pos, size: node.nodeSize, content: node.firstChild!.content };
  });
  if (single) {
    tr.replaceWith(single.pos, single.pos + single.size, single.content);
    start = tr.mapping.slice(tr.mapping.maps.length - 1).map(start);
  }
  try {
    tr.doc.check();
  } catch {
    throw new Error("Die Blöcke passen hier nicht in Spalten.");
  }
  return finish(tr, start + 1, range.content);
}
