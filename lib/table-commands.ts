// The rows and columns of a table in a document (#240,
// components/table-controls.tsx): select, insert, duplicate, clear, delete
// and move a whole row or column, colour cells, and the header row and
// column. ProseMirror commands on a table found by its position – one undo
// step each – shared by the handles' menus, the keyboard and the tests.
//
// Header cells stay where the header is: a table with a header row keeps
// its first row as the header when rows move or are duplicated (and the
// same for a header column), as in Notion where the header is the table's
// setting, not the row's.
import { Extension } from "@tiptap/core";
import type { Node as PMNode, NodeType } from "@tiptap/pm/model";
import { TextSelection, type Command, type EditorState, type Transaction } from "@tiptap/pm/state";
import { CellSelection, TableMap, addColumn, addRow, columnIsHeader, removeColumn, removeRow, rowIsHeader, type Rect, type TableRect } from "@tiptap/pm/tables";
import { blockColor } from "./block-colors";

export type TableLine = "row" | "column";
export type TableAt = { pos: number; start: number; node: PMNode; map: TableMap };

// The table at a position (the table node's own position).
export function tableAt(doc: PMNode, pos: number): TableAt | null {
  const node = pos >= 0 && pos < doc.content.size ? doc.nodeAt(pos) : null;
  if (node?.type.spec.tableRole !== "table") return null;
  return { pos, start: pos + 1, node, map: TableMap.get(node) };
}

// The table around a position in the document, if any.
export function tableAround(doc: PMNode, pos: number): TableAt | null {
  const $pos = doc.resolve(Math.min(Math.max(pos, 0), doc.content.size));
  for (let depth = $pos.depth; depth > 0; depth--)
    if ($pos.node(depth).type.spec.tableRole === "table") return tableAt(doc, $pos.before(depth));
  return null;
}

// The rectangle of a whole row or column.
export function lineRect(table: TableAt, kind: TableLine, index: number): Rect {
  return kind === "row"
    ? { left: 0, right: table.map.width, top: index, bottom: index + 1 }
    : { left: index, right: index + 1, top: 0, bottom: table.map.height };
}
const tableRect = (table: TableAt, rect: Rect): TableRect => ({ ...rect, tableStart: table.start, map: table.map, table: table.node });
const count = (table: TableAt, kind: TableLine) => (kind === "row" ? table.map.height : table.map.width);

// The cells of a rectangle, each once, with their positions in the document.
function cells(table: TableAt, rect: Rect) {
  return table.map.cellsInRect(rect).map((offset) => ({ pos: table.start + offset, node: table.node.nodeAt(offset)! }));
}
// Whether the table has merged cells across rows (rowspan) or columns (colspan).
function merged(table: TableAt, attr: "rowspan" | "colspan") {
  let found = false;
  table.node.descendants((node) => {
    if (found) return false;
    if (node.type.spec.tableRole === "cell" || node.type.spec.tableRole === "header_cell") {
      if ((Number(node.attrs[attr]) || 1) > 1) found = true;
      return false;
    }
    return true;
  });
  return found;
}

// Whether the table has a header row or a header column.
export function tableHeaders(table: TableAt) {
  return {
    row: table.map.height > 0 && rowIsHeader(table.map, table.node, 0),
    column: table.map.width > 0 && columnIsHeader(table.map, table.node, 0),
  };
}

// Header cells only in the header row and column (after moving and
// duplicating): the first row while the table has a header row, the first
// column while it has a header column.
function keepHeaders(tr: Transaction, tablePos: number, headers: { row: boolean; column: boolean }) {
  const table = tableAt(tr.doc, tablePos);
  if (!table) return;
  const types = tableTypes(table.node);
  for (const offset of table.map.cellsInRect({ left: 0, top: 0, right: table.map.width, bottom: table.map.height })) {
    const cell = table.node.nodeAt(offset)!;
    const rect = table.map.findCell(offset);
    const type = (headers.row && rect.top === 0) || (headers.column && rect.left === 0) ? types.header : types.cell;
    if (cell.type !== type) tr.setNodeMarkup(table.start + offset, type, cell.attrs, cell.marks);
  }
}
function tableTypes(table: PMNode): { cell: NodeType; header: NodeType } {
  const { nodes } = table.type.schema;
  const of = (role: string) => Object.values(nodes).find((type) => type.spec.tableRole === role)!;
  return { cell: of("cell"), header: of("header_cell") };
}

