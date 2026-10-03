import { tr } from "./locale-tag";
import { Fragment, Slice, type Node, type NodeType } from "@tiptap/pm/model";
import {
  NodeSelection,
  Selection,
  type EditorState,
  type Transaction,
} from "@tiptap/pm/state";
import { freshLinkedIds } from "./linked-paste";
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
  columns: tr("Spalten", "Columns"),
  media: tr("Medium", "Media"),
  linkedDatabase: tr("Verknüpfte Datenbank", "Linked database"),
  horizontalRule: tr("Trennlinie", "Divider"),
};
export function documentBlocks(doc: Node): DocumentBlock[] {
  const blocks: DocumentBlock[] = [];
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
      if (node.type.name !== "column" && !firstListParagraph) {
        const text = String(
          node.textContent ||
            node.attrs.title ||
            node.attrs.expression ||
            (node.type.name === "mermaidBlock" ? node.attrs.source : "") ||
            node.attrs.alt ||
            "",
        )
          .replace(/\s+/g, " ")
          .slice(0, 65);
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
function finish(tr: Transaction, start: number, content?: Fragment) {
  tr.doc.check();
  const positions: number[] = [];
  if (content)
    content.forEach((node, offset) => {
      positions.push(start + offset);
    });
  const pos = Math.min(start, tr.doc.content.size);
  tr.setSelection(
    content && NodeSelection.isSelectable(content.firstChild!)
      ? NodeSelection.create(tr.doc, pos)
      : Selection.near(tr.doc.resolve(pos)),
  );
  return tr.setMeta(BLOCK_SELECTION_META, positions).scrollIntoView();
}
export function changeBlocks(
  state: EditorState,
  positions: number[],
  action: "duplicate" | "delete" | "move",
  target?: number,
) {
  const range = blockRange(state.doc, positions);
  if (action === "duplicate") {
    const content = freshLinkedIds(new Slice(range.content, 0, 0)).content;
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
  if (
    !documentBlocks(state.doc).some((b) => b.pos === target || b.end === target)
  )
    throw new Error("Das Ziel muss vor oder nach einem Block liegen.");
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
  const content = fitBlocks($target.parent, $target.index(), range.content, origin);
  if (!content)
    throw new Error("Diese Blocktypen passen nicht an den gewählten Zielort.");
  tr.insert(mapped, content);
  const wrapped =
    origin && content.childCount === 1 && content.firstChild!.type === origin.type
      ? content.firstChild!
      : null;
  if (!wrapped)
    return finish(tr, mapped, content).setMeta(BLOCK_MOVE_META, {
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
  const fits = (f: Fragment) => parent.canReplace(index, index, f);
  if (fits(content)) return content;
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
      if (fits(list)) return list;
    } catch {}
  const unwrapped = nodes.flatMap((n) =>
    LIST_ITEMS.includes(n.type.name) ? (n.content.content as Node[]) : [n],
  );
  try {
    const converted = Fragment.fromArray(
      itemType
        ? nodes.map((n) =>
            LIST_ITEMS.includes(n.type.name)
              ? itemType.createChecked(
                  itemType.name === "taskItem"
                    ? { checked: !!n.attrs.checked }
                    : null,
                  n.content,
                )
              : wrapIn(itemType, n),
          )
        : unwrapped,
    );
    if (converted.size && fits(converted)) return converted;
  } catch {}
  return undefined;
}
function wrapIn(itemType: NodeType, node: Node) {
  // Items start with a paragraph; other blocks are nested below an empty one.
  if (itemType.contentMatch.matchType(node.type))
    return itemType.createChecked(null, node);
  return itemType.createChecked(null, [
    itemType.schema.nodes.paragraph.create(),
    node,
  ]);
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
