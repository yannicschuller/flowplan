// The columns block: two or three columns side by side, each holding any
// blocks except another columns block. Stored, published, printed and
// exported as
//
//   <div data-columns="true" class="editor-columns" data-block-id="…">
//     <div data-column="true" class="editor-column" data-width="40">…blocks…</div>
//     <div data-column="true" class="editor-column" data-width="60">…blocks…</div>
//   </div>
//
// data-width is a column's share of the row in percent (20–80, whole
// numbers), written only once someone resized the columns; without it the
// columns share the row equally. The stylesheet (app/columns-block.css)
// turns it into the column's flex weight, so every view of the HTML shows
// the same widths without script and without style attributes. Columns
// stack when each would get less than about 320 px (phones, narrow panes).
// Widths are per column, so a column added or removed by someone else at
// the same time keeps the others' widths (Yjs merges attributes per node).
//
// In the editor a node view (lib/columns-view.ts) adds the handles in the
// gaps that resize the columns; a plugin keeps the layout valid after local
// changes (tidyColumns): no columns inside columns, at least two columns
// and a paragraph in every column.
import { Extension, Node, mergeAttributes, getAttributesFromExtensions, getRenderedAttributes, getChangedRanges } from "@tiptap/core";
import { Plugin, PluginKey, Selection, TextSelection, type Command, type EditorState, type Transaction } from "@tiptap/pm/state";
import { type Node as PMNode } from "@tiptap/pm/model";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import { columnNodeView, columnsNodeView } from "./columns-view";

export const MIN_COLUMN_WIDTH = 20;
export const MAX_COLUMN_WIDTH = 80;
// Every value data-width may have ("20" … "80"), for the sanitizer.
export const COLUMN_WIDTH_VALUES = Array.from({ length: MAX_COLUMN_WIDTH - MIN_COLUMN_WIDTH + 1 }, (_, i) => String(MIN_COLUMN_WIDTH + i));
export const NESTED_COLUMNS = "Spalten lassen sich nicht verschachteln.";

// A stored width: a whole percentage within the limits, or null (equal share).
export function columnWidth(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n >= MIN_COLUMN_WIDTH && n <= MAX_COLUMN_WIDTH ? n : null;
}

// What each column of a layout gets of the row, in percent (summing to
// 100): its width as a weight, columns without one an equal share – as the
// stylesheet lays them out.
export function columnShares(layout: PMNode): number[] {
  const n = layout.childCount;
  const weights: number[] = [];
  layout.forEach((column) => weights.push(columnWidth(column.attrs.width) ?? 100 / n));
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  return weights.map((w) => (w * 100) / sum);
}

// Shares as whole numbers that sum to 100 (largest remainder).
function wholeShares(shares: number[]) {
  const sum = shares.reduce((a, b) => a + b, 0) || 1;
  const exact = shares.map((s) => (s * 100) / sum);
  const whole = exact.map(Math.floor);
  let rest = 100 - whole.reduce((a, b) => a + b, 0);
  const order = exact.map((e, i) => [e - Math.floor(e), i] as const).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) {
    if (rest-- <= 0) break;
    whole[i]++;
  }
  return whole;
}

// The widths after moving the gap right of column `index` so that this
// column gets `wanted` percent of the row: only the two columns next to the
// gap change, each staying within the limits. Whole numbers summing to 100.
export function resizedWidths(shares: number[], index: number, wanted: number): number[] {
  const widths = wholeShares(shares).map((w) => Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, w)));
  if (index < 0 || index >= widths.length - 1) return widths;
  const pair = widths[index] + widths[index + 1];
  const low = Math.max(MIN_COLUMN_WIDTH, pair - MAX_COLUMN_WIDTH),
    high = Math.min(MAX_COLUMN_WIDTH, pair - MIN_COLUMN_WIDTH);
  if (low > high) return widths;
  const left = Math.min(high, Math.max(low, Math.round(wanted)));
  widths[index] = left;
  widths[index + 1] = pair - left;
  return widths;
}

