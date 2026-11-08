// The CSV of a database view ("Export → CSV (current view)") and the CSV
// import of a database (components/database-view.tsx). The export writes
// what the view shows: its visible properties in view order, and where a
// cell holds ids, the names people read in the table – people by name,
// related records by title, uploaded files by name, sprints by name. Other
// values stay as stored (numbers, ISO dates, true/false), so the import gives
// them back unchanged; it looks the names up again. Client-safe and pure.
import Papa from "papaparse";
import { CSV_FORMULA, cellText, csvListSplitter } from "./cell-text";
import { sqlTimestampToIso } from "./date-values";
import { isTimestampType } from "./field-format";
import { fileIdOf, fileUrls } from "./file-cells";
import { escapeInline, isFormattedText, toPlain } from "./inline-markdown";
import { foldName } from "./page-properties";
import type { Field, Row, View } from "./types";

export type CsvContext = {
  members?: readonly { id: string; name: string; email: string }[];
  // Records of linked databases by database id (relations), and their
  // properties (the first one is the title).
  related?: Record<string, readonly Pick<Row, "id" | "cells">[]>;
  relatedSchemas?: Record<string, readonly Pick<Field, "id">[]>;
  files?: readonly { url: string; name: string }[];
  sprints?: readonly { id: string; name: string }[];
  untitled: string;
  unavailable: string;
};

const list = (value: unknown) => (Array.isArray(value) ? value : value === null || value === undefined || value === "" ? [] : [value]);

// The columns of the view: the visible properties in view order. Boards,
// lists, calendars and the other card views always show the title, so it
// stays in their CSV even when it is hidden among the card properties.
export function viewCsvFields(view: Pick<View, "type">, fields: Field[], visibleFields: Field[]) {
  const title = fields[0];
  return view.type === "table" || !title || visibleFields.includes(title) ? visibleFields : [title, ...visibleFields];
}

const recordTitle = (ctx: CsvContext, database: string, row: Pick<Row, "cells">) =>
  cellText(row.cells[ctx.relatedSchemas?.[database]?.[0]?.id || "title"]).trim();

// What the names in one column stand for, shared by the export and the import:
// a name stands for exactly one id; a name used twice stands for none, so an
// import never links the wrong person, record or file. The placeholders
// stand for nobody: "Not available" never, "Untitled" not while an untitled
// record could be meant. The ids themselves (older exports) still match.
type Lookup = { split: (text: string) => string[]; ids: Map<string, string | null>; known: Set<string> };
function lookup(entries: [string, string][], placeholders: string[]): Lookup {
  const ids = new Map<string, string | null>();
  for (const [name, id] of entries) {
    const key = foldName(name);
    if (key) ids.set(key, ids.has(key) && ids.get(key) !== id ? null : id);
  }
  for (const p of placeholders) ids.set(foldName(p), null);
  return { split: csvListSplitter(entries.map(([name]) => name)), ids, known: new Set(entries.map(([, id]) => id)) };
}
const found = (l: Lookup, name: string) => (l.known.has(name) ? name : l.ids.get(foldName(name)) || undefined);
// The first label that the import reads back as `id`: people by name, else
// by e-mail; records, files and sprints by name. A name that is not unique
// (two records "Meeting", an untitled record) is still written as the table
// shows it, never as an id (#174): the import then links nothing for it.
const label = (l: Lookup, names: string[], fallback: string) => {
  const shown = names.map((n) => n.trim()).filter(Boolean);
  return (id: string) => shown.find((n) => found(l, n) === id) ?? shown[0] ?? fallback;
};

const peopleLookup = (ctx: CsvContext) =>
  lookup((ctx.members || []).flatMap((m): [string, string][] => [[m.name, m.id], [m.email, m.id]]), [ctx.unavailable]);
function recordsLookup(ctx: CsvContext, database: string) {
  const records = ctx.related?.[database] || [];
  const entries = records.map((r): [string, string] => [recordTitle(ctx, database, r), r.id]);
  return lookup(entries, entries.some(([title]) => !title) ? [ctx.unavailable, ctx.untitled] : [ctx.unavailable]);
}
const filesLookup = (ctx: CsvContext) => lookup((ctx.files || []).map((f) => [f.name, f.url]), [ctx.unavailable]);
const sprintsLookup = (ctx: CsvContext) => lookup((ctx.sprints || []).map((s) => [s.name, s.id]), [ctx.unavailable]);

// A files cell: links first, which end at a space, so a comma inside a link
// stays in it; the text between them is file names.
function filesSplitter(split: (text: string) => string[]) {
  return (text: string) => {
    const values: string[] = [];
    let last = 0;
    for (const m of text.matchAll(/(?:^|,)\s*(https?:\/\/\S+?)(?=,?(?:\s|$))/gi)) {
      values.push(...split(text.slice(last, m.index)), m[1]);
      last = m.index + m[0].length;
    }
    return [...values, ...split(text.slice(last))];
  };
}

