"use client";
// The controls of a table in a document (#240), as in Notion – replacing
// the bar under the table (#52) that covered the next block:
//
// - Pointing at a cell shows a handle ⋮⋮ for its row (on the table's left
//   edge) and one for its column (on its top edge). A click selects the
//   row or column (outlined in the accent colour) and opens its menu:
//   search, colour, insert, duplicate (⌘D), clear, delete, header row or
//   column, caption and "Convert to database" (#118). Dragging a handle
//   moves the row or column; a line shows where it lands. With a row
//   selected ⌘⇧↑/↓ move it (lib/table-commands.ts).
// - "+" bars along the bottom and the right edge add a row or a column.
// - A selection of several cells gets a small button at its corner with
//   colour, clear, merge and split.
// On touch screens there is no pointing: the handles and bars belong to the
// cell with the cursor (a tap into a cell), the menu opens as a sheet.
// Everything sits on a layer over the editor's content (positioned from the
// table's cells), never over the block after the table.
import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { Editor } from "@tiptap/react";
import { CellSelection, mergeCells, splitCell } from "@tiptap/pm/tables";
import {
  ArrowsInSimple,
  ArrowsOutSimple,
  ArrowLineDown,
  ArrowLineLeft,
  ArrowLineRight,
  ArrowLineUp,
  Copy,
  Database,
  DotsThree,
  Eraser,
  Palette,
  Plus,
  Rows,
  Columns,
  TextAa,
  Trash,
} from "@phosphor-icons/react";
import { useT } from "./i18n";
import { showToast } from "./toast";
import { BlockMenu, type BlockMenuClose, type BlockMenuItem, type BlockMenuView } from "./block-menu";
import { editCaption } from "./block-captions-view";
import { BLOCK_COLOR_NAMES, blockColorLabels, type BlockColorName } from "@/lib/block-colors";
import {
  appendLine,
  cellColor,
  clearCells,
  deleteLine,
  duplicateLine,
  insertLine,
  lineRect,
  moveLine,
  selectLine,
  setCellColor,
  tableAround,
  tableAt,
  tableHeaders,
  toggleHeaderLine,
  type TableLine,
} from "@/lib/table-commands";
import type { Rect } from "@tiptap/pm/tables";
import type { Command } from "@tiptap/pm/state";

type Target = { tablePos: number; row: number; column: number };
type Box = { left: number; top: number; right: number; bottom: number };
type Menu =
  | { kind: TableLine; tablePos: number; index: number; anchor: DOMRect; handle: HTMLElement | null }
  | { kind: "cells"; tablePos: number; rect: Rect; anchor: DOMRect; handle: HTMLElement | null };
type Drag = { kind: TableLine; tablePos: number; from: number; pointer: number; x: number; y: number; active: boolean; boundary: number | null };

const COARSE = "(pointer: coarse)";
// How far around the table the pointer may go and keep the controls (the
// handles sit on its edges, the bars just outside).
const MARGIN = 26;

