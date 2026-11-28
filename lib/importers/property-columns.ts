// Frontmatter properties as columns of the database an import into a new
// database makes (Obsidian, #670): one column per key, of the type the
// import decided for the whole vault (tree.propertyTypes, #598) or the
// values show, after the fixed columns (Name, Tags, Created, …). A name
// taken by a fixed column gets a number ("Tags (2)"). At most
// MAX_DATABASE_FIELDS columns and MAX_OPTIONS options per column; what does
// not fit is named in the import report.
import type { Field, FieldType } from "../types";
import type { FrontmatterValue } from "../frontmatter";
import { guessPropertyType, type PropertyHints } from "../frontmatter-types";
import { cleanName, foldName, isComputedProperty, MAX_OPTION_LENGTH, MAX_OPTIONS, MAX_PROPERTY_NAME, MAX_TEXT_VALUE } from "../page-properties";
import { NOT_PROPERTIES } from "../page-properties-server";
import { validDateValue } from "../date-values";
import { ct } from "../content-locale";
import type { ImportReport } from "./types";

// The fields a database may have (lib/database-schema.ts users: max(80)).
export const MAX_DATABASE_FIELDS = 80;
const FIELD_TYPES = new Set<FieldType>(["text", "number", "date", "select", "multiselect", "checkbox", "url", "email", "phone"]);
// "Name (id)" as the export writes a name that clashes.
const plainName = (key: string) => key.replace(/ \([0-9a-f-]{36}\)$/i, "");
const scalar = (raw: FrontmatterValue) => (Array.isArray(raw) ? raw[0] : raw);

type Column = { field: Field; hinted: boolean };
export function propertyColumns(
  pages: { properties?: Record<string, FrontmatterValue> }[],
  hints: PropertyHints | undefined,
  fixed: Field[],
  report?: ImportReport,
) {
  const columns = new Map<string, Column>();
  const skipped = new Set<string>();
  const taken = new Set(fixed.map((f) => foldName(f.name)));
  const usable = (raw: FrontmatterValue) => raw !== null && !(typeof raw === "object" && !Array.isArray(raw));
  for (const page of pages)
    for (const [key, raw] of Object.entries(page.properties || {})) {
      const folded = foldName(plainName(key));
      if (!folded || NOT_PROPERTIES.has(folded) || !usable(raw) || columns.has(folded) || skipped.has(folded)) continue;
      const hint = hints?.get(folded);
      const guessed = hint?.type ?? guessPropertyType(raw);
      // Created/updated by: the database has its own.
      if (isComputedProperty(guessed)) {
        skipped.add(folded);
        continue;
      }
      const base = cleanName(plainName(key), MAX_PROPERTY_NAME);
      if (fixed.length + columns.size >= MAX_DATABASE_FIELDS) {
        skipped.add(folded);
        report?.add(
          "property",
          ct(`Eigenschaft „${base}“ nicht als Spalte übernommen (höchstens ${MAX_DATABASE_FIELDS} Spalten)`, `Property “${base}” not carried over as a column (at most ${MAX_DATABASE_FIELDS} columns)`),
        );
        continue;
      }
      let name = base;
      for (let n = 2; taken.has(foldName(name)); n++) name = `${base} (${n})`;
      taken.add(foldName(name));
      const type: FieldType = FIELD_TYPES.has(guessed as FieldType) ? (guessed as FieldType) : "text";
      columns.set(folded, {
        field: { id: `imp_p${columns.size + 1}`, name, type, ...(type === "select" || type === "multiselect" ? { options: hint?.options?.slice(0, MAX_OPTIONS) ?? [] } : {}) },
        hinted: !!hint?.options,
      });
    }
  // Options the import did not decide: the values in first-seen order.
  const valuesOf = (column: Column, raw: FrontmatterValue): string[] =>
    (column.field.type === "multiselect" ? (Array.isArray(raw) ? raw : column.hinted ? [raw] : String(raw).split(",")) : [scalar(raw)])
      .filter((v) => v !== null && v !== undefined)
      .map((v) => cleanName(String(v), MAX_OPTION_LENGTH))
      .filter(Boolean);
  const tooMany = new Map<string, number>();
  for (const page of pages)
    for (const [key, raw] of Object.entries(page.properties || {})) {
      const column = columns.get(foldName(plainName(key)));
      if (!column?.field.options || column.hinted || !usable(raw)) continue;
      const options = column.field.options;
      for (const value of valuesOf(column, raw)) {
        if (options.some((o) => foldName(o) === foldName(value))) continue;
        if (options.length < MAX_OPTIONS) options.push(value);
        else tooMany.set(column.field.name, (tooMany.get(column.field.name) || 0) + 1);
      }
    }
  for (const [name, count] of tooMany)
    report?.add(
      "property",
      ct(`Eigenschaft „${name}“: ${count} Werte über ${MAX_OPTIONS} Optionen nicht übernommen`, `Property “${name}”: ${count} values beyond ${MAX_OPTIONS} options not carried over`),
    );
  // A note's cells; values that do not fit the column's type stay out.
  const cells = (page: { properties?: Record<string, FrontmatterValue> }) => {
    const out: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(page.properties || {})) {
      const column = columns.get(foldName(plainName(key)));
      if (!column || !usable(raw) || column.field.id in out) continue;
      const { field } = column;
      const option = (value: string) => field.options?.find((o) => foldName(o) === foldName(value));
      let value: unknown;
      if (field.type === "number") {
        const v = scalar(raw);
        const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v.trim().replace(",", ".")) : NaN;
        value = Number.isFinite(n) ? n : undefined;
      } else if (field.type === "checkbox") {
        const v = scalar(raw);
        value = typeof v === "boolean" ? v : /^(true|yes|ja|x|1)$/i.test(String(v));
      } else if (field.type === "date") {
        const v = scalar(raw);
        value = validDateValue(v) ? v : undefined;
      } else if (field.type === "select") value = option(valuesOf(column, raw)[0] ?? "");
      else if (field.type === "multiselect") {
        const list = [...new Set(valuesOf(column, raw).map(option).filter((v): v is string => !!v))];
        value = list.length ? list : undefined;
      } else value = (Array.isArray(raw) ? raw.map(String).join(", ") : String(raw)).slice(0, MAX_TEXT_VALUE) || undefined;
      if (value !== undefined) out[field.id] = value;
    }
    return out;
  };
  return { fields: [...columns.values()].map((c) => c.field), cells };
}
