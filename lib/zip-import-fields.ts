// Dates and property types of CSV columns (Markdown/Notion ZIP import,
// lib/zip-import.ts; lib/importers/notion-props.ts).
import type { Field } from "./types";

const monthNames = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
// Notion writes "September 24, 2026" (optionally with a time) or ISO dates.
export function importDate(value: string): string | null {
  const iso = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?/.exec(value);
  if (iso) return iso[1];
  const long = /^([A-Za-z]+) (\d{1,2}), (\d{4})/.exec(value);
  if (long) {
    const month = monthNames.indexOf(long[1].toLowerCase());
    if (month >= 0)
      return `${long[3]}-${String(month + 1).padStart(2, "0")}-${long[2].padStart(2, "0")}`;
  }
  return null;
}
export function inferField(
  name: string,
  values: string[],
  index: number,
): Field {
  const fid = index === 0 ? "title" : `f${index}`;
  const filled = values.map((v) => v.trim()).filter(Boolean);
  if (index === 0 || !filled.length) return { id: fid, name, type: "text" };
  if (filled.every((v) => /^-?\d+(?:[.,]\d+)?$/.test(v)))
    return { id: fid, name, type: "number" };
  if (filled.every((v) => /^(yes|no|ja|nein|true|false)$/i.test(v)))
    return { id: fid, name, type: "checkbox" };
  if (filled.every((v) => importDate(v)))
    return { id: fid, name, type: "date" };
  const distinct = [...new Set(filled)];
  if (distinct.length <= 12 && filled.length >= distinct.length * 2)
    return { id: fid, name, type: "select", options: distinct.slice(0, 100) };
  return { id: fid, name, type: "text" };
}