// A cell selection over a whole row or column (for its menu and the
// keyboard), from its first to its last cell.
export function lineSelection(doc: PMNode, table: TableAt, kind: TableLine, from: number, to = from) {
  const { map, start } = table;
  const anchor = kind === "row" ? map.map[from * map.width] : map.map[from];
  const head = kind === "row" ? map.map[to * map.width + map.width - 1] : map.map[(map.height - 1) * map.width + to];
  const $anchor = doc.resolve(start + anchor),
    $head = doc.resolve(start + head);
  return kind === "row" ? CellSelection.rowSelection($anchor, $head) : CellSelection.colSelection($anchor, $head);
}
export const selectLine =
  (tablePos: number, kind: TableLine, index: number): Command =>
  (state, dispatch) => {
    const table = tableAt(state.doc, tablePos);
    if (!table || index < 0 || index >= count(table, kind)) return false;
    dispatch?.(state.tr.setSelection(lineSelection(state.doc, table, kind, index)));
    return true;
  };

// The whole rows or columns the selection covers, if it is such a selection.
export function selectedLines(state: EditorState): { tablePos: number; kind: TableLine; from: number; to: number } | null {
  const selection = state.selection;
  if (!(selection instanceof CellSelection)) return null;
  const table = tableAround(state.doc, selection.$anchorCell.pos);
  if (!table) return null;
  const rect = table.map.rectBetween(selection.$anchorCell.pos - table.start, selection.$headCell.pos - table.start);
  let rows = selection.isRowSelection(),
    columns = selection.isColSelection();
  // The whole table: a row only in a table of one row, a column in one of one column.
  if (rows && columns) {
    rows = table.map.height === 1;
    columns = !rows && table.map.width === 1;
  }
  if (rows) return { tablePos: table.pos, kind: "row", from: rect.top, to: rect.bottom - 1 };
  if (columns) return { tablePos: table.pos, kind: "column", from: rect.left, to: rect.right - 1 };
  return null;
}

// A row above or below, a column left or right of `index` (side "after":
// below or right). The new line takes the colour of none of its
// neighbours; the header stays the header.
export const insertLine =
  (tablePos: number, kind: TableLine, index: number, side: "before" | "after"): Command =>
  (state, dispatch) => {
    const table = tableAt(state.doc, tablePos);
    if (!table || index < 0 || index >= count(table, kind)) return false;
    if (!dispatch) return true;
    const headers = tableHeaders(table);
    const tr = state.tr;
    const at = side === "after" ? index + 1 : index;
    if (kind === "row") addRow(tr, tableRect(table, lineRect(table, kind, index)), at);
    else addColumn(tr, tableRect(table, lineRect(table, kind, index)), at);
    keepHeaders(tr, tablePos, headers);
    const after = tableAt(tr.doc, tablePos);
    if (after) tr.setSelection(TextSelection.near(tr.doc.resolve(after.start + after.map.positionAt(kind === "row" ? at : 0, kind === "row" ? 0 : at, after.node) + 1)));
    dispatch(tr.scrollIntoView());
    return true;
  };

// A row at the end or a column at the right end (the "+" bars).
export const appendLine =
  (tablePos: number, kind: TableLine): Command =>
  (state, dispatch) => {
    const table = tableAt(state.doc, tablePos);
    if (!table) return false;
    return insertLine(tablePos, kind, count(table, kind) - 1, "after")(state, dispatch);
  };

