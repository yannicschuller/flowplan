// Spreadsheet files (#402): an uploaded .csv or .xlsx file opens in a
// read-only table viewer (components/sheet-viewer.tsx); an old binary Excel
// file (.xls) only gets a note and its download. Shared by the browser and
// the server (lib/sheet-preview.ts); nothing here reads a file.

// Larger files are only downloaded. The default; FLOWPLAN_SHEET_PREVIEW_MB
// changes it on the server (lib/sheet-preview.ts sheetPreviewLimit()).
export const SHEET_PREVIEW_LIMIT = 20 * 1024 * 1024;
// What one answer of the preview holds at most: the first rows and columns
// of a sheet; the rest is left out (`truncated`).
export const SHEET_MAX_ROWS = 5000;
export const SHEET_MAX_COLUMNS = 200;

export type SheetKind = "csv" | "xlsx" | "xls";

// By the name only, as for HTML files: browsers send differing types for
// spreadsheets, and the preview reads the content itself.
export function sheetKindOf(name: string): SheetKind | null {
  const ext = /\.(csv|xlsx|xls)$/i.exec(name.trim())?.[1]?.toLowerCase();
  return (ext as SheetKind | undefined) ?? null;
}
export const isSheetName = (name: string) => sheetKindOf(name) !== null;
// The files the viewer shows (an .xls is only downloaded).
export const isPreviewableSheet = (name: string) => {
  const kind = sheetKindOf(name);
  return kind === "csv" || kind === "xlsx";
};

// The preview's address next to a file's own (/api/files/<id> and the
// published /api/share/<token>/files/<id>), for one sheet of a workbook.
export const sheetPreviewUrl = (src: string, sheet = 0) => `${src}/sheet${sheet ? `?sheet=${sheet}` : ""}`;

// What GET …/sheet answers.
export type SheetPreview = {
  kind: "csv" | "xlsx";
  // The names of the workbook's sheets (a CSV has one, named after nothing).
  sheets: string[];
  // The sheet shown, counted from 0.
  sheet: number;
  // Its cells as the spreadsheet shows them, row by row; rows may be
  // shorter than `columns` (missing cells are empty).
  rows: string[][];
  columns: number;
  // More rows or columns than SHEET_MAX_ROWS × SHEET_MAX_COLUMNS: only the
  // first ones are here.
  truncated: boolean;
  limits: { rows: number; columns: number };
  // CSV only: what the file was read with.
  delimiter?: string;
  encoding?: string;
};

// Column letters as a spreadsheet names them: A … Z, AA … ZZ, AAA …
export function columnName(index: number) {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}
// The other way round (the "B" of a cell reference "B12"), counted from 0.
export function columnIndex(letters: string) {
  let n = 0;
  for (const c of letters.toUpperCase()) n = n * 26 + (c.charCodeAt(0) - 64);
  return n - 1;
}

/* ---------- The viewer's filter and sort (view only, client side) ---------- */

// Indices of the rows that contain the filter text in any cell, ignoring
// case and accents.
const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase();
export function filterRows(rows: readonly (readonly string[])[], query: string, from = 0): number[] {
  const needle = fold(query.trim());
  const out: number[] = [];
  for (let i = from; i < rows.length; i++) if (!needle || rows[i].some((cell) => cell && fold(cell).includes(needle))) out.push(i);
  return out;
}
// Numbers as numbers ("1.5", "-3", "1e3", "2.000,5" stays text), else text
// in natural order; empty cells always last.
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;
const collator = typeof Intl !== "undefined" ? new Intl.Collator(undefined, { numeric: true, sensitivity: "base" }) : null;
export function compareCells(a: string, b: string) {
  if (!a || !b) return a ? -1 : b ? 1 : 0;
  const x = a.trim(),
    y = b.trim();
  if (NUMBER.test(x) && NUMBER.test(y)) return Number(x) - Number(y);
  return collator ? collator.compare(x, y) : x < y ? -1 : x > y ? 1 : 0;
}
// The row indices in `order` sorted by one column; stable, empty cells last
// in both directions.
export function sortRows(rows: readonly (readonly string[])[], order: number[], column: number, descending: boolean) {
  return order
    .map((index, position) => ({ index, position }))
    .sort((p, q) => {
      const a = rows[p.index][column] || "",
        b = rows[q.index][column] || "";
      if (!a || !b) return compareCells(a, b) || p.position - q.position;
      return (descending ? compareCells(b, a) : compareCells(a, b)) || p.position - q.position;
    })
    .map((p) => p.index);
}
