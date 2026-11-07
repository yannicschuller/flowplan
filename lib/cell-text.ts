import { foldName } from "./page-properties";

export function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(cellText).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

// CSV exports: values that a spreadsheet would run as a formula (=, +, @, a
// "-" that is not a number, also after leading spaces; a leading tab or
// carriage return) get a leading apostrophe; negative numbers stay. So do
// such values that already start with apostrophes ("'=x"), so that the
// import can take exactly one away. Every CSV export uses this guard.
export const CSV_FORMULA = /^'*(?:[\t\r]|\s*(?:[=+@]|-(?!\d[\d.,]*$)))/;

// The CSV import undoes that: a leading apostrophe goes only where the export
// put it, so "'hello" and "it's" stay as written.
export function csvImportText(value: string) {
  return value.startsWith("'") && CSV_FORMULA.test(value.slice(1)) ? value.slice(1) : value;
}

// A multi-select cell of the CSV import. The export joins the values with
// ", " (cellText), so a value that contains a comma itself ("Night, Weekend")
// comes back whole when it names one of the property's options or tags; the
// longest match wins. Anything else is split at every comma, as typed in a
// spreadsheet.
export function csvListValues(text: string, options: string[] = []) {
  const known = new Map(options.map((o) => [foldName(o), o]));
  const parts = text.split(",");
  const values: string[] = [];
  // A run never spans more parts than the longest option has: linear in the
  // number of commas instead of cubic (a 1,000-value cell froze the tab).
  const span = Math.max(1, ...options.map((o) => o.split(",").length));
  for (let i = 0; i < parts.length; ) {
    let end = i + 1;
    for (let j = Math.min(parts.length, i + span); j > end; j--)
      if (known.has(foldName(parts.slice(i, j).join(",")))) {
        end = j;
        break;
      }
    const value = parts.slice(i, end).join(",").trim();
    if (value) values.push(known.get(foldName(value)) ?? value);
    i = end;
  }
  return values;
}
