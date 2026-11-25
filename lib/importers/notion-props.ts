// Notion database properties as Flowplan properties, for both ways in: the
// export (CSV cells, the property types from the HTML export's table) in
// lib/zip-import.ts, and the API (lib/importers/notion-api.ts).
//
// - title, text → text; number → number; select and status → select,
//   multi-select → multi-select (options with Notion's colours where known);
//   date → date (with time when Notion has one; a range keeps its start);
//   checkbox; URL, e-mail, phone; created and edited time → created/edited
//   time (the record's own timestamps); person, created by, edited by →
//   person when every name is a member of the workspace, else text.
// - relation → relation to the imported database whose records it names;
//   what it names outside the import goes into the import report.
// - rollup → rollup when the API names its relation, property and a
//   function Flowplan has; formula → formula when its expression reads in
//   Flowplan's formula language. Otherwise (and always from the export,
//   which only has the computed values) the values become text and the
//   property is listed in the report.
import { personCell } from "../person-values";
import { compileFormula } from "../formula";
import { importDate, inferField } from "../zip-import-fields";
import type { RollupAggregate } from "../rollups";
import { attr, byTag, children, find, findOne, hasClass, parseHtml } from "./html";
import { DomUtils } from "htmlparser2";
import type { Field } from "../types";

export type NotionType =
  | "title"
  | "rich_text"
  | "number"
  | "select"
  | "multi_select"
  | "status"
  | "date"
  | "people"
  | "files"
  | "checkbox"
  | "url"
  | "email"
  | "phone_number"
  | "formula"
  | "relation"
  | "rollup"
  | "created_time"
  | "created_by"
  | "last_edited_time"
  | "last_edited_by"
  | "unique_id";

// Notion names the types in its HTML export by icon class (typesSelect,
// typesMultipleSelect, …) and row class (property-row-multi_select); the
// API by name (multi_select). All of them, folded.
const TYPE_ALIASES: Record<string, NotionType> = {
  title: "title",
  text: "rich_text",
  richtext: "rich_text",
  number: "number",
  select: "select",
  multiselect: "multi_select",
  multipleselect: "multi_select",
  status: "status",
  date: "date",
  person: "people",
  people: "people",
  file: "files",
  files: "files",
  checkbox: "checkbox",
  url: "url",
  email: "email",
  phone: "phone_number",
  phonenumber: "phone_number",
  formula: "formula",
  relation: "relation",
  rollup: "rollup",
  createdat: "created_time",
  createdtime: "created_time",
  createdby: "created_by",
  updatedat: "last_edited_time",
  lastedited: "last_edited_time",
  lasteditedtime: "last_edited_time",
  updatedby: "last_edited_by",
  lasteditedby: "last_edited_by",
  uniqueid: "unique_id",
  id: "unique_id",
};
export const notionType = (raw: string | undefined | null): NotionType | undefined =>
  raw ? TYPE_ALIASES[raw.toLowerCase().replace(/[^a-z]/g, "")] : undefined;

// The property types an HTML export page names: the database's table
// (<table class="collection-content">, an icon <svg class="typesSelect"> in
// each <th>) and the properties above a record page (<table
// class="properties">, <tr class="property-row property-row-select">).
export function notionPropertyTypes(source: string, into = new Map<string, NotionType>()) {
  if (!source.includes("collection-content") && !source.includes("property-row")) return into;
  const doc = parseHtml(source);
  const clean = (el: Parameters<typeof DomUtils.textContent>[0]) => DomUtils.textContent(el).replace(/\s+/g, " ").trim();
  const set = (name: string, type: NotionType | undefined) => {
    if (name && type && !into.has(name)) into.set(name, type);
  };
  for (const table of find(doc.children, (e) => e.name === "table" && hasClass(e, "collection-content"))) {
    const thead = findOne(table, byTag("thead"));
    for (const th of thead ? find(thead, byTag("th")) : []) {
      const icon = findOne(th, (e) => /\btypes[A-Z]\w*/.test(attr(e, "class")));
      set(clean(th), notionType(/\btypes([A-Z]\w*)/.exec(icon ? attr(icon, "class") : "")?.[1]));
    }
  }
  for (const table of find(doc.children, (e) => e.name === "table" && hasClass(e, "properties")))
    for (const row of find(table, byTag("tr"))) {
      const type = /\bproperty-row-([a-z_]+)/.exec(attr(row, "class"))?.[1];
      const head = children(row).find((c) => c.name === "th");
      if (head) set(clean(head), notionType(type));
    }
  return into;
}