// Deletes a row or column; the last one is not deleted (the table would be
// left without cells – deleting the table is the block's own action).
export const deleteLine =
  (tablePos: number, kind: TableLine, from: number, to = from): Command =>
  (state, dispatch) => {
    const table = tableAt(state.doc, tablePos);
    if (!table || from < 0 || to >= count(table, kind) || to < from) return false;
    if (to - from + 1 >= count(table, kind)) return false;
    if (!dispatch) return true;
    const tr = state.tr;
    for (let index = to; index >= from; index--) {
      const current = tableAt(tr.doc, tablePos)!;
      if (kind === "row") removeRow(tr, tableRect(current, lineRect(current, kind, index)), index);
      else removeColumn(tr, tableRect(current, lineRect(current, kind, index)), index);
    }
    const after = tableAt(tr.doc, tablePos);
    if (after) {
      const near = Math.min(from, count(after, kind) - 1);
      tr.setSelection(TextSelection.near(tr.doc.resolve(after.start + after.map.positionAt(kind === "row" ? near : 0, kind === "row" ? 0 : near, after.node) + 1)));
    }
    dispatch(tr.scrollIntoView());
    return true;
  };

// A copy of a row below it, of a column to its right (⌘D). Not across
// merged cells that reach into a neighbouring row or column.
export const duplicateLine =
  (tablePos: number, kind: TableLine, index: number): Command =>
  (state, dispatch) => {
    const table = tableAt(state.doc, tablePos);
    if (!table || index < 0 || index >= count(table, kind)) return false;
    const { map } = table;
    const own = cells(table, lineRect(table, kind, index));
    for (const cell of own) {
      const rect = map.findCell(cell.pos - table.start);
      if (kind === "row" ? rect.top !== index || rect.bottom !== index + 1 : rect.left !== index || rect.right !== index + 1) return false;
    }
    if (!dispatch) return true;
    const headers = tableHeaders(table);
    const tr = state.tr;
    if (kind === "row") {
      let at = table.start;
      for (let i = 0; i <= index; i++) at += table.node.child(i).nodeSize;
      tr.insert(at, table.node.child(index).copy(table.node.child(index).content));
    } else {
      // Bottom up: a copy changes the positions only of what follows it.
      for (const cell of [...own].sort((a, b) => b.pos - a.pos)) tr.insert(cell.pos + cell.node.nodeSize, cell.node.copy(cell.node.content));
    }
    keepHeaders(tr, tablePos, headers);
    const after = tableAt(tr.doc, tablePos);
    if (after) tr.setSelection(lineSelection(tr.doc, after, kind, index + 1));
    dispatch(tr.scrollIntoView());
    return true;
  };

// Moves a row or column from one place to another (dragging its handle,
// ⌘⇧↑/↓). `to` is the index it has afterwards. The moved line stays
// selected. Rows move as a whole node; not where cells are merged across
// rows (rows) or at all (columns).
export const moveLine =
  (tablePos: number, kind: TableLine, from: number, to: number): Command =>
  (state, dispatch) => {
    const table = tableAt(state.doc, tablePos);
    const total = table ? count(table, kind) : 0;
    if (!table || from < 0 || to < 0 || from >= total || to >= total || from === to) return false;
    if (merged(table, "rowspan") || (kind === "column" && merged(table, "colspan"))) return false;
    if (!dispatch) return true;
    const headers = tableHeaders(table);
    const tr = state.tr;
    if (kind === "row") {
      const rowPos = (node: PMNode, index: number) => {
        let at = table.start;
        for (let i = 0; i < index; i++) at += node.child(i).nodeSize;
        return at;
      };
      const row = table.node.child(from);
      const start = rowPos(table.node, from);
      tr.delete(start, start + row.nodeSize);
      tr.insert(rowPos(tr.doc.nodeAt(tablePos)!, to), row);
    } else {
      // Every row: its cell out of the old place, into the new one.
      for (let r = table.node.childCount - 1; r >= 0; r--) {
        let rowStart = table.start;
        for (let i = 0; i < r; i++) rowStart += tr.doc.nodeAt(tablePos)!.child(i).nodeSize;
        const row = tr.doc.nodeAt(rowStart)!;
        const cellAt = (index: number) => {
          let at = rowStart + 1;
          for (let i = 0; i < index; i++) at += row.child(i).nodeSize;
          return at;
        };
        const cell = row.child(from);
        const start = cellAt(from);
        tr.delete(start, start + cell.nodeSize);
        const rowAfter = tr.doc.nodeAt(rowStart)!;
        let at = rowStart + 1;
        for (let i = 0; i < to; i++) at += rowAfter.child(i).nodeSize;
        tr.insert(at, cell);
      }
    }
    keepHeaders(tr, tablePos, headers);
    const after = tableAt(tr.doc, tablePos);
    if (after) tr.setSelection(lineSelection(tr.doc, after, kind, to));
    dispatch(tr.scrollIntoView());
    return true;
  };

