// Placeholders in record templates: "{{Firma}}" in the title, the headings
// or the text of a template becomes the record's value of that property
// when the template is applied; "{{Heute}}", "{{Titel}}" … are built in.
// Names match without regard to case. A template stores the properties it
// names by id ("{{field:abc}}"), so renaming a property keeps it working;
// a template opened for editing shows the current names again.
//
// Only text changes: in HTML just the text between tags, with the value
// escaped – a value never becomes markup. Pure and client-safe; the server
// side (values of a record, applying a template) is in
// lib/record-template-apply.ts.
import { cellText } from "./cell-text";
import { isTimed, localValue, validDateValue, Temporal } from "./date-values";
import { formatNumber } from "./field-format";
import type { Field } from "./types";

// "{{ Name }}": up to 120 characters, no braces, angle brackets or breaks.
const PATTERN = /\{\{\s*([^{}<>\n]{1,120}?)\s*\}\}/g;
export const FIELD_PREFIX = "field:";

export type Builtin = "title" | "today" | "now" | "creator" | "me" | "database";
// Every name a built-in answers to (German, English, French).
const BUILTIN_NAMES: Record<string, Builtin> = {
  title: "title",
  titel: "title",
  titre: "title",
  date: "today",
  datum: "today",
  today: "today",
  heute: "today",
  "aujourd’hui": "today",
  "aujourd'hui": "today",
  now: "now",
  jetzt: "now",
  maintenant: "now",
  creator: "creator",
  ersteller: "creator",
  erstellerin: "creator",
  "créateur": "creator",
  me: "me",
  ich: "me",
  moi: "me",
  database: "database",
  datenbank: "database",
  "base de données": "database",
};
// The built-ins as the template editor offers them, in each language.
export const BUILTINS: { key: Builtin; token: { de: string; en: string; fr: string } }[] = [
  { key: "title", token: { de: "Titel", en: "Title", fr: "Titre" } },
  { key: "today", token: { de: "Heute", en: "Today", fr: "Aujourd’hui" } },
  { key: "now", token: { de: "Jetzt", en: "Now", fr: "Maintenant" } },
  { key: "creator", token: { de: "Ersteller", en: "Creator", fr: "Créateur" } },
  { key: "me", token: { de: "Ich", en: "Me", fr: "Moi" } },
  { key: "database", token: { de: "Datenbank", en: "Database", fr: "Base de données" } },
];

const norm = (s: string) => s.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();

export type PlaceholderTarget = { field: Field } | { builtin: Builtin } | { gone: true };

// What a key stands for: a property by stored id, a property by name, a
// built-in, a property by id – in that order. Null: not a placeholder
// (the text stays as written).
export function placeholderTarget(raw: string, fields: Field[]): PlaceholderTarget | null {
  const key = raw.trim();
  if (key.startsWith(FIELD_PREFIX)) {
    const field = fields.find((f) => f.id === key.slice(FIELD_PREFIX.length));
    // A property deleted since: its placeholder becomes empty.
    return field ? { field } : { gone: true };
  }
  const name = norm(key);
  const byName = fields.find((f) => norm(f.name) === name);
  if (byName) return { field: byName };
  const builtin = BUILTIN_NAMES[name];
  if (builtin) return { builtin };
  const byId = fields.find((f) => f.id === key);
  return byId ? { field: byId } : null;
}

// Replaces every "{{…}}" in plain text; `replace` returns the new text of a
// placeholder or undefined to keep it.
export function mapPlaceholders(text: string, replace: (key: string) => string | undefined) {
  return text.replace(PATTERN, (whole, key: string) => replace(key) ?? whole);
}