// The grid of a table on screen, relative to the layer: its box, the box
// of its scroll area, and the top and bottom of every row, the left and
// right of every column.
function measure(editor: Editor, tablePos: number, origin: DOMRect) {
  const table = tableAt(editor.state.doc, tablePos);
  if (!table) return null;
  const host = editor.view.nodeDOM(tablePos);
  if (!(host instanceof HTMLElement)) return null;
  const element = host.matches("table") ? host : host.querySelector("table");
  if (!element) return null;
  const wrapper = (element.closest(".tableWrapper") as HTMLElement | null) || element;
  const rel = (r: DOMRect): Box => ({ left: r.left - origin.left, top: r.top - origin.top, right: r.right - origin.left, bottom: r.bottom - origin.top });
  const { map } = table;
  const cellBox = (row: number, column: number) => {
    const dom = editor.view.nodeDOM(table.start + map.map[row * map.width + column]);
    return dom instanceof HTMLElement ? rel(dom.getBoundingClientRect()) : null;
  };
  const rows: { top: number; bottom: number }[] = [];
  for (let r = 0; r < map.height; r++) {
    const tr = (element as HTMLTableElement).rows[r];
    const box = tr ? rel(tr.getBoundingClientRect()) : cellBox(r, 0);
    rows.push({ top: box?.top ?? 0, bottom: box?.bottom ?? 0 });
  }
  const columns: { left: number; right: number }[] = [];
  for (let c = 0; c < map.width; c++) {
    // A cell of this column alone (not spanning others) gives its edges.
    let box: Box | null = null;
    for (let r = 0; r < map.height && !box; r++) {
      const rect = map.findCell(map.map[r * map.width + c]);
      if (rect.left === c && rect.right === c + 1) box = cellBox(r, c);
    }
    box ||= cellBox(0, c);
    columns.push({ left: box?.left ?? 0, right: box?.right ?? 0 });
  }
  // Where the scroll area's own horizontal scrollbar starts (#256): with
  // classic scrollbars (Windows, Linux) it takes the bottom of the wrapper,
  // and nothing of the layer may lie over it – a press there must reach
  // the scrollbar. Null without one (overlay scrollbars, no overflow).
  const clip = rel(wrapper.getBoundingClientRect());
  const scrollbar = wrapper !== element && wrapper.offsetHeight - wrapper.clientTop - wrapper.clientHeight > 1 ? clip.top + wrapper.clientTop + wrapper.clientHeight : null;
  return { table, box: rel(element.getBoundingClientRect()), clip, scrollbar, rows, columns };
}

function GripDots({ across }: { across: boolean }) {
  // Two rows of three dots across (column), two columns of three down (row).
  const dots = [];
  for (let a = 0; a < 3; a++) for (let b = 0; b < 2; b++) dots.push(across ? [2 + a * 4.5, 2 + b * 4.5] : [2 + b * 4.5, 2 + a * 4.5]);
  return (
    <svg width={across ? 13 : 8.5} height={across ? 8.5 : 13} viewBox={across ? "0 0 13 8.5" : "0 0 8.5 13"} fill="currentColor" aria-hidden="true">
      {dots.map(([cx, cy]) => (
        <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="1.3" />
      ))}
    </svg>
  );
}