// Empties the cells of a rectangle (their colour and size stay).
export const clearCells =
  (tablePos: number, rect: Rect): Command =>
  (state, dispatch) => {
    const table = tableAt(state.doc, tablePos);
    if (!table) return false;
    if (!dispatch) return true;
    const tr = state.tr;
    for (const cell of cells(table, rect).sort((a, b) => b.pos - a.pos)) {
      const empty = cell.node.type.createAndFill(cell.node.attrs, null, cell.node.marks);
      if (!empty) continue;
      tr.replaceWith(cell.pos + 1, cell.pos + cell.node.nodeSize - 1, empty.content);
    }
    const selection = state.selection;
    if (selection instanceof CellSelection) tr.setSelection(selection.map(tr.doc, tr.mapping));
    dispatch(tr);
    return true;
  };

// The colour of cells (#240): a name as for blocks ("red",
// "red-background", lib/block-colors.ts), null for the default.
export const setCellColor =
  (tablePos: number, rect: Rect, value: string | null): Command =>
  (state, dispatch) => {
    const table = tableAt(state.doc, tablePos);
    const color = value === null ? null : blockColor(value);
    if (!table || (value !== null && !color)) return false;
    const list = cells(table, rect).filter((cell) => (cell.node.attrs.blockColor ?? null) !== color);
    if (!list.length) return false;
    if (!dispatch) return true;
    const tr = state.tr;
    for (const cell of list) tr.setNodeAttribute(cell.pos, "blockColor", color);
    dispatch(tr);
    return true;
  };
// The colour all cells of a rectangle share: a name, null (none) or
// undefined (they differ).
export function cellColor(state: EditorState, tablePos: number, rect: Rect): string | null | undefined {
  const table = tableAt(state.doc, tablePos);
  if (!table) return undefined;
  const values = new Set(cells(table, rect).map((cell) => blockColor(cell.node.attrs.blockColor)));
  return values.size === 1 ? [...values][0] : undefined;
}

// The header row or column on or off.
export const toggleHeaderLine =
  (tablePos: number, kind: TableLine): Command =>
  (state, dispatch) => {
    const table = tableAt(state.doc, tablePos);
    if (!table) return false;
    if (!dispatch) return true;
    const headers = tableHeaders(table);
    const next = kind === "row" ? { ...headers, row: !headers.row } : { ...headers, column: !headers.column };
    const tr = state.tr;
    keepHeaders(tr, tablePos, next);
    dispatch(tr);
    return true;
  };

// ⌘⇧↑/↓ move the selected rows, ⌘⇧←/→ the selected columns, ⌘D
// duplicates the selected row or column – before the block shortcuts
// (lib/block-shortcuts.ts), only while whole rows or columns are selected.
export const TableShortcuts = Extension.create({
  name: "tableShortcuts",
  priority: 120,
  addKeyboardShortcuts() {
    const move = (kind: TableLine, direction: -1 | 1) => () => {
      const lines = selectedLines(this.editor.state);
      if (!lines || lines.kind !== kind || lines.from !== lines.to || !this.editor.isEditable) return false;
      // Selected but not movable (the end, merged cells): nothing else
      // happens either.
      moveLine(lines.tablePos, kind, lines.from, lines.from + direction)(this.editor.state, this.editor.view.dispatch);
      return true;
    };
    return {
      "Mod-Shift-ArrowUp": move("row", -1),
      "Mod-Shift-ArrowDown": move("row", 1),
      "Mod-Shift-ArrowLeft": move("column", -1),
      "Mod-Shift-ArrowRight": move("column", 1),
      "Mod-d": () => {
        const lines = selectedLines(this.editor.state);
        if (!lines || lines.from !== lines.to || !this.editor.isEditable) return false;
        duplicateLine(lines.tablePos, lines.kind, lines.from)(this.editor.state, this.editor.view.dispatch);
        return true;
      },
    };
  },
});
