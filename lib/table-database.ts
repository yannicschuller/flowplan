// "In Datenbank umwandeln" (#118): a table of a document becomes a database.
// The browser reads the table's cells as plain text (with the links of a
// cell); lib/api.ts "table.toDatabase" turns them into properties and
// records with the functions here, the same in the browser and on the server.
//
// - The first row names the properties (the header row, or the first row of
//   a table without one); an empty name becomes "Spalte 1" …, names repeat
//   as "Name 2" ….
// - The first column is the title; every other column is typed by its
//   values (empty cells do not count): number, date, checkbox, URL, else text.
import type { Field, FieldType } from "./types";

// The limits of the CSV import (lib/zip-import.ts MAX_IMPORT_ROWS and its
// 80 columns, 200 characters per name, 10,000 per value).
export const TABLE_DATABASE_LIMITS = { rows: 5000, columns: 80, name: 200, text: 10_000, href: 2000 } as const;

export type TableCell = { text: string; href?: string };
export type TableDatabase = { fields: Field[]; rows: Record<string, unknown>[] };

// Numbers in German or English writing: 12, -3, 1,5, 1.5, .5, 1.234,56,
// 1,234.56, 1.234.567. Two different separators: the last one is the
// decimal point; one separator repeated: thousands; one separator once: the
// decimal point.
export function parseNumber(raw: string): number | null {
  // Narrow and non-breaking spaces group thousands too; plain spaces do not
  // (phone numbers stay text).
  const value = raw.trim().replace(/[  ]/g, "").replace(/^−/, "-");
  if (!/^-?(?:\d+(?:[.,]\d+)*|[.,]\d+)$/.test(value)) return null;
  const dots = value.split(".").length - 1,
    commas = value.split(",").length - 1;
  let normal = value;
  if (dots && commas) {
    const decimal = value.lastIndexOf(".") > value.lastIndexOf(",") ? "." : ",";
    const thousands = decimal === "." ? "," : ".";
    // The decimal point comes once, after every thousands separator.
    if ((decimal === "." ? dots : commas) !== 1) return null;
    if (!/^-?\d{1,3}(?:[.,]\d{3})*[.,]\d+$/.test(value)) return null;
    normal = value.split(thousands).join("").replace(",", ".");
  } else if (dots > 1 || commas > 1) {
    if (!/^-?\d{1,3}(?:[.,]\d{3})+$/.test(value)) return null;
    normal = value.replace(/[.,]/g, "");
  } else normal = value.replace(",", ".");
  const number = Number(normal);
  return Number.isFinite(number) ? number : null;
}

const validDay = (y: number, m: number, d: number) => {
  if (y < 1 || m < 1 || m > 12 || d < 1) return false;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
};
const day = (y: number, m: number, d: number) =>
  validDay(y, m, d) ? `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` : null;
// ISO dates (2026-11-04, also with a time after it) and the German
// 4.11.2026 / 04.11.2026 (also 04.11.26: 20xx) as YYYY-MM-DD.
export function parseDate(raw: string): string | null {
  const value = raw.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(value);
  if (iso) return day(+iso[1], +iso[2], +iso[3]);
  const german = /^(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2})$/.exec(value);
  if (german) return day(german[3].length === 2 ? 2000 + +german[3] : +german[3], +german[2], +german[1]);
  return null;
}

const CHECKED = new Set(["✓", "✔", "☑", "✅", "x", "yes", "ja", "true", "wahr"]);
const UNCHECKED = new Set(["✗", "✘", "☐", "❌", "no", "nein", "false", "falsch"]);
export function parseCheckbox(raw: string): boolean | null {
  const value = raw.trim().toLowerCase();
  return CHECKED.has(value) ? true : UNCHECKED.has(value) ? false : null;
}

const URL_PATTERN = /^(?:https?:\/\/|www\.)[^\s<>"]+\.[^\s<>"]+$|^https?:\/\/[^\s<>"]+$/i;
// A web address: the link of a cell that is only that link, or text that
// looks like one ("www." gets https://).
export function cellUrl(cell: TableCell): string | null {
  const text = cell.text.trim();
  if (cell.href && /^https?:\/\//i.test(cell.href) && text) return cell.href;
  if (!URL_PATTERN.test(text)) return null;
  return /^www\./i.test(text) ? `https://${text}` : text;
}

// The type of a column from its values; empty cells do not count, a
// column without values is text.
export function detectColumnType(cells: TableCell[]): FieldType {
  const filled = cells.filter((c) => c.text.trim());
  if (!filled.length) return "text";
  if (filled.every((c) => parseNumber(c.text) !== null)) return "number";
  if (filled.every((c) => parseDate(c.text) !== null)) return "date";
  if (filled.every((c) => parseCheckbox(c.text) !== null)) return "checkbox";
  if (filled.every((c) => cellUrl(c) !== null)) return "url";
  return "text";
}

// The property names from the first row: trimmed to one line, empty ones
// numbered ("Spalte 3"), repeated ones counted on ("Name 2").
export function headerNames(first: TableCell[], columns: number, label = (n: number) => `Spalte ${n}`): string[] {
  const taken = new Set<string>();
  const names: string[] = [];
  for (let i = 0; i < columns; i++) {
    const base = (first[i]?.text || "").replace(/\s+/g, " ").trim().slice(0, TABLE_DATABASE_LIMITS.name) || label(i + 1);
    let name = base;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base.slice(0, TABLE_DATABASE_LIMITS.name - String(n).length - 1)} ${n}`;
    taken.add(name.toLowerCase());
    names.push(name);
  }
  return names;
}

export function cellValue(type: FieldType, cell: TableCell): unknown {
  const text = cell.text.trim();
  if (type === "checkbox") return text ? parseCheckbox(text) === true : false;
  if (!text) return null;
  if (type === "number") return parseNumber(text);
  if (type === "date") return parseDate(text);
  if (type === "url") return cellUrl(cell)?.slice(0, TABLE_DATABASE_LIMITS.href) ?? null;
  return text.slice(0, TABLE_DATABASE_LIMITS.text);
}

// The whole table: the first row names the properties, the others become
// records (rows without any text are left out).
export function tableToDatabase(table: TableCell[][], label?: (n: number) => string): TableDatabase {
  const columns = Math.max(1, ...table.map((row) => row.length));
  const [first = [], ...body] = table;
  const names = headerNames(first, columns, label);
  const records = body.filter((row) => row.some((c) => c?.text.trim()));
  const fields: Field[] = names.map((name, i) => ({
    id: i === 0 ? "title" : `f${i}`,
    name,
    type: i === 0 ? "text" : detectColumnType(records.map((row) => row[i] || { text: "" })),
  }));
  const rows = records.map((row) =>
    Object.fromEntries(
      fields.flatMap((field, i) => {
        const value = cellValue(field.type, row[i] || { text: "" });
        return value === null ? [] : [[field.id, value]];
      }),
    ),
  );
  return { fields, rows };
}