// The CSV text of `rows` with the columns `fields` (from viewCsvFields).
// Text a spreadsheet would run as a formula gets an apostrophe (CSV_FORMULA).
export function databaseCsv(fields: Field[], allFields: Field[], rows: Pick<Row, "cells">[], ctx: CsvContext) {
  const people = peopleLookup(ctx),
    files = filesLookup(ctx),
    sprints = sprintsLookup(ctx);
  // Labels by id, worked out once per column.
  const labels = (l: Lookup, items: [string, string[]][], fallback = ctx.unavailable) =>
    new Map(items.map(([id, names]) => [id, label(l, names, fallback)(id)]));
  const personLabels = labels(people, (ctx.members || []).map((m) => [m.id, [m.name, m.email]]));
  const fileLabels = labels(files, (ctx.files || []).map((f) => [f.url, [f.name]]));
  const sprintLabels = labels(sprints, (ctx.sprints || []).map((s) => [s.id, [s.name]]));
  const titles = new Map(
    fields
      .filter((f) => f.type === "relation")
      .map((f) => {
        const target = f.relationPage || "";
        const records = recordsLookup(ctx, target);
        return [f.id, labels(records, (ctx.related?.[target] || []).map((r) => [r.id, [recordTitle(ctx, target, r)]]), ctx.untitled)];
      }),
  );
  const ids = (value: unknown, names: ReadonlyMap<string, string> | undefined) =>
    list(value)
      .map((id) => names?.get(String(id)) || ctx.unavailable)
      .join(", ");
  const cell = (field: Field, value: unknown): string => {
    // Formatted text (#126) as plain text.
    if (isFormattedText(field, allFields)) return toPlain(cellText(value));
    switch (field.type) {
      case "person":
      case "created_by":
      case "updated_by":
        return ids(value, personLabels);
      case "relation":
        return ids(value, titles.get(field.id));
      // Uploaded files by name, links as they are.
      case "files":
        return fileUrls(value)
          .map((url) => (fileIdOf(url) ? fileLabels.get(url) || ctx.unavailable : url))
          .join(", ");
      case "sprint":
        return ids(value, sprintLabels);
    }
    // Created and edited time as ISO 8601 instants, like dates with time.
    if (isTimestampType(field.type)) return cellText(sqlTimestampToIso(value));
    return cellText(value);
  };
  return Papa.unparse(
    {
      fields: fields.map((f) => f.name),
      data: rows.map((r) => fields.map((f) => cell(f, r.cells[f.id]))),
    },
    { escapeFormulae: CSV_FORMULA },
  );
}

// The CSV import: a function from one CSV row (parsed with csvImportText) to
// the cells of `fields`, the writable properties that have a column in the
// file; properties without a column (hidden in the exported view) are left
// out. Names are looked up once per file.
export function csvImporter(fields: Field[], allFields: Field[], ctx: CsvContext) {
  const people = peopleLookup(ctx),
    sprints = sprintsLookup(ctx);
  // Per property: the names (csvListSplitter keeps a name with a comma whole)
  // and what each stands for.
  const lookups = new Map(
    fields
      .filter((f) => ["person", "relation", "files", "sprint"].includes(f.type))
      .map((f) => {
        if (f.type !== "files")
          return [f.id, f.type === "person" ? people : f.type === "sprint" ? sprints : recordsLookup(ctx, f.relationPage || "")] as const;
        const files = filesLookup(ctx);
        return [f.id, { ...files, split: filesSplitter(files.split) }] as const;
      }),
  );
  const lists = new Map(
    fields
      .filter((f) => f.type === "multiselect" || f.type === "aliases")
      .map((f) => [f.id, csvListSplitter(f.type === "multiselect" ? f.options : [])]),
  );
  const resolve = (f: Field, text: string) => {
    const l = lookups.get(f.id)!;
    const values = f.type === "sprint" ? [text.trim()] : l.split(text);
    return [
      ...new Set(
        values
          .map((v) => (f.type === "files" && /^https?:\/\/\S+$/i.test(v) ? v : found(l, v)))
          .filter((v): v is string => !!v),
      ),
    ];
  };
  return (row: Record<string, string>) =>
    Object.fromEntries(
      fields.map((f) => {
        const text = row[f.name] || "";
        switch (f.type) {
          case "number":
            return [f.id, Number(text || 0)];
          case "checkbox":
            return [f.id, ["true", "1", "ja"].includes(text.toLowerCase())];
          case "multiselect":
          case "aliases":
            return [f.id, lists.get(f.id)!(text)];
          // People by name or e-mail, records by title, files by name (or as
          // links), sprints by name; ids from older exports still match.
          case "person":
          case "sprint":
            return [f.id, resolve(f, text)[0] || ""];
          case "relation":
            return [f.id, f.parent ? resolve(f, text).slice(0, 1) : resolve(f, text)];
          case "files":
            return [f.id, resolve(f, text)];
        }
        // A CSV is plain text: formatted text (#126) keeps "*" and "_" as written.
        return [f.id, isFormattedText(f, allFields) ? escapeInline(text) : text];
      }),
    );
}