// A relation cell of Notion's CSV: "Title (Other%20DB/Title%20<id>.md),
// Other (https://www.notion.so/Other-<id>)" – or only the titles.
export type RelationItem = { title: string; href?: string };
const RELATION_ITEM = /\s*(.*?)\s*\(((?:https?:\/\/[^\s()]+)|(?:[^\s()]+\.(?:md|html?)))\)\s*(?:,|$)/gi;
export function relationItems(value: string): RelationItem[] {
  const text = value.trim();
  if (!text) return [];
  const items: RelationItem[] = [];
  let consumed = 0;
  for (const match of text.matchAll(RELATION_ITEM)) {
    if (match.index !== consumed || !match[0]) break;
    items.push({ title: match[1], href: match[2] });
    consumed = match.index + match[0].length;
  }
  if (items.length && consumed >= text.length) return items;
  return text.split(/,\s+/).map((title) => ({ title: title.trim() })).filter((i) => i.title);
}
const looksLikeRelation = (values: string[]) => {
  const filled = values.map((v) => v.trim()).filter(Boolean);
  return filled.length > 0 && filled.every((v) => relationItems(v).every((i) => i.href) && relationItems(v).length > 0);
};

// Notion's dates: "September 24, 2026", "September 24, 2026 10:15 AM",
// ISO, a range "A → B" (its start).
export function notionDate(value: string): string | null {
  const start = value.split(/\s+→\s+/)[0].trim();
  const day = importDate(start);
  if (!day) return null;
  const iso = /^\d{4}-\d{2}-\d{2}[T ](\d{2}):(\d{2})/.exec(start);
  const clock = iso ? [iso[1], iso[2], ""] : /\b(\d{1,2}):(\d{2})\s*(AM|PM)?\s*(?:\(|$|[A-Z]{2,5}\b|GMT)/i.exec(start.replace(/^[A-Za-z]+ \d{1,2}, \d{4}/, ""))?.slice(1);
  if (!clock) return day;
  let hour = Number(clock[0]);
  const pm = /pm/i.test(clock[2] || ""),
    am = /am/i.test(clock[2] || "");
  if (pm && hour < 12) hour += 12;
  if (am && hour === 12) hour = 0;
  if (hour > 23 || Number(clock[1]) > 59) return day;
  return `${day}T${String(hour).padStart(2, "0")}:${clock[1]}`;
}
// "1,234.5", "$12", "50%", "-3" → a number; null when it is none.
export function notionNumber(value: string): number | null {
  let text = value.replace(/[\s $€£¥%]/g, "").replace(/^(-?)[A-Za-z]{1,3}(?=\d)/, "$1");
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(text)) text = text.replaceAll(",", "");
  else if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(text)) text = text.replaceAll(".", "").replace(",", ".");
  else text = text.replace(",", ".");
  if (!/^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(text)) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}
const splitList = (value: string) => value.split(/,\s*/).map((v) => v.trim()).filter(Boolean);
// Multi-select values in a CSV ("a, b"), recognised without the HTML: few
// short values, repeated, some cells with several.
function looksLikeMultiselect(values: string[]) {
  const filled = values.map((v) => v.trim()).filter(Boolean);
  if (!filled.length || !filled.some((v) => v.includes(", "))) return false;
  const tokens = filled.flatMap(splitList);
  const distinct = new Set(tokens);
  return tokens.every((t) => t.length <= 60) && distinct.size <= 40 && tokens.length >= distinct.size * 2;
}
const URL_VALUE = /^https?:\/\/\S+$/i;
const EMAIL_VALUE = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

