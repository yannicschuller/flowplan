import { Fragment, Slice, type Node } from "@tiptap/pm/model";
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
  paragraph: "Absatz",
  heading: "Überschrift",
  bulletList: "Aufzählung",
  orderedList: "Nummerierte Liste",
  taskList: "Aufgabenliste",
  listItem: "Listeneintrag",
  taskItem: "Aufgabe",
  blockquote: "Zitat",
  codeBlock: "Code",
  table: "Tabelle",
  image: "Bild",
  callout: "Hinweis",
  toggle: "Toggle",
  mathBlock: "Formel",
  mermaidBlock: "Diagramm",
  columns: "Spalten",
  media: "Medium",
  linkedDatabase: "Verknüpfte Datenbank",
  horizontalRule: "Trennlinie",
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
  const tr = state.tr.deleteRange(range.from, range.to),
    mapped = tr.mapping.map(target, target < range.from ? -1 : 1),
    $target = tr.doc.resolve(mapped);
  if (
    !$target.parent.canReplace($target.index(), $target.index(), range.content)
  )
    throw new Error("Diese Blocktypen passen nicht an den gewählten Zielort.");
  return finish(tr.insert(mapped, range.content), mapped, range.content);
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