const decode = (s: string) =>
  s
    .replace(/&nbsp;|&#160;|&#xa0;/gi, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;|&apos;/gi, "'")
    .replace(/&amp;/g, "&");
export const escapeText = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
// Tags (attribute values in quotes may hold ">") and comments.
const TAG = /(<!--[\s\S]*?-->|<(?:[^>"']|"[^"]*"|'[^']*')*>)/;

// The same in HTML: only text between tags changes; keys are read decoded
// and what comes back is plain text, escaped here.
export function mapHtmlPlaceholders(html: string, replace: (key: string) => string | undefined) {
  if (!html.includes("{{")) return html;
  return html
    .split(TAG)
    .map((part, i) =>
      i % 2 === 1 || !part.includes("{{")
        ? part
        : part.replace(PATTERN, (whole, key: string) => {
            const value = replace(decode(key));
            return value === undefined ? whole : escapeText(value);
          }),
    )
    .join("");
}

// Saving a template: property names become ids …
export function storeKey(key: string, fields: Field[]) {
  const target = placeholderTarget(key, fields);
  return target && "field" in target ? `{{${FIELD_PREFIX}${target.field.id}}}` : undefined;
}
// … and editing it shows the current names.
export function showKey(key: string, fields: Field[]) {
  if (!key.startsWith(FIELD_PREFIX)) return undefined;
  const field = fields.find((f) => f.id === key.slice(FIELD_PREFIX.length));
  return field ? `{{${field.name}}}` : undefined;
}
// Text property values of a template (cells), the same way.
export function mapTextCells(cells: Record<string, unknown>, fields: Field[], map: (text: string) => string) {
  const next = { ...cells };
  for (const f of fields)
    if (f.type === "text" && typeof next[f.id] === "string" && (next[f.id] as string).includes("{{"))
      next[f.id] = map(next[f.id] as string);
  return next;
}

/* ---------- Values as text ---------- */

export type PlaceholderFormat = {
  // Language tag for dates and numbers (de-DE, en-GB …).
  tag: string;
  zone: string;
  person?: (id: string) => string;
  // Titles of related records (those the person may see).
  relation?: (field: Field, ids: string[]) => string[];
  file?: (url: string) => string;
};

// A date (or date and time) in the reader's language and the property's
// date style, without the UTC note of the table cells.
export function placeholderDate(value: unknown, fmt: PlaceholderFormat, style = "") {
  let v = typeof value === "string" ? value : "";
  // SQLite timestamps (created/edited): "2026-03-01 08:00:00" in UTC.
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(v)) v = v.replace(" ", "T") + "Z";
  if (!validDateValue(v)) return cellText(value);
  let local = v;
  try {
    local = localValue(v, fmt.zone);
  } catch {
    local = v.replace(/(?:Z|[+-]\d{2}:\d{2})$/, "");
  }
  const day = Temporal.PlainDate.from(local.slice(0, 10));
  const pad = (n: number, size = 2) => String(n).padStart(size, "0");
  const date =
    style === "iso"
      ? day.toString()
      : style === "eu"
        ? `${pad(day.day)}.${pad(day.month)}.${pad(day.year, 4)}`
        : style === "us"
          ? `${pad(day.month)}/${pad(day.day)}/${pad(day.year, 4)}`
          : day.toLocaleString(fmt.tag, { day: "numeric", month: style === "long" ? "long" : "short", year: "numeric" });
  return isTimed(v) ? `${date}, ${local.slice(11, 16)}` : date;
}

const list = (value: unknown) => (Array.isArray(value) ? value : value === undefined || value === null || value === "" ? [] : [value]);

// A property value as the text a placeholder becomes; empty stays empty.
export function placeholderValue(field: Field, value: unknown, fmt: PlaceholderFormat): string {
  if (field.type === "checkbox") return value === true || value === "true" ? "✓" : "✗";
  if (value === undefined || value === null || value === "" || (Array.isArray(value) && !value.length)) return "";
  switch (field.type) {
    case "person":
    case "created_by":
    case "updated_by":
      return list(value)
        .map((v) => (fmt.person ? fmt.person(String(v)) : String(v)))
        .filter(Boolean)
        .join(", ");
    case "relation":
      return fmt.relation ? fmt.relation(field, list(value).map(String)).join(", ") : "";
    case "date":
    case "created_at":
    case "updated_at":
      return placeholderDate(value, fmt, field.format || "");
    case "checklist":
      return list(value)
        .map((item) => (item && typeof item === "object" ? String((item as { text?: string }).text || "") : String(item)))
        .filter(Boolean)
        .join(", ");
    case "files":
      return list(value)
        .map((url) => (fmt.file ? fmt.file(String(url)) : String(url)))
        .filter(Boolean)
        .join(", ");
    case "time":
      return typeof value === "number" ? `${Math.round((value / 3600) * 10) / 10} h` : "";
    default:
      break;
  }
  if (typeof value === "number")
    return field.type === "number" || field.type === "formula" || field.type === "rollup"
      ? formatNumber(value, field.format, field.decimals, fmt.tag)
      : String(value);
  if (typeof value === "boolean") return value ? "✓" : "✗";
  if (Array.isArray(value)) return value.map((v) => (typeof v === "object" ? "" : String(v))).filter(Boolean).join(", ");
  if (typeof value === "object") return "";
  return String(value);
}