export function TableControls({
  editor,
  convert,
}: {
  editor: Editor;
  // Turns the table into a database (#118); left out where that is not possible.
  convert?: { run: () => void; busy: boolean };
}) {
  const t = useT();
  const layer = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState<Target | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const [coarse, setCoarse] = useState(false);
  useEffect(() => {
    const media = window.matchMedia(COARSE);
    const sync = () => setCoarse(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  // The cell with the cursor (or the selection's corner).
  const selectionCell = (): Target | null => {
    const { selection } = editor.state;
    const pos = selection instanceof CellSelection ? selection.$headCell.pos : selection.from;
    const table = tableAround(editor.state.doc, pos);
    if (!table) return null;
    const $pos = editor.state.doc.resolve(pos);
    for (let depth = $pos.depth; depth > 0; depth--) {
      const role = $pos.node(depth).type.spec.tableRole;
      if (role === "cell" || role === "header_cell") {
        const rect = table.map.findCell($pos.before(depth) - table.start);
        return { tablePos: table.pos, row: rect.top, column: rect.left };
      }
    }
    if (selection instanceof CellSelection) {
      const rect = table.map.findCell(selection.$headCell.pos - table.start);
      return { tablePos: table.pos, row: rect.top, column: rect.left };
    }
    return null;
  };
  // Pointing at a cell (not on touch screens): its row and column.
  useEffect(() => {
    if (coarse) return;
    const view = editor.view;
    const onMove = (event: PointerEvent) => {
      if (event.pointerType === "touch" || dragRef.current || editor.isDestroyed) return;
      const target = event.target as Element | null;
      if (target && layer.current?.contains(target)) return;
      const cell = target?.closest?.("td, th");
      if (cell && view.dom.contains(cell)) {
        let pos: number;
        try {
          pos = view.posAtDOM(cell, 0);
        } catch {
          return;
        }
        const table = tableAround(editor.state.doc, pos);
        if (!table) return;
        const $pos = editor.state.doc.resolve(pos);
        for (let depth = $pos.depth; depth > 0; depth--) {
          const role = $pos.node(depth).type.spec.tableRole;
          if (role !== "cell" && role !== "header_cell") continue;
          const rect = table.map.findCell($pos.before(depth) - table.start);
          setHovered((prev) =>
            prev && prev.tablePos === table.pos && prev.row === rect.top && prev.column === rect.left ? prev : { tablePos: table.pos, row: rect.top, column: rect.left },
          );
          return;
        }
        return;
      }
      // Near the table (on its handles' edges, its bars): it stays.
      setHovered((prev) => {
        if (!prev || !layer.current) return prev;
        const origin = layer.current.getBoundingClientRect();
        const grid = measure(editor, prev.tablePos, origin);
        if (!grid) return null;
        const x = event.clientX - origin.left,
          y = event.clientY - origin.top;
        const near = x >= grid.box.left - MARGIN && x <= grid.box.right + MARGIN && y >= grid.box.top - MARGIN && y <= grid.box.bottom + MARGIN;
        return near ? prev : null;
      });
    };
    document.addEventListener("pointermove", onMove, { passive: true });
    return () => document.removeEventListener("pointermove", onMove);
  }, [editor, coarse]);
  // Moves with scrolling (the page, the table's own scroll area) and the window.
  useEffect(() => {
    let frame = 0;
    const later = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(redraw);
    };
    window.addEventListener("scroll", later, true);
    window.addEventListener("resize", later);
    editor.on("transaction", later);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", later, true);
      window.removeEventListener("resize", later);
      editor.off("transaction", later);
    };
  }, [editor]);
  // Gone with its table.
  useLayoutEffect(() => {
    if (hovered && !tableAt(editor.state.doc, hovered.tablePos)) setHovered(null);
    if (menu && !tableAt(editor.state.doc, menu.tablePos)) setMenu(null);
  });

  // A command on the current state; the editor keeps (or gets back) the focus.
  const run = useCallback(
    (command: Command, focus = true) => {
      if (!editor.isEditable) return false;
      const ok = command(editor.state, editor.view.dispatch, editor.view);
      if (focus) editor.view.focus();
      return ok;
    },
    [editor],
  );

  const focused = editor.isFocused || !!menu;
  const target: Target | null =
    drag ? { tablePos: drag.tablePos, row: drag.kind === "row" ? drag.from : 0, column: drag.kind === "column" ? drag.from : 0 } : menu && menu.kind !== "cells" ? { tablePos: menu.tablePos, row: menu.kind === "row" ? menu.index : 0, column: menu.kind === "column" ? menu.index : 0 } : hovered || (coarse || focused ? selectionCell() : null);
  const origin = layer.current?.getBoundingClientRect();
  const grid = target && origin ? measure(editor, target.tablePos, origin) : null;
  // The selection's outline: whole rows or columns, or a block of cells.
  const selection = editor.state.selection;
  let outline: (Box & { cells?: Rect; tablePos: number }) | null = null;
  if (selection instanceof CellSelection && origin) {
    const table = tableAround(editor.state.doc, selection.$anchorCell.pos);
    const own = table ? (grid?.table.pos === table.pos ? grid : measure(editor, table.pos, origin)) : null;
    if (table && own) {
      const rect = table.map.rectBetween(selection.$anchorCell.pos - table.start, selection.$headCell.pos - table.start);
      const box = {
        left: own.columns[rect.left]?.left ?? 0,
        right: own.columns[rect.right - 1]?.right ?? 0,
        top: own.rows[rect.top]?.top ?? 0,
        bottom: own.rows[rect.bottom - 1]?.bottom ?? 0,
      };
      const line = selection.isRowSelection() || selection.isColSelection();
      outline = { ...box, tablePos: table.pos, cells: line ? undefined : rect };
    }
  }

  const closeMenu = (reason?: BlockMenuClose) => {
    setMenu(null);
    if (reason !== "away") editor.view.focus();
  };
  const openLine = (kind: TableLine, tablePos: number, index: number, handle: HTMLElement) => {
    run(selectLine(tablePos, kind, index), false);
    setMenu({ kind, tablePos, index, anchor: handle.getBoundingClientRect(), handle });
  };

  // Dragging a handle: a press that moves a few pixels drags; one that
  // does not is a click.
  const pressHandle = (event: ReactPointerEvent<HTMLButtonElement>, kind: TableLine, tablePos: number, index: number) => {
    if (event.button !== 0 || !editor.isEditable) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const next: Drag = { kind, tablePos, from: index, pointer: event.pointerId, x: event.clientX, y: event.clientY, active: false, boundary: null };
    dragRef.current = next;
    setDrag(next);
  };
  const moveHandle = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const current = dragRef.current;
    if (!current || current.pointer !== event.pointerId || !layer.current) return;
    const active = current.active || Math.hypot(event.clientX - current.x, event.clientY - current.y) > 4;
    if (!active) return;
    if (!current.active) {
      setMenu(null);
      run(selectLine(current.tablePos, current.kind, current.from), false);
    }
    const origin = layer.current.getBoundingClientRect();
    const own = measure(editor, current.tablePos, origin);
    if (!own) return;
    // The nearest edge between rows (or columns) to the pointer.
    const edges = current.kind === "row" ? [...own.rows.map((r) => r.top), own.rows[own.rows.length - 1]?.bottom ?? 0] : [...own.columns.map((c) => c.left), own.columns[own.columns.length - 1]?.right ?? 0];
    const at = current.kind === "row" ? event.clientY - origin.top : event.clientX - origin.left;
    let boundary = 0;
    edges.forEach((edge, i) => {
      if (Math.abs(edge - at) < Math.abs(edges[boundary] - at)) boundary = i;
    });
    const next = { ...current, active: true, boundary };
    dragRef.current = next;
    setDrag(next);
  };
  const releaseHandle = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const current = dragRef.current;
    if (!current || current.pointer !== event.pointerId) return;
    dragRef.current = null;
    setDrag(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (!current.active) return openLine(current.kind, current.tablePos, current.from, event.currentTarget);
    if (current.boundary === null) return;
    const to = current.boundary > current.from ? current.boundary - 1 : current.boundary;
    if (to === current.from) return;
    if (!run(moveLine(current.tablePos, current.kind, current.from, to)))
      showToast({
        text:
          current.kind === "row"
            ? t("Zeilen mit verbundenen Zellen lassen sich nicht verschieben.", "Rows with merged cells cannot be moved.")
            : t("Spalten mit verbundenen Zellen lassen sich nicht verschieben.", "Columns with merged cells cannot be moved."),
        tone: "error",
      });
  };
  const cancelHandle = () => {
    dragRef.current = null;
    setDrag(null);
  };

  // ---- Menus ----
  const colorItems = (tablePos: number, rect: Rect): BlockMenuItem[] => {
    const labels = blockColorLabels(t);
    const current = cellColor(editor.state, tablePos, rect);
    const entry = (value: string | null, background: boolean): BlockMenuItem => {
      const name = value?.replace("-background", "") as BlockColorName | undefined;
      return {
        icon: (
          <span className={`block-menu-color${background ? " background" : ""}`} data-block-color-swatch={name || "default"} aria-hidden>
            A
          </span>
        ),
        label: name ? labels[name] : t("Standard", "Default"),
        ariaLabel: background ? (name ? t(`${labels[name]} (Hintergrund)`, `${labels[name]} background`) : t("Standardhintergrund", "Default background")) : undefined,
        keywords: `${name || "default"} ${background ? "background hintergrund" : "text colour color farbe"}`,
        checked: current === value,
        run: () => run(setCellColor(tablePos, rect, value), false),
      };
    };
    return [
      { heading: t("Textfarbe", "Text colour") },
      entry(null, false),
      ...BLOCK_COLOR_NAMES.map((name) => entry(name, false)),
      { heading: t("Hintergrund", "Background") },
      entry(null, true),
      ...BLOCK_COLOR_NAMES.map((name) => entry(`${name}-background`, true)),
    ];
  };
  const tableItems = (tablePos: number): BlockMenuItem[] => {
    const items: BlockMenuItem[] = [
      {
        icon: <TextAa />,
        label: t("Beschriftung", "Caption"),
        keywords: "caption beschriftung title titel",
        // After the menu has handed the focus back to the editor.
        run: () => setTimeout(() => !editor.isDestroyed && editCaption(editor.view, tablePos), 0),
      },
    ];
    if (convert)
      items.push({
        icon: <Database />,
        label: t("In Datenbank umwandeln", "Convert to database"),
        keywords: "database datenbank convert umwandeln",
        disabled: convert.busy,
        run: () => convert.run(),
      });
    return items;
  };
  const views = (): Record<string, BlockMenuView> => {
    if (!menu) return {};
    const table = tableAt(editor.state.doc, menu.tablePos);
    if (!table) return {};
    if (menu.kind === "cells") {
      const items: BlockMenuItem[] = [
        { icon: <Palette />, label: t("Farbe", "Colour"), keywords: "colour color farbe background hintergrund", view: "color" },
        "separator",
        { icon: <Eraser />, label: t("Inhalt löschen", "Clear contents"), keywords: "clear empty leeren", run: () => run(clearCells(menu.tablePos, menu.rect)) },
      ];
      if (mergeCells(editor.state)) items.push({ icon: <ArrowsInSimple />, label: t("Zellen verbinden", "Merge cells"), keywords: "merge verbinden", run: () => run(mergeCells) });
      if (splitCell(editor.state)) items.push({ icon: <ArrowsOutSimple />, label: t("Zelle teilen", "Split cell"), keywords: "split teilen", run: () => run(splitCell) });
      return {
        main: { title: t("Zellen", "Cells"), items },
        color: { title: t("Farbe", "Colour"), items: colorItems(menu.tablePos, menu.rect) },
      };
    }
    const { kind, index, tablePos } = menu;
    const rect = lineRect(table, kind, index);
    const row = kind === "row";
    const total = row ? table.map.height : table.map.width;
    const headers = tableHeaders(table);
    const items: BlockMenuItem[] = [
      { icon: <Palette />, label: t("Farbe", "Colour"), keywords: "colour color farbe background hintergrund", view: "color" },
      "separator",
      row
        ? { icon: <ArrowLineUp />, label: t("Zeile darüber einfügen", "Insert row above"), keywords: "insert add above row", run: () => run(insertLine(tablePos, kind, index, "before")) }
        : { icon: <ArrowLineLeft />, label: t("Spalte links einfügen", "Insert column left"), keywords: "insert add left column", run: () => run(insertLine(tablePos, kind, index, "before")) },
      row
        ? { icon: <ArrowLineDown />, label: t("Zeile darunter einfügen", "Insert row below"), keywords: "insert add below row", run: () => run(insertLine(tablePos, kind, index, "after")) }
        : { icon: <ArrowLineRight />, label: t("Spalte rechts einfügen", "Insert column right"), keywords: "insert add right column", run: () => run(insertLine(tablePos, kind, index, "after")) },
      {
        icon: <Copy />,
        label: t("Duplizieren", "Duplicate"),
        keywords: "duplicate copy duplizieren kopieren",
        shortcut: "Mod+D",
        disabled: !duplicateLine(tablePos, kind, index)(editor.state),
        run: () => run(duplicateLine(tablePos, kind, index)),
      },
      { icon: <Eraser />, label: t("Inhalt löschen", "Clear contents"), keywords: "clear empty leeren", run: () => run(clearCells(tablePos, rect)) },
      {
        icon: <Trash />,
        label: row ? t("Zeile löschen", "Delete row") : t("Spalte löschen", "Delete column"),
        keywords: "delete remove löschen entfernen",
        danger: true,
        disabled: total <= 1,
        run: () => run(deleteLine(tablePos, kind, index)),
      },
      "separator",
      row
        ? { icon: <Rows />, label: t("Kopfzeile", "Header row"), keywords: "header row kopfzeile überschrift", checked: headers.row, stay: true, run: () => run(toggleHeaderLine(tablePos, "row"), false) }
        : { icon: <Columns />, label: t("Kopfspalte", "Header column"), keywords: "header column kopfspalte", checked: headers.column, stay: true, run: () => run(toggleHeaderLine(tablePos, "column"), false) },
      "separator",
      ...tableItems(tablePos),
    ];
    return {
      main: { title: row ? t("Zeile", "Row") : t("Spalte", "Column"), items },
      color: { title: t("Farbe", "Colour"), items: colorItems(tablePos, rect) },
    };
  };

  // ---- Drawing ----
  const keep = (event: React.MouseEvent | React.PointerEvent) => event.preventDefault();
  const handles: React.ReactNode[] = [];
  const bars: React.ReactNode[] = [];
  let indicator: Box | null = null;
  if (grid && target && editor.isEditable) {
    const { box, clip, scrollbar, rows, columns, table } = grid;
    const left = Math.max(box.left, clip.left),
      right = Math.min(box.right, clip.right);
    const row = rows[target.row],
      column = columns[target.column];
    const selectedLine = (kind: TableLine, index: number) =>
      (menu && menu.kind === kind && menu.index === index) ||
      (outline && !outline.cells && outline.tablePos === table.pos && (kind === "row" ? selection instanceof CellSelection && selection.isRowSelection() && rows[index]?.top === outline.top : selection instanceof CellSelection && selection.isColSelection() && columns[index]?.left === outline.left));
    if (row && (!drag || drag.kind === "row")) {
      const index = target.row;
      handles.push(
        <button
          key={`row-${table.pos}-${index}`}
          type="button"
          className={`table-handle row${selectedLine("row", index) ? " selected" : ""}`}
          style={{ left: left - 8, top: (row.top + row.bottom) / 2 - 12 }}
          aria-label={t(`Zeile ${index + 1}`, `Row ${index + 1}`)}
          aria-haspopup="menu"
          aria-expanded={!!menu && menu.kind === "row" && menu.index === index}
          title={t("Ziehen zum Verschieben · Klicken für Menü", "Drag to move · Click to open menu")}
          onPointerDown={(e) => pressHandle(e, "row", table.pos, index)}
          onPointerMove={moveHandle}
          onPointerUp={releaseHandle}
          onPointerCancel={cancelHandle}
          onLostPointerCapture={cancelHandle}
          onMouseDown={keep}
          onClick={(e) => e.detail === 0 && openLine("row", table.pos, index, e.currentTarget)}
        >
          <GripDots across={false} />
        </button>,
      );
    }
    const columnVisible = column && column.right > clip.left + 4 && column.left < clip.right - 4;
    if (columnVisible && (!drag || drag.kind === "column")) {
      const index = target.column;
      const middle = Math.min(Math.max((column.left + column.right) / 2, clip.left + 12), clip.right - 12);
      handles.push(
        <button
          key={`column-${table.pos}-${index}`}
          type="button"
          className={`table-handle column${selectedLine("column", index) ? " selected" : ""}`}
          style={{ left: middle - 12, top: box.top - 8 }}
          aria-label={t(`Spalte ${index + 1}`, `Column ${index + 1}`)}
          aria-haspopup="menu"
          aria-expanded={!!menu && menu.kind === "column" && menu.index === index}
          title={t("Ziehen zum Verschieben · Klicken für Menü", "Drag to move · Click to open menu")}
          onPointerDown={(e) => pressHandle(e, "column", table.pos, index)}
          onPointerMove={moveHandle}
          onPointerUp={releaseHandle}
          onPointerCancel={cancelHandle}
          onLostPointerCapture={cancelHandle}
          onMouseDown={keep}
          onClick={(e) => e.detail === 0 && openLine("column", table.pos, index, e.currentTarget)}
        >
          <GripDots across />
        </button>,
      );
    }
    if (!drag) {
      bars.push(
        <button
          key={`add-row-${table.pos}`}
          type="button"
          tabIndex={-1}
          className="table-add row"
          // Between the table and its scrollbar, never over the scrollbar
          // (the bar is taller on touch screens than the gap there).
          style={{ left, top: box.bottom + 3, width: Math.max(0, right - left), ...(scrollbar !== null ? { maxHeight: Math.max(0, scrollbar - box.bottom - 3) } : {}) }}
          aria-label={t("Zeile hinzufügen", "Add row")}
          title={t("Zeile hinzufügen", "Add row")}
          onMouseDown={keep}
          onClick={() => run(appendLine(table.pos, "row"))}
        >
          <Plus size={12} weight="bold" aria-hidden />
        </button>,
      );
      if (box.right <= clip.right + 1)
        bars.push(
          <button
            key={`add-column-${table.pos}`}
            type="button"
            tabIndex={-1}
            className="table-add column"
            style={{ left: box.right + 3, top: box.top, height: Math.max(0, box.bottom - box.top) }}
            aria-label={t("Spalte hinzufügen", "Add column")}
            title={t("Spalte hinzufügen", "Add column")}
            onMouseDown={keep}
            onClick={() => run(appendLine(table.pos, "column"))}
          >
            <Plus size={12} weight="bold" aria-hidden />
          </button>,
        );
    }
    if (drag?.active && drag.boundary !== null) {
      if (drag.kind === "row") {
        const y = drag.boundary < rows.length ? rows[drag.boundary].top : rows[rows.length - 1].bottom;
        indicator = { left, right, top: y - 1.5, bottom: y + 1.5 };
      } else {
        const x = drag.boundary < columns.length ? columns[drag.boundary].left : columns[columns.length - 1].right;
        indicator = { left: x - 1.5, right: x + 1.5, top: box.top, bottom: box.bottom };
      }
    }
  }
  // A block of cells: a button at its top right corner for its menu.
  let cellsButton: React.ReactNode = null;
  if (outline?.cells && editor.isEditable && !drag) {
    const rect = outline.cells,
      tablePos = outline.tablePos;
    cellsButton = (
      <button
        type="button"
        className="table-cells-button"
        style={{ left: outline.right - 14, top: outline.top - 12 }}
        aria-label={t("Zellenoptionen", "Cell options")}
        aria-haspopup="menu"
        title={t("Zellenoptionen", "Cell options")}
        onMouseDown={keep}
        onClick={(e) => setMenu({ kind: "cells", tablePos, rect, anchor: e.currentTarget.getBoundingClientRect(), handle: e.currentTarget })}
      >
        <DotsThree size={14} weight="bold" aria-hidden />
      </button>
    );
  }
  return (
    <div ref={layer} className={`table-controls${drag?.active ? " dragging" : ""}`}>
      {outline && <div className="table-selection-outline" style={{ left: outline.left, top: outline.top, width: outline.right - outline.left, height: outline.bottom - outline.top }} aria-hidden />}
      {bars}
      {handles}
      {cellsButton}
      {indicator && <div className="table-drop-indicator" style={{ left: indicator.left, top: indicator.top, width: indicator.right - indicator.left, height: indicator.bottom - indicator.top }} aria-hidden />}
      {menu && (
        <BlockMenu
          key={`${menu.kind}-${menu.tablePos}-${menu.kind === "cells" ? "c" : menu.index}`}
          searchable
          flyouts
          anchor={menu.anchor}
          views={views()}
          owner={menu.handle}
          label={menu.kind === "row" ? t("Zeile", "Row") : menu.kind === "column" ? t("Spalte", "Column") : t("Zellen", "Cells")}
          className="table-menu"
          onClose={closeMenu}
        />
      )}
    </div>
  );
}