// How a CSV column of the export arrives: the property, how a cell turns
// into its value, and what it means for the record (relations wait for all
// records; created/edited time are the record's timestamps).
export type CsvColumn = {
  field: Field;
  notion?: NotionType;
  value: (raw: string) => unknown;
  relation?: boolean;
  timestamp?: "created" | "updated";
  // Kept, but not as Notion had it (formula, rollup, person as text, …).
  approximated?: "formula" | "rollup" | "property";
};
export function notionCsvColumns(
  header: string[],
  records: string[][],
  types: Map<string, NotionType>,
  member: (name: string) => string | undefined,
  escapeText: (value: string) => string,
): CsvColumn[] {
  return header.map((rawName, i) => {
    const name = (rawName || `Spalte ${i + 1}`).slice(0, 200);
    const values = records.map((r) => r[i] || "");
    const filled = values.map((v) => v.trim()).filter(Boolean);
    const fid = i === 0 ? "title" : `f${i}`;
    const text = (approximated?: CsvColumn["approximated"]): CsvColumn => ({
      field: { id: fid, name, type: "text" },
      value: (raw) => (raw.trim() ? (i === 0 ? raw.trim().slice(0, 10000) : escapeText(raw.trim().slice(0, 10000))) : null),
      ...(approximated ? { approximated } : {}),
    });
    if (i === 0) return { ...text(), notion: "title" as const };
    const notion = types.get(name);
    const options = (list: string[]) => [...new Set(list)].slice(0, 300);
    const as = (column: Omit<CsvColumn, "notion">): CsvColumn => ({ ...column, ...(notion ? { notion } : {}) });
    switch (notion) {
      case "number":
        return as({ field: { id: fid, name, type: "number" }, value: (raw) => notionNumber(raw) });
      case "select":
      case "status":
        return as({ field: { id: fid, name, type: "select", options: options(filled) }, value: (raw) => raw.trim().slice(0, 500) || null });
      case "multi_select":
        return as({ field: { id: fid, name, type: "multiselect", options: options(filled.flatMap(splitList)) }, value: (raw) => splitList(raw).map((v) => v.slice(0, 500)) });
      case "date":
        return as({ field: { id: fid, name, type: "date" }, value: (raw) => notionDate(raw) });
      case "checkbox":
        return as({ field: { id: fid, name, type: "checkbox" }, value: (raw) => /^(yes|ja|true|1|✓|checked)$/i.test(raw.trim()) });
      case "url":
        return as({ field: { id: fid, name, type: "url" }, value: (raw) => raw.trim().slice(0, 2000) || null });
      case "email":
        return as({ field: { id: fid, name, type: "email" }, value: (raw) => raw.trim().slice(0, 500) || null });
      case "phone_number":
        return as({ field: { id: fid, name, type: "phone" }, value: (raw) => raw.trim().slice(0, 100) || null });
      case "created_time":
      case "last_edited_time":
        return as({
          field: { id: fid, name, type: notion === "created_time" ? "created_at" : "updated_at" },
          value: (raw) => notionDate(raw),
          timestamp: notion === "created_time" ? "created" : "updated",
        });
      case "people":
      case "created_by":
      case "last_edited_by": {
        const names = filled.flatMap(splitList);
        // Several people in a record: "Mehrere Personen" on (#535); else one id.
        if (names.length && names.every((n) => member(n))) {
          const multiPerson = filled.some((raw) => new Set(splitList(raw)).size > 1);
          const field: Field = { id: fid, name, type: "person", ...(multiPerson ? { multiPerson: true } : {}) };
          return as({ field, value: (raw) => personCell(field, splitList(raw).map((n) => member(n)!)) });
        }
        return as(text("property"));
      }
      case "relation":
        return as({ field: { id: fid, name, type: "relation" }, value: (raw) => relationItems(raw), relation: true });
      case "formula":
        return as(text("formula"));
      case "rollup":
        return as(text("rollup"));
      case "files":
      case "unique_id":
      case "title":
      case "rich_text":
        return as(text(notion === "files" ? "property" : undefined));
    }
    // The Markdown export has no types: read from the values.
    if (looksLikeRelation(values)) return { field: { id: fid, name, type: "relation" }, value: (raw) => relationItems(raw), relation: true };
    if (filled.length && filled.every((v) => URL_VALUE.test(v))) return { field: { id: fid, name, type: "url" }, value: (raw) => raw.trim().slice(0, 2000) || null };
    if (filled.length && filled.every((v) => EMAIL_VALUE.test(v))) return { field: { id: fid, name, type: "email" }, value: (raw) => raw.trim().slice(0, 500) || null };
    if (looksLikeMultiselect(values))
      return { field: { id: fid, name, type: "multiselect", options: options(filled.flatMap(splitList)) }, value: (raw) => splitList(raw).map((v) => v.slice(0, 500)) };
    const inferred = inferField(name, values, i);
    switch (inferred.type) {
      case "number":
        return { field: inferred, value: (raw) => notionNumber(raw) };
      case "checkbox":
        return { field: inferred, value: (raw) => /^(yes|ja|true)$/i.test(raw.trim()) };
      case "date":
        return { field: inferred, value: (raw) => notionDate(raw) };
      case "select":
        return { field: inferred, value: (raw) => raw.trim().slice(0, 10000) || null };
    }
    return text();
  });
}

