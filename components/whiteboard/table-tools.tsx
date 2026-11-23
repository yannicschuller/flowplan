"use client";
// The style bar's buttons for a table: rows and columns, header row and
// header column, and background colours of whole rows and columns (#455)
// from the board's fill palette. The colour goes to the row or column of
// the cell last clicked or edited (lib/whiteboard-tables.ts).
import { useState } from "react";
import { PaintBucket } from "@phosphor-icons/react";
import { useT } from "../i18n";
import { Select } from "../select";
import { fillColors, type WhiteboardItem } from "@/lib/whiteboard-model";
import { cellFill, setFill, tableShape } from "@/lib/whiteboard-tables";
import { fitBarMenu } from "./item-tools";

type Cell = { r: number; c: number };
type Target = `row:${number}` | `col:${number}`;
// The target per table, kept while the style bar comes and goes (it hides
// during every pointer gesture, a click on a cell included).
const targets = new Map<string, Target>();
let listening = false;
function listen() {
  if (listening || typeof document === "undefined") return;
  listening = true;
  document.addEventListener(
    "pointerdown",
    (e) => {
      const el = (e.target as Element | null)?.closest?.("[data-cell]");
      const id = el?.closest("[data-item]")?.getAttribute("data-item");
      const [r] = (el?.getAttribute("data-cell") || "").split(":").map(Number);
      if (id && Number.isInteger(r)) targets.set(id, `row:${r}`);
    },
    true,
  );
}

export function TableTools({
  item,
  cell,
  set,
  resize,
}: {
  item: WhiteboardItem;
  // The cell being edited, if any.
  cell: Cell | null;
  set: (props: Partial<WhiteboardItem>) => void;
  resize: (rows: number, cols: number) => void;
}) {
  const t = useT();
  const { cells, cols } = tableShape(item);
  const [open, setOpen] = useState(false);
  const [, setChosen] = useState(0);
  listen();
  // The cell last edited or clicked picks the row (its column stays one
  // choice away).
  if (cell) targets.set(item.id, `row:${cell.r}`);
  const target = targets.get(item.id) || "row:0";
  const setTarget = (next: Target) => {
    targets.set(item.id, next);
    setChosen((n) => n + 1);
  };
  const [kind, at] = target.split(":") as ["row" | "col", string];
  const index = Math.min(Number(at), (kind === "row" ? cells.length : cols) - 1);
  const current = kind === "row" ? cellFill({ rowFills: item.rowFills }, index, -1) : cellFill({ colFills: item.colFills }, -1, index);
  const paint = (color: string) =>
    set(
      kind === "row"
        ? { rowFills: setFill(item.rowFills, index, color, cells.length) }
        : { colFills: setFill(item.colFills, index, color, cols) },
    );
  const rowName = (r: number) => (r === 0 && item.header !== false ? t("Kopfzeile", "Header row") : t(`Zeile ${r + 1}`, `Row ${r + 1}`));
  const colName = (c: number) => (c === 0 && item.headerCol ? t("Kopfspalte", "Header column") : t(`Spalte ${c + 1}`, `Column ${c + 1}`));
  return (
    <>
      <span className="wb-sep" />
      <button title={t("Zeile hinzufügen", "Add row")} onClick={() => resize(1, 0)}>
        {t("+ Zeile", "+ Row")}
      </button>
      <button title={t("Letzte Zeile entfernen", "Remove last row")} onClick={() => resize(-1, 0)}>
        {t("− Zeile", "− Row")}
      </button>
      <button title={t("Spalte hinzufügen", "Add column")} onClick={() => resize(0, 1)}>
        {t("+ Spalte", "+ Column")}
      </button>
      <button title={t("Letzte Spalte entfernen", "Remove last column")} onClick={() => resize(0, -1)}>
        {t("− Spalte", "− Column")}
      </button>
      <button className={item.header !== false ? "active" : ""} aria-pressed={item.header !== false} onClick={() => set({ header: item.header === false })}>
        {t("Kopfzeile", "Header row")}
      </button>
      <button className={item.headerCol ? "active" : ""} aria-pressed={!!item.headerCol} onClick={() => set({ headerCol: !item.headerCol })}>
        {t("Kopfspalte", "Header column")}
      </button>
      <span className="wb-arrange">
        <button
          aria-label={t("Farbe von Zeile oder Spalte", "Colour of row or column")}
          title={t("Zeilen und Spalten färben", "Colour rows and columns")}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <PaintBucket size={16} />
        </button>
        {open && (
          <span ref={fitBarMenu} className="wb-arrange-menu wb-table-colors" role="dialog" aria-label={t("Tabellenfarben", "Table colours")}>
            <small>{t("Färben", "Colour")}</small>
            <Select aria-label={t("Zeile oder Spalte", "Row or column")} value={`${kind}:${index}`} onChange={(e) => setTarget(e.target.value as Target)}>
              <optgroup label={t("Zeilen", "Rows")}>
                {cells.map((_, r) => (
                  <option key={`r${r}`} value={`row:${r}`}>
                    {rowName(r)}
                  </option>
                ))}
              </optgroup>
              <optgroup label={t("Spalten", "Columns")}>
                {Array.from({ length: cols }, (_, c) => (
                  <option key={`c${c}`} value={`col:${c}`}>
                    {colName(c)}
                  </option>
                ))}
              </optgroup>
            </Select>
            <span className="wb-table-swatches" role="radiogroup" aria-label={t("Hintergrundfarbe", "Background colour")}>
              {fillColors.map((c) => {
                const none = c === "transparent";
                const active = none ? !current : current === c.toLowerCase();
                return (
                  <button
                    key={c}
                    role="radio"
                    aria-checked={active}
                    className={`wb-swatch${active ? " active" : ""}${none ? " none" : ""}`}
                    style={{ background: c }}
                    aria-label={none ? t("Keine Farbe", "No colour") : t(`Hintergrund ${c}`, `Background ${c}`)}
                    onClick={() => paint(none ? "" : c)}
                  />
                );
              })}
            </span>
          </span>
        )}
      </span>
    </>
  );
}
