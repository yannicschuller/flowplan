// Selected records of a table view for the clipboard (issue #119): the
// visible properties as tab-separated text (Excel, Numbers, Google Sheets)
// and as an HTML table (rich editors such as a Flowplan document). Values are
// written as people read them in the table – names instead of ids, formatted
// numbers and dates. Client-safe and pure.
import { CSV_FORMULA, cellText } from "./cell-text";
import { formatFieldDate, formatNumber } from "./field-format";
import { fileLabel, fileUrls } from "./file-cells";
import { formatDuration } from "./durations";
import { LOCALE_TAG } from "./locale-tag";
import { percentAggregate } from "./rollups";
import type { Field, Row } from "./types";

export type ClipboardContext = {
  // People by id (person, created_by and updated_by).
  members?: readonly { id: string; name: string }[];
  // Records of linked databases by database id (relations).
  related?: Record<string, readonly Pick<Row, "id" | "cells">[]>;
  files?: readonly { url: string; name: string }[];
  sprints?: readonly { id: string; name: string }[];
  // Checkbox values and placeholders in the reader's language.
  yes: string;
  no: string;
  untitled: string;
  unavailable: string;
  // Time zone of dates (default: the browser's).
  zone?: string;
};

// Values of these types are numbers, dates or ids: never a formula for a
// spreadsheet, so they keep a leading "-" without an apostrophe.
const NON_TEXT: Field["type"][] = ["number", "date", "checkbox", "created_at", "updated_at", "id", "progress", "time", "rollup"];

const list = (value: unknown) => (Array.isArray(value) ? value : value === null || value === undefined || value === "" ? [] : [value]);

// One cell as text, as the table shows it.
export function clipboardCell(field: Field, value: unknown, ctx: ClipboardContext): string {
  switch (field.type) {
    case "checkbox":
      return value ? ctx.yes : ctx.no;
    case "number":
      if (typeof value !== "number") return cellText(value);
      return formatNumber(value, field.format, field.decimals);
    case "date":
    case "created_at":
    case "updated_at":
      return value ? formatFieldDate(value, field, ctx.zone) : "";
    case "person":
    case "created_by":
    case "updated_by":
      return list(value)
        .map((id) => ctx.members?.find((m) => m.id === id)?.name || "")
        .filter(Boolean)
        .join(", ");
    case "relation":
      return list(value)
        .map((id) => {
          const target = ctx.related?.[field.relationPage || ""]?.find((r) => r.id === id);
          return target ? cellText(target.cells.title) || ctx.untitled : ctx.unavailable;
        })
        .join(", ");
    case "files": {
      const names = new Map((ctx.files || []).map((f) => [f.url, f.name]));
      return fileUrls(value)
        .map((url) => fileLabel(url, names))
        .join(", ");
    }
    case "sprint":
      return ctx.sprints?.find((s) => s.id === value)?.name || "";
    case "time":
      return typeof value === "number" && value ? formatDuration(value) : "";
    case "progress":
      return typeof value === "number" ? `${Math.round(value * 100)} %` : "";
    case "rollup":
      if (typeof value !== "number") return cellText(value);
      return new Intl.NumberFormat(LOCALE_TAG, {
        maximumFractionDigits: 2,
        ...(percentAggregate(field.aggregate) ? { style: "percent" as const } : {}),
      }).format(value);
    case "formula":
      return typeof value === "number" && field.format ? formatNumber(value, field.format, field.decimals) : cellText(value);
    case "checklist":
      return list(value)
        .map((item) =>
          item && typeof item === "object"
            ? `${(item as { done?: boolean }).done ? "[x]" : "[ ]"} ${String((item as { text?: unknown }).text ?? "")}`
            : "",
        )
        .filter(Boolean)
        .join("; ");
  }
  return cellText(value);
}

export type ClipboardTable = { header: string[]; rows: string[][]; numeric: boolean[][] };

// The fields in view order and the rows in view order; `rows` carry their
// computed cells (formulas, rollups, timestamps), as the table shows them.
export function clipboardTable(fields: Field[], rows: Pick<Row, "cells">[], ctx: ClipboardContext): ClipboardTable {
  return {
    header: fields.map((f) => f.name),
    rows: rows.map((r) => fields.map((f) => clipboardCell(f, r.cells[f.id], ctx))),
    numeric: rows.map((r) =>
      fields.map((f) => NON_TEXT.includes(f.type) || (f.type === "formula" && typeof r.cells[f.id] === "number")),
    ),
  };
}

// Tab-separated, the way Excel itself puts cells on the clipboard: rows end
// with CRLF; a tab inside a value becomes a space; a value with a line break
// (or a leading quote) is wrapped in quotes with inner quotes doubled, which
// Excel, Numbers and Google Sheets read back as one cell. Text that a
// spreadsheet would run as a formula gets a leading apostrophe, as in the CSV
// export (spreadsheets hide it).
export function tsvCell(value: string, numeric = false) {
  let text = value.replace(/\t/g, " ").replace(/\r\n?/g, "\n");
  if (!numeric && CSV_FORMULA.test(text)) text = "'" + text;
  return text.includes("\n") || text.startsWith('"') ?`"${text.replace(/"/g, '""')}"` : text;
}

export function clipboardTsv(table: ClipboardTable) {
  return [
    table.header.map((h) => tsvCell(h)).join("\t"),
    ...table.rows.map((row, i) => row.map((v, j) => tsvCell(v, table.numeric[i]?.[j])).join("\t")),
  ].join("\r\n") + "\r\n";
}

export function escapeHtml(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
const htmlCell = (text: string) => escapeHtml(text).replace(/\r\n?|\n/g, "<br>");

export function clipboardHtml(table: ClipboardTable) {
  return (
    "<table><thead><tr>" +
    table.header.map((h) => `<th>${htmlCell(h)}</th>`).join("") +
    "</tr></thead><tbody>" +
    table.rows.map((row) => "<tr>" + row.map((v) => `<td>${htmlCell(v)}</td>`).join("") + "</tr>").join("") +
    "</tbody></table>"
  );
}

export function recordsClipboard(fields: Field[], rows: Pick<Row, "cells">[], ctx: ClipboardContext) {
  const table = clipboardTable(fields, rows, ctx);
  return { text: clipboardTsv(table), html: clipboardHtml(table) };
}