// Sets the widths of the layout at `pos` (null: equal widths again).
export function setColumnWidths(tr: Transaction, pos: number, widths: (number | null)[] | null) {
  const layout = tr.doc.nodeAt(pos);
  if (!layout || layout.type.name !== "columns") return tr;
  layout.forEach((column, offset, index) => {
    const width = widths ? columnWidth(widths[index]) : null;
    if (column.attrs.width !== width) tr.setNodeMarkup(pos + 1 + offset, undefined, { ...column.attrs, width });
  });
  return tr;
}

// Whether `pos` lies inside a column.
export function insideColumn(doc: PMNode, pos: number) {
  const $pos = doc.resolve(pos);
  for (let depth = $pos.depth; depth > 0; depth--) if ($pos.node(depth).type.name === "column") return true;
  return false;
}
export function containsColumns(node: PMNode) {
  let found = node.type.name === "columns";
  if (!found) node.descendants((child) => !(found ||= child.type.name === "columns"));
  return found;
}
// Whether a document has a columns block inside another one.
export function hasNestedColumns(doc: PMNode) {
  let nested = false;
  doc.descendants((node, pos) => {
    if (nested) return false;
    if (node.type.name === "columns" && insideColumn(doc, pos)) nested = true;
    return !nested;
  });
  return nested;
}

// Keeps the layouts in the ranges (all of the document without) valid,
// innermost first: a columns block inside a column becomes its blocks one
// after another; a layout left with fewer than two columns becomes the
// remaining column's blocks; a column without a paragraph gets an empty one
// at its end (so there is always a line to write in, also below a PDF).
export function tidyColumns(state: EditorState, ranges?: { from: number; to: number }[]): Transaction | null {
  const { doc, schema } = state;
  const { columns, column, paragraph } = schema.nodes;
  if (!columns || !column || !paragraph) return null;
  const found = new Set<number>();
  const visit = (from: number, to: number) =>
    doc.nodesBetween(from, to, (node, pos) => {
      if (node.type === columns) found.add(pos);
      return !node.isTextblock && !node.isAtom;
    });
  if (!ranges) visit(0, doc.content.size);
  else
    for (const range of ranges) {
      const from = Math.max(0, Math.min(range.from, doc.content.size)),
        to = Math.max(from, Math.min(range.to, doc.content.size));
      const $from = doc.resolve(from),
        $to = doc.resolve(to);
      // The whole top-level blocks around the change.
      visit($from.depth ? $from.before(1) : from, $to.depth ? $to.after(1) : to);
    }
  if (!found.size) return null;
  const tr = state.tr;
  for (const pos of [...found].sort((a, b) => b - a)) {
    const layout = tr.doc.nodeAt(pos);
    if (!layout || layout.type !== columns) continue;
    if (insideColumn(tr.doc, pos) || layout.childCount < 2) {
      const blocks: PMNode[] = [];
      layout.forEach((child) => (child.type === column ? child.forEach((block) => blocks.push(block)) : blocks.push(child)));
      tr.replaceWith(pos, pos + layout.nodeSize, blocks.length ? blocks : paragraph.create());
      continue;
    }
    // From the last column, so the positions before stay.
    const ends: number[] = [];
    layout.forEach((child, offset) => {
      if (child.type !== column) return;
      let text = false;
      child.forEach((block) => (text ||= block.type === paragraph));
      if (!text) ends.push(pos + 1 + offset + child.nodeSize - 1);
    });
    for (const end of ends.reverse()) tr.insert(end, paragraph.create());
  }
  return tr.docChanged ? tr : null;
}

