// The type of a page property that a frontmatter key becomes (#70, #598).
// One value at a time (guessPropertyType, the Markdown import and the Git
// sync), or – for an Obsidian vault – once for the whole vault
// (inferPropertyTypes): Obsidian's own type registry `.obsidian/types.json`
// first, else what the values of all notes have in common. Pure, so the
// tests call it without a database.
import { validDateValue } from "./date-values";
import type { FrontmatterValue } from "./frontmatter";
import { cleanName, foldName, MAX_OPTION_LENGTH, MAX_OPTIONS, type PagePropertyType } from "./page-properties";

// A single value's type: booleans, numbers, lists, dates, links and
// e-mail addresses; any other text is text.
export function guessPropertyType(raw: unknown): PagePropertyType {
  if (typeof raw === "boolean") return "checkbox";
  if (typeof raw === "number") return "number";
  if (Array.isArray(raw)) return "multiselect";
  const text = String(raw);
  if (validDateValue(text)) return "date";
  if (/^https?:\/\/\S+$/i.test(text)) return "url";
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) return "email";
  return "text";
}

// What the whole import decided for a property, by its folded name: the
// type, and for select/multiselect every value of the vault as options, in
// the order the notes (sorted by path) first use them – the order the
// person meets them in, not an alphabet that would mix up e.g. "todo,
// doing, done".
export type PropertyHint = { type: PagePropertyType; options?: string[] };
export type PropertyHints = Map<string, PropertyHint>;

// A select is only inferred for a small closed set of values:
// - at most SELECT_MAX_OPTIONS distinct values (a status, a category –
//   more is rather free text),
// - each of them used by at least SELECT_MIN_USES notes (a value only one
//   note has is no category yet),
// - every value short (at most MAX_CHOICE_LENGTH characters), on one line,
//   without links and without sentence punctuation (". ", "! ", "? ").
export const SELECT_MAX_OPTIONS = 12,
  SELECT_MIN_USES = 2,
  // Also the limit for an item of a list that becomes a multi-select.
  MAX_CHOICE_LENGTH = 60;

// A value that may become an option as it is: short, one line, no
// [[wiki link]], Markdown link or URL, and exactly what an option keeps
// (cleanName does not change it: no surrounding or repeated spaces).
function choice(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return null;
  const text = String(value);
  if (!text || text.length > MAX_CHOICE_LENGTH || text.length > MAX_OPTION_LENGTH || /[\r\n]/.test(text)) return null;
  if (/\[\[|\]\(|:\/\//.test(text)) return null;
  return cleanName(text, MAX_OPTION_LENGTH) === text ? text : null;
}
// The distinct values in first-seen order, or null when one of them cannot
// be an option or two differ only in case (an option matches values case
// blind: "Done" and "done" would both be stored as the first).
function options(values: unknown[], max: number): string[] | null {
  const out: string[] = [],
    seen = new Map<string, string>();
  for (const value of values) {
    const text = choice(value);
    if (text === null) return null;
    const key = foldName(text),
      known = seen.get(key);
    if (known === undefined) {
      seen.set(key, text);
      out.push(text);
      if (out.length > max) return null;
    } else if (known !== text) return null;
  }
  return out;
}
const items = (raw: FrontmatterValue) => (Array.isArray(raw) ? raw : [raw]);

// A list on any note: a multi-select, its options every item of the vault.
function multiselect(values: FrontmatterValue[]): PropertyHint {
  const list = options(values.flatMap(items), MAX_OPTIONS);
  return list ? { type: "multiselect", options: list } : { type: "text" };
}

// Obsidian's property types (.obsidian/types.json, {"types": {name: type}})
// as ours. "aliases" and "tags" have no entry here: the importer already
// reads the keys aliases/tags as the page's aliases and tags.
const OBSIDIAN_TYPES: Record<string, PagePropertyType> = {
  text: "text",
  multitext: "multiselect",
  number: "number",
  checkbox: "checkbox",
  date: "date",
  // A date with time: our date type keeps the time ("2026-01-02T10:30").
  datetime: "date",
};
export function obsidianTypes(source: string | undefined): Map<string, PagePropertyType> {
  const out = new Map<string, PagePropertyType>();
  if (!source) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return out;
  }
  const types = parsed && typeof parsed === "object" && "types" in parsed ? (parsed as { types: unknown }).types : parsed;
  if (!types || typeof types !== "object" || Array.isArray(types)) return out;
  for (const [name, type] of Object.entries(types))
    if (typeof type === "string" && Object.hasOwn(OBSIDIAN_TYPES, type)) out.set(foldName(name), OBSIDIAN_TYPES[type]);
  return out;
}

// Whether every value fits the type Obsidian registered; one that does not
// (a word in a number property) leaves the decision to the values.
function fits(type: PagePropertyType, values: FrontmatterValue[]) {
  switch (type) {
    case "number":
      return values.every((v) => typeof v === "number" || (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v.replace(",", ".")))));
    case "checkbox":
      return values.every((v) => typeof v === "boolean" || (typeof v === "string" && /^(true|false)$/i.test(v.trim())));
    case "date":
      return values.every((v) => validDateValue(v));
    default:
      return true;
  }
}

// The property types of a whole vault: `notes` are the frontmatters of its
// notes in import order, `registry` Obsidian's types (obsidianTypes). Keys
// whose type the values already show one by one (numbers, checkboxes,
// dates, links, e-mail addresses – the same on every note) get no hint.
export function inferPropertyTypes(notes: Record<string, FrontmatterValue>[], registry = new Map<string, PagePropertyType>()): PropertyHints {
  const values = new Map<string, FrontmatterValue[]>();
  for (const data of notes)
    for (const [key, raw] of Object.entries(data)) {
      if (raw === null || (typeof raw === "object" && !Array.isArray(raw))) continue;
      // "Name (id)" as the export writes a name that clashes.
      const name = foldName(key.replace(/ \([0-9a-f-]{36}\)$/i, ""));
      const list = values.get(name);
      if (list) list.push(raw);
      else values.set(name, [raw]);
    }
  const hints: PropertyHints = new Map();
  for (const [name, list] of values) {
    const registered = registry.get(name);
    if (registered === "multiselect") hints.set(name, multiselect(list));
    else if (registered && fits(registered, list)) hints.set(name, { type: registered });
    else {
      const hint = inferred(list);
      if (hint) hints.set(name, hint);
    }
  }
  return hints;
}

function inferred(list: FrontmatterValue[]): PropertyHint | null {
  if (list.some(Array.isArray)) return multiselect(list);
  const types = new Set(list.map(guessPropertyType));
  // Mixed (a number on one note, a word on the next): text keeps them all.
  if (types.size > 1) return { type: "text" };
  if (!types.has("text")) return null;
  const set = options(list, SELECT_MAX_OPTIONS);
  if (!set || list.some((v) => /[.!?]\s/.test(String(v)))) return { type: "text" };
  const uses = new Map<string, number>();
  for (const v of list) uses.set(foldName(String(v)), (uses.get(foldName(String(v))) || 0) + 1);
  return [...uses.values()].every((n) => n >= SELECT_MIN_USES) ? { type: "select", options: set } : { type: "text" };
}
