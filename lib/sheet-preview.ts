// The spreadsheet preview (#402): the cells of an uploaded .csv or .xlsx
// file as JSON for the read-only viewer (components/sheet-viewer-dialog.tsx)
// – the sheets' names and, of one sheet, the first SHEET_MAX_ROWS rows and
// SHEET_MAX_COLUMNS columns as the text a spreadsheet shows. Nothing of the
// file is served as it is, nothing calculated. An old binary Excel file
// (.xls) is refused (415): the viewer offers its download. Who may see it
// is decided by the caller with the download's own checks
// (lib/file-access.ts readableFile, lib/publication.ts publicFile).
import { open } from "node:fs/promises";
import Papa from "papaparse";
import { HttpError } from "./auth";
import { ct } from "./content-locale";
import { localUpload, uploadPath } from "./storage";
import { SHEET_MAX_COLUMNS, SHEET_MAX_ROWS, SHEET_PREVIEW_LIMIT, sheetKindOf, type SheetPreview } from "./sheet-files";
import { readXlsx } from "./sheet-xlsx";

// The largest file the preview reads: FLOWPLAN_SHEET_PREVIEW_MB, default
// 20 MB, at most 100 MB – the whole file is read into memory.
export const SHEET_PREVIEW_MAX_MB = 100;
export function sheetPreviewLimit(raw = process.env.FLOWPLAN_SHEET_PREVIEW_MB) {
  const mb = Number(raw);
  if (!raw || !Number.isFinite(mb) || mb <= 0) return SHEET_PREVIEW_LIMIT;
  return Math.round(Math.min(mb, SHEET_PREVIEW_MAX_MB) * 1024 * 1024);
}

// The text of a CSV file: UTF-8 (with or without byte order mark), UTF-16
// with one (Excel's "Unicode text"), else Windows-1252 (Excel's CSV on
// Windows in Western Europe), which reads any byte.
export function csvText(bytes: Uint8Array): { text: string; encoding: string } {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: new TextDecoder("utf-16le").decode(bytes), encoding: "utf-16le" };
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { text: new TextDecoder("utf-16be").decode(bytes), encoding: "utf-16be" };
  try {
    // The decoder drops a byte order mark.
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "utf-8" };
  } catch {
    return { text: new TextDecoder("windows-1252").decode(bytes), encoding: "windows-1252" };
  }
}

// The rows of a CSV: the delimiter guessed from the file (comma,
// semicolon, tab, pipe), quoted fields with delimiters, quotes and line
// breaks inside, empty lines kept as empty rows except at the end.
export function csvRows(text: string, limits = { rows: SHEET_MAX_ROWS, columns: SHEET_MAX_COLUMNS }) {
  // Guessed from the first lines without the empty ones (Papa Parse counts
  // an empty line as a row of one field, which spoils its guess) …
  const delimiter =
    Papa.parse<string[]>(text.slice(0, 64 * 1024), { preview: 50, delimitersToGuess: [",", ";", "\t", "|"], skipEmptyLines: true }).meta.delimiter || ",";
  // … then the rows with them.
  const parsed = Papa.parse<string[]>(text, { preview: limits.rows + 1, delimiter, skipEmptyLines: false });
  const rows = parsed.data;
  // The line break after the last line is no row of its own.
  while (rows.length && rows[rows.length - 1].every((cell) => !cell)) rows.pop();
  let truncated = rows.length > limits.rows;
  if (truncated) rows.length = limits.rows;
  let columns = 0;
  for (let i = 0; i < rows.length; i++) {
    let row = rows[i];
    if (row.length > limits.columns) {
      if (row.slice(limits.columns).some((cell) => cell)) truncated = true;
      row = rows[i] = row.slice(0, limits.columns);
    }
    // An empty line reads as [""]: no cells.
    if (row.length === 1 && !row[0]) rows[i] = row = [];
    columns = Math.max(columns, row.length);
  }
  return { rows, columns, truncated, delimiter };
}

export async function readSheet(bytes: Buffer, name: string, sheet = 0): Promise<SheetPreview> {
  const kind = sheetKindOf(name);
  const limits = { rows: SHEET_MAX_ROWS, columns: SHEET_MAX_COLUMNS };
  if (kind === "csv") {
    const { text, encoding } = csvText(bytes);
    return { kind, sheets: [""], sheet: 0, ...csvRows(text, limits), limits, encoding };
  }
  if (kind === "xlsx") return { kind, ...(await readXlsx(bytes, sheet)), limits };
  throw notPreviewable(name);
}
const notPreviewable = (name: string) =>
  new HttpError(
    415,
    sheetKindOf(name) === "xls"
      ? ct("Excel-97–2003-Dateien (.xls) zeigt die Vorschau nicht – du kannst sie herunterladen.", "The preview does not show Excel 97–2003 files (.xls) – you can download them.")
      : ct("Keine Tabellendatei.", "Not a spreadsheet file."),
  );

export async function sheetPreviewResponse(req: Request, file: { id: string; name: string; mime: string }) {
  const kind = sheetKindOf(file.name);
  // Refused before the file is read.
  if (kind !== "csv" && kind !== "xlsx") throw notPreviewable(file.name);
  const sheet = Number(new URL(req.url).searchParams.get("sheet") || 0);
  let handle;
  try {
    handle = await open((await localUpload(file.id)) ?? uploadPath(file.id), "r");
  } catch {
    throw new HttpError(404, "Datei fehlt.");
  }
  let bytes: Buffer;
  try {
    const { size } = await handle.stat();
    const limit = sheetPreviewLimit();
    if (size > limit) {
      const mb = Math.round((limit / 1024 / 1024) * 10) / 10;
      throw new HttpError(413, ct(`Die Datei ist zu groß für die Vorschau (höchstens ${mb} MB).`, `The file is too large for the preview (at most ${mb} MB).`));
    }
    bytes = await handle.readFile();
  } finally {
    await handle.close();
  }
  const preview = await readSheet(bytes, file.name, Number.isInteger(sheet) && sheet >= 0 ? sheet : 0);
  return Response.json(preview, {
    headers: {
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
}
