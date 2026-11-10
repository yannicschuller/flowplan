// Values of a workflow into record properties (docs/specs/workflows.md
// §7.3): a whole placeholder keeps its type and is converted to the
// property's type; a value that does not fit is a validation error with
// the property's name and the value. Client-safe.
import type { Field } from "../types";
import { isEmpty, valueText } from "./placeholders";

export class ValueError extends Error {
  kind = "validation" as const;
}
const COMPUTED = new Set(["formula", "rollup", "created_at", "updated_at", "created_by", "updated_by", "id", "progress"]);
export const writableFieldType = (field: Field) => !COMPUTED.has(field.type);

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const idOf = (v: unknown): string | null =>
  typeof v === "string" ? v : v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string" ? (v as { id: string }).id : null;

function fail(field: Field, value: unknown): never {
  const shown = typeof value === "string" ? value : JSON.stringify(value);
  throw new ValueError(`„${String(shown).slice(0, 80)}“ passt nicht in die Eigenschaft „${field.name}“.`);
}
// Numbers from text: dot and comma as decimal separator.
export function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  let s = value.trim().replace(/\s/g, "");
  if (!s) return null;
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
  else if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, "");
  else s = s.replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
// The compare value of a number condition (greater, less, between) with the
// separators toNumber() accepts, as the filters read numbers ("1000,5" → "1000.5").
const NUMBER_OPS = new Set(["gt", "gte", "lt", "lte", "between"]);
export function compareNumberText(op: string, text: string): string {
  if (!NUMBER_OPS.has(op)) return text;
  const n = toNumber(text);
  return n === null ? text : String(n);
}
const list = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : isEmpty(value) ? [] : typeof value === "string" ? value.split(",").map((s) => s.trim()).filter(Boolean) : [value];

// The cell value for `field`. Empty values clear the property.
export function coerceToField(value: unknown, field: Field, locale: "de" | "en" | string = "de", timeZone = "UTC"): unknown {
  if (!writableFieldType(field)) throw new ValueError(`Die Eigenschaft „${field.name}“ wird berechnet und lässt sich nicht setzen.`);
  const text = () => valueText(value, locale as never, timeZone);
  switch (field.type) {
    case "number":
    case "time": {
      if (isEmpty(value)) return null;
      const n = toNumber(value);
      return n === null ? fail(field, value) : n;
    }
    case "checkbox": {
      if (typeof value === "boolean") return value;
      if (isEmpty(value)) return false;
      const s = String(value).trim().toLowerCase();
      if (["true", "1", "ja", "yes", "oui", "x", "✓"].includes(s)) return true;
      if (["false", "0", "nein", "no", "non"].includes(s)) return false;
      return fail(field, value);
    }
    case "date": {
      if (isEmpty(value)) return "";
      if (typeof value !== "string") return fail(field, value);
      const s = value.trim();
      if (DATE.test(s)) return s;
      if (DATETIME.test(s)) {
        const ms = Date.parse(s);
        return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 16) + "Z" : fail(field, value);
      }
      return fail(field, value);
    }
    case "select": {
      if (isEmpty(value)) return "";
      const s = text().trim();
      const option = (field.options || []).find((o) => o.toLowerCase() === s.toLowerCase());
      return option ?? fail(field, value);
    }
    case "multiselect":
    case "sprint": {
      const out: string[] = [];
      for (const v of list(value)) {
        const s = valueText(v, locale as never, timeZone).trim();
        if (!s) continue;
        const option = (field.options || []).find((o) => o.toLowerCase() === s.toLowerCase());
        if (option === undefined && !field.tagOptions) fail(field, v);
        out.push(option ?? s);
      }
      return [...new Set(out)];
    }
    case "aliases":
      return list(value).map((v) => valueText(v, locale as never, timeZone).trim()).filter(Boolean);
    case "person": {
      if (isEmpty(value)) return "";
      const ids = list(value).map(idOf);
      if (ids.some((v) => !v)) return fail(field, value);
      return ids.length === 1 ? ids[0] : ids;
    }
    case "relation":
    case "files": {
      const ids = list(value).map(idOf);
      if (ids.some((v) => !v)) return fail(field, value);
      return ids;
    }
    case "checklist":
      return Array.isArray(value) ? value : text();
    default:
      return text();
  }
}