export const columnsTidyKey = new PluginKey("columnsTidy");
// tidyColumns after this person's own changes: not after other people's
// (Yjs) – both editors would fix the same layout and Yjs would keep both
// fixes; their editors fix their own changes.
export function columnsTidyPlugin() {
  return new Plugin({
    key: columnsTidyKey,
    appendTransaction(transactions, _old, state) {
      const own = transactions.filter((t) => {
        if (!t.docChanged || t.getMeta(columnsTidyKey)) return false;
        const sync = t.getMeta(ySyncPluginKey) as { isChangeOrigin?: boolean } | undefined;
        return !sync?.isChangeOrigin;
      });
      if (!own.length) return null;
      // The changed ranges, mapped to the document now.
      const ranges: { from: number; to: number }[] = [];
      transactions.forEach((t, i) => {
        const later = transactions.slice(i + 1);
        const map = (pos: number, assoc: number) => later.reduce((p, l) => l.mapping.map(p, assoc), pos);
        if (own.includes(t)) for (const { newRange } of getChangedRanges(t)) ranges.push({ from: map(newRange.from, -1), to: map(newRange.to, 1) });
      });
      const tr = tidyColumns(state, ranges);
      return tr ? tr.setMeta(columnsTidyKey, true) : null;
    },
  });
}

// Backspace or Delete in a column that holds only an empty paragraph
// removes that column: the other columns take its room; with one column
// left the layout dissolves and its blocks flow back into the page.
export const removeEmptyColumn: Command = (state, dispatch) => {
  const { selection } = state;
  if (!(selection instanceof TextSelection) || !selection.empty) return false;
  const { $from } = selection;
  if ($from.depth < 3 || $from.parent.type.name !== "paragraph" || $from.parent.content.size) return false;
  const columnDepth = $from.depth - 1;
  const column = $from.node(columnDepth);
  if (column.type.name !== "column" || column.childCount !== 1) return false;
  const layoutDepth = columnDepth - 1,
    layout = $from.node(layoutDepth),
    layoutPos = $from.before(layoutDepth),
    index = $from.index(layoutDepth);
  if (!dispatch) return true;
  const tr = state.tr;
  if (layout.childCount <= 2) {
    const rest = layout.child(index === 0 ? 1 : 0);
    tr.replaceWith(layoutPos, layoutPos + layout.nodeSize, rest.content);
    const at = index === 0 ? layoutPos : layoutPos + rest.content.size;
    tr.setSelection(Selection.near(tr.doc.resolve(Math.min(at, tr.doc.content.size)), index === 0 ? 1 : -1));
  } else {
    const columnPos = $from.before(columnDepth);
    tr.delete(columnPos, columnPos + column.nodeSize);
    tr.setSelection(Selection.near(tr.doc.resolve(index === 0 ? columnPos + 1 : columnPos - 1), index === 0 ? 1 : -1));
  }
  dispatch(tr.scrollIntoView());
  return true;
};

export const Columns = Node.create({
  name: "columns",
  group: "block",
  content: "column{2,3}",
  defining: true,
  parseHTML: () => [{ tag: "div[data-columns]" }],
  renderHTML: ({ HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-columns": "true", class: "editor-columns" }), 0],
  addNodeView() {
    return (props) => {
      const attributes = getAttributesFromExtensions(props.editor.extensionManager.extensions);
      return columnsNodeView({ ...props, attributesOf: (node) => getRenderedAttributes(node, attributes) });
    };
  },
  addProseMirrorPlugins() {
    return [columnsTidyPlugin()];
  },
});

export const Column = Node.create({
  name: "column",
  content: "block+",
  isolating: true,
  addAttributes: () => ({
    width: {
      default: null,
      parseHTML: (el) => columnWidth(el.getAttribute("data-width")),
      renderHTML: (attributes) => {
        const width = columnWidth(attributes.width);
        return width ? { "data-width": String(width) } : {};
      },
    },
  }),
  parseHTML: () => [{ tag: "div[data-column]" }],
  renderHTML: ({ HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-column": "true", class: "editor-column" }), 0],
  addNodeView() {
    return (props) => {
      const attributes = getAttributesFromExtensions(props.editor.extensionManager.extensions);
      return columnNodeView({ ...props, attributesOf: (node) => getRenderedAttributes(node, attributes) });
    };
  },
});
// Before the other Backspace and Delete handlers (lists, block shortcuts).
export const ColumnKeys = Extension.create({
  name: "columnKeys",
  priority: 1000,
  addKeyboardShortcuts() {
    const remove = () => removeEmptyColumn(this.editor.state, this.editor.view.dispatch);
    return { Backspace: remove, Delete: remove };
  },
});