// Notion's rollup functions (API) → Flowplan's aggregates.
export const ROLLUP_FUNCTIONS: Record<string, RollupAggregate> = {
  count: "count",
  count_all: "count",
  count_values: "count_values",
  count_unique_values: "count_unique",
  unique: "count_unique",
  count_empty: "count_empty",
  empty: "count_empty",
  count_not_empty: "count_not_empty",
  not_empty: "count_not_empty",
  percent_empty: "percent_empty",
  percent_not_empty: "percent_not_empty",
  sum: "sum",
  average: "average",
  median: "median",
  min: "min",
  max: "max",
  range: "range",
  checked: "count_checked",
  count_checked: "count_checked",
  unchecked: "count_unchecked",
  count_unchecked: "count_unchecked",
  percent_checked: "percent_checked",
  percent_unchecked: "percent_unchecked",
  earliest_date: "earliest_date",
  latest_date: "latest_date",
  date_range: "date_range",
  show_original: "show_original",
  show_unique: "show_unique",
};

// A Notion formula in Flowplan's language, or null. Notion 2.0 writes
// property references as {{notion:block_property:<id>:…}} (the API's
// expression) or prop("Name"); Flowplan reads prop("Name") as well. Only
// what compiles in Flowplan counts (its functions, its operators – not
// Notion's methods such as .length()); `names` are the database's
// properties by Notion id.
export function notionFormula(expression: string, names: Map<string, string>): string | null {
  if (!expression || expression.length > 2000) return null;
  let unknown = false;
  const source = expression
    .replace(/\{\{notion:block_property:([^:}]+)(?::[^}]*)?\}\}/g, (_, id: string) => {
      let key = id;
      try {
        key = decodeURIComponent(id);
      } catch {}
      const name = names.get(key) ?? names.get(id);
      if (name === undefined) unknown = true;
      return `prop(${JSON.stringify(name ?? "")})`;
    });
  if (unknown || /\{\{|\}\}|\.\s*[a-zA-Z_]+\s*\(|=>|\[|\]|\?|:/.test(source)) return null;
  const compiled = compileFormula(source);
  return compiled.ok ? source : null;
}
