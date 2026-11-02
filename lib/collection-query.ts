// The search language of the search and of collections (issue #86), the
// part shared by the server and the browser: parsing a query into a tree,
// writing a tree back as text, the visual filter builder's view of it and
// the date ranges.
//
//   words              full text; words next to each other form a phrase
//   "some words"       a phrase
//   #tag  #"two words" pages and records with the tag (#70, #79)
//   Name:value         a page property (lib/page-properties.ts: contains,
//                      equals an option, >, <, >=, <=, a..b, *, -)
//   created_by:anna    who created it (a name, or `me`); also creator:
//   updated_by:me      who changed it last; also editor:
//   created:-7d        when it was created: -7d, -2w, -3m, -1y (the last
//   updated:this-week  N days/weeks/months/years including today), today,
//                      yesterday, this-week, last-week, this-month,
//                      last-month, this-year, last-year, 2026, 2026-03,
//                      2026-03-01, >2026-01-01, <=-30d, 2026-01-01..2026-02-01
//   type:document      document, database, whiteboard, record (also
//                      notebook, journal, dashboard); type:a|b for either
//   in:"Space name"    in that space
//   title:offer        the title contains it
//
// Operators, from the tightest: NOT (or - directly before a term or a
// group), AND (also implicit: terms next to each other), OR (or |).
// Parentheses group. `a b OR c` is `(a AND b) OR c`. Key names are English
// and ignore case; a property with the same name as a key is written with
// its name in quotes ("Type":Book). Everything that is not one of these
// stays a search word, as before (an unknown #tag or name:value too).
import { relativeCellDay, relativeDateWindow } from "./relative-dates";

export type CondType = "text" | "title" | "tag" | "prop" | "creator" | "editor" | "created" | "updated" | "type" | "in";
export type Cond = {
  type: CondType;
  value: string;
  // prop: the property's name.
  name?: string;
  // prop: the value was written in quotes and that changes its meaning
  // (`Name:""` is empty, `Name:"*"` the text *).
  quoted?: boolean;
  not?: boolean;
};
export type Group = { type: "and" | "or"; items: QueryNode[]; not?: boolean };
export type QueryNode = Cond | Group;
export type ParsedQuery = { node: QueryNode | null; errors: string[] };

export const isGroup = (node: QueryNode): node is Group => node.type === "and" || node.type === "or";

// Key → condition; the first spelling is the one written back.
const KEYS: Record<string, Exclude<CondType, "text" | "tag" | "prop">> = {
  created_by: "creator",
  creator: "creator",
  updated_by: "editor",
  editor: "editor",
  created: "created",
  updated: "updated",
  type: "type",
  in: "in",
  title: "title",
};
const KEY_OF: Record<string, string> = { creator: "created_by", editor: "updated_by", created: "created", updated: "updated", type: "type", in: "in", title: "title" };
export const isReservedKey = (name: string) => Object.hasOwn(KEYS, name.toLowerCase());

export const ITEM_TYPES = ["document", "database", "whiteboard", "record", "notebook", "journal", "dashboard"] as const;
export type ItemType = (typeof ITEM_TYPES)[number];
// Other spellings of type: values.
const TYPE_ALIASES: Record<string, ItemType> = { row: "record", records: "record", page: "document", doc: "document", documents: "document", board: "whiteboard" };
export const itemTypeOf = (value: string): ItemType | null => {
  const v = value.trim().toLowerCase();
  return (ITEM_TYPES as readonly string[]).includes(v) ? (v as ItemType) : (TYPE_ALIASES[v] ?? null);
};

// ---- Tokens ----

type Token =
  | { k: "(" | ")" | "or" | "and" | "not" }
  // A term; `word` marks a bare word (joins its neighbours into a phrase).
  | { k: "term"; node: QueryNode; word?: boolean };

const KEY = /^([\p{L}\p{N}_][\p{L}\p{N}_.-]*):/u;

function keyNode(key: string, keyQuoted: boolean, value: string, valueQuoted: boolean): QueryNode | null {
  // `key:a|b` is either of them.
  if (!valueQuoted && value.includes("|")) {
    const parts = value.split("|").filter(Boolean);
    if (parts.length > 1) {
      const items = parts.map((part) => keyNode(key, keyQuoted, part, false)).filter((n): n is QueryNode => !!n);
      return items.length > 1 ? { type: "or", items } : (items[0] ?? null);
    }
    value = parts[0] ?? "";
  }
  const reserved = !keyQuoted ? KEYS[key.toLowerCase()] : undefined;
  if (reserved) {
    const v = value.trim();
    if (!v) return null;
    return { type: reserved, value: reserved === "type" ? v.toLowerCase() : v };
  }
  const meaningful = valueQuoted && (value === "" || value === "*" || value === "-");
  return { type: "prop", name: key, value, ...(meaningful ? { quoted: true } : {}) };
}

function tokenize(input: string): Token[] {
  const s = input.replace(/[\u0000-\u001f]/g, " ").slice(0, 2000);
  const out: Token[] = [];
  const quoted = (from: number) => {
    // From an opening quote: the text up to the closing one (or the end).
    const end = s.indexOf('"', from + 1);
    return end < 0 ? { text: s.slice(from + 1), next: s.length } : { text: s.slice(from + 1, end), next: end + 1 };
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "(" || c === ")") {
      out.push({ k: c });
      i++;
      continue;
    }
    if (c === "|") {
      while (s[i] === "|") i++;
      out.push({ k: "or" });
      continue;
    }
    const next = s[i + 1];
    if (c === "-" && next !== undefined && !/[\s\d)|-]/.test(next)) {
      out.push({ k: "not" });
      i++;
      continue;
    }
    if (c === "#") {
      if (next === '"') {
        const q = quoted(i + 1);
        i = q.next;
        const name = q.text.trim().slice(0, 200);
        if (name) out.push({ k: "term", node: { type: "tag", value: name } });
        continue;
      }
      let j = i + 1;
      while (j < s.length && !/[\s"#()|]/.test(s[j])) j++;
      // A trailing comma or full stop belongs to the sentence.
      const name = s.slice(i + 1, j).replace(/[.,;:!?]+$/, "");
      i = j;
      out.push({ k: "term", node: name ? { type: "tag", value: name } : { type: "text", value: "#" }, word: !name });
      continue;
    }
    if (c === '"') {
      const q = quoted(i);
      i = q.next;
      if (s[i] === ":") {
        // "Long name":value
        i++;
        let value: string, valueQuoted = false;
        if (s[i] === '"') {
          const v = quoted(i);
          value = v.text;
          valueQuoted = true;
          i = v.next;
        } else {
          let j = i;
          while (j < s.length && !/[\s()]/.test(s[j])) j++;
          value = s.slice(i, j);
          i = j;
        }
        const node = q.text.trim() ? keyNode(q.text.trim(), true, value, valueQuoted) : null;
        if (node) out.push({ k: "term", node });
        continue;
      }
      const text = q.text.replace(/\s+/g, " ").trim();
      if (text) out.push({ k: "term", node: { type: "text", value: text } });
      continue;
    }
    const key = KEY.exec(s.slice(i));
    if (key) {
      i += key[0].length;
      let value: string, valueQuoted = false;
      if (s[i] === '"') {
        const v = quoted(i);
        value = v.text;
        valueQuoted = true;
        i = v.next;
      } else {
        let j = i;
        while (j < s.length && !/[\s()]/.test(s[j])) j++;
        value = s.slice(i, j);
        i = j;
      }
      const node = keyNode(key[1], false, value, valueQuoted);
      if (node) out.push({ k: "term", node });
      continue;
    }
    let j = i;
    while (j < s.length && !/[\s()|"]/.test(s[j])) j++;
    if (j === i) j = i + 1;
    const word = s.slice(i, j);
    i = j;
    if (word === "OR") out.push({ k: "or" });
    else if (word === "AND") out.push({ k: "and" });
    else if (word === "NOT") out.push({ k: "not" });
    else out.push({ k: "term", node: { type: "text", value: word }, word: true });
  }
  return out;
}

// ---- Parsing ----

const negate = (node: QueryNode): QueryNode => ({ ...node, not: !node.not || undefined }) as QueryNode;

// Groups of one become their item; a group in a group of the same kind
// (without NOT) is merged into it.
function simplify(node: QueryNode): QueryNode {
  if (!isGroup(node)) {
    const out = { ...node };
    if (!out.not) delete out.not;
    return out;
  }
  const items = node.items.map(simplify).flatMap((item) => (isGroup(item) && item.type === node.type && !item.not ? item.items : [item]));
  if (items.length === 1) return node.not ? negate(items[0]) : items[0];
  return node.not ? { type: node.type, items, not: true } : { type: node.type, items };
}

export function parseQuery(input: string): ParsedQuery {
  const tokens = tokenize(input);
  const errors: string[] = [];
  let at = 0;
  const peek = () => tokens[at];
  function unary(): QueryNode | null {
    const t = peek();
    if (!t) return null;
    if (t.k === "not") {
      at++;
      const inner = unary();
      if (!inner) {
        errors.push("not");
        return null;
      }
      return negate(inner);
    }
    if (t.k === "(") {
      at++;
      const inner = or();
      if (peek()?.k === ")") at++;
      else errors.push("close");
      if (!inner) errors.push("empty");
      return inner;
    }
    if (t.k === "term") {
      at++;
      return t.node;
    }
    return null;
  }
  function and(): QueryNode | null {
    const items: QueryNode[] = [];
    // Bare words directly after each other form one phrase.
    let lastWord: { node: QueryNode; joinable: boolean } | null = null;
    while (at < tokens.length) {
      const t = peek();
      if (t.k === ")" || t.k === "or") break;
      if (t.k === "and") {
        at++;
        if (!items.length) errors.push("and");
        lastWord = null;
        continue;
      }
      const word = t.k === "term" && !!t.word;
      const node = unary();
      if (!node) {
        // Only a stray operator gets here; skip it.
        if (at < tokens.length && peek() === t) at++;
        continue;
      }
      if (word && lastWord?.joinable && node.type === "text" && !node.not) {
        (lastWord.node as Cond).value += ` ${(node as Cond).value}`;
        continue;
      }
      items.push(node);
      lastWord = word && node.type === "text" && !node.not ? { node, joinable: true } : null;
    }
    if (!items.length) return null;
    return items.length === 1 ? items[0] : { type: "and", items };
  }
  function or(): QueryNode | null {
    const items: QueryNode[] = [];
    const first = and();
    if (first) items.push(first);
    while (peek()?.k === "or") {
      at++;
      const next = and();
      if (next) items.push(next);
      else errors.push("or");
    }
    if (!items.length) return null;
    return items.length === 1 ? items[0] : { type: "or", items };
  }
  const parts: QueryNode[] = [];
  while (at < tokens.length) {
    const node = or();
    if (node) parts.push(node);
    if (peek()?.k === ")") {
      errors.push("open");
      at++;
    }
  }
  const node = parts.length ? simplify(parts.length === 1 ? parts[0] : { type: "and", items: parts }) : null;
  // Copies, so the words joined above never change the tokens' nodes.
  return { node: node ? (JSON.parse(JSON.stringify(node)) as QueryNode) : null, errors: [...new Set(errors)] };
}

// ---- Writing back ----

const SPECIAL = /[():"|#]|^-|\s-|(^|\s)(OR|AND|NOT)(\s|$)/;
const clean = (value: string) => value.replace(/"/g, "").replace(/\s+/g, " ").trim();
function quoteIf(value: string, force = false) {
  const v = value.replace(/"/g, "");
  return force || v === "" || /[\s()"|]/.test(v) ? `"${v}"` : v;
}
function condText(c: Cond): string {
  const not = c.not ? "-" : "";
  switch (c.type) {
    case "text": {
      const v = clean(c.value);
      // A NOT before several words, or words that would read as
      // something else, take quotes.
      return not + (SPECIAL.test(v) || KEY.test(v) || (c.not && /\s/.test(v)) || /^\d/.test(v) && c.not ? `"${v}"` : v);
    }
    case "tag": {
      const v = clean(c.value);
      return `${not}#${/^[^\s"#()|]+$/.test(v) && !/[.,;:!?]$/.test(v) ? v : `"${v}"`}`;
    }
    case "prop": {
      const name = (c.name ?? "").replace(/"/g, "");
      const key = KEY.test(`${name}:`) && !isReservedKey(name) ? name : `"${name}"`;
      return `${not}${key}:${quoteIf(c.value, !!c.quoted)}`;
    }
    default:
      return `${not}${KEY_OF[c.type]}:${quoteIf(c.value.trim())}`;
  }
}
// The query as text, in its canonical form.
export function queryText(node: QueryNode | null, nested = false): string {
  if (!node) return "";
  if (!isGroup(node)) return condText(node);
  const parts = node.items.map((item) => queryText(item, true));
  let body = "";
  node.items.forEach((item, i) => {
    if (i === 0) body = parts[0];
    else if (node.type === "or") body += ` OR ${parts[i]}`;
    else {
      // Two words in a row would become one phrase: AND keeps them apart.
      const prev = node.items[i - 1];
      const words = prev.type === "text" && !prev.not && item.type === "text" && !item.not;
      body += `${words ? " AND " : " "}${parts[i]}`;
    }
  });
  if (node.not) return `-(${body})`;
  return nested ? `(${body})` : body;
}
// Normalises a query text (what saving stores).
export const normalizeQuery = (input: string) => queryText(parseQuery(input).node);

// Whether a query needs only what the search understood before #86 (words,
// #tag, -#tag, Name:value, all of them required): then the search keeps
// its ranking and snippets.
export function isClassicQuery(node: QueryNode | null): boolean {
  if (!node) return true;
  const items = node.type === "and" && !node.not ? node.items : [node];
  let words = 0;
  for (const item of items) {
    if (isGroup(item)) return false;
    if (item.type === "text") {
      if (item.not) return false;
      words++;
    } else if (item.type === "prop") {
      if (item.not) return false;
    } else if (item.type !== "tag") return false;
  }
  return words <= 1;
}
// Every condition of a tree.
export function conditions(node: QueryNode | null): Cond[] {
  if (!node) return [];
  return isGroup(node) ? node.items.flatMap(conditions) : [node];
}
// The item types a query can return at all: a type: condition that must
// hold (in the top AND, not negated) limits them.
export function possibleTypes(node: QueryNode | null): Set<ItemType> | null {
  if (!node) return null;
  const items = node.type === "and" && !node.not ? node.items : [node];
  let out: Set<ItemType> | null = null;
  const expand = (value: string): ItemType[] => {
    const t = itemTypeOf(value);
    return !t ? [] : t === "document" ? ["document", "notebook", "journal", "dashboard"] : [t];
  };
  for (const item of items) {
    let next: Set<ItemType> | null = null;
    if (item.type === "type" && !item.not) next = new Set(expand((item as Cond).value));
    else if (item.type === "or" && !item.not && item.items.every((x) => x.type === "type" && !x.not))
      next = new Set(item.items.flatMap((x) => expand((x as Cond).value)));
    if (!next) continue;
    const keep: Set<ItemType> = next;
    const before = out as Set<ItemType> | null;
    out = before ? new Set<ItemType>([...before].filter((t) => keep.has(t))) : keep;
  }
  return out;
}

// ---- The visual builder ----
//
// The builder shows a group (ALL or ANY of its conditions and subgroups,
// each negatable) – the same tree, with a group always at the top.

export type BuilderGroup = Group;
export function toBuilder(node: QueryNode | null): BuilderGroup {
  if (!node) return { type: "and", items: [] };
  if (isGroup(node)) return node;
  return { type: "and", items: [node] };
}
// The tree of a builder state (empty conditions left out).
export function fromBuilder(group: BuilderGroup): QueryNode | null {
  const keep = (node: QueryNode): QueryNode | null => {
    if (!isGroup(node)) {
      if (node.type === "prop" ? !(node.name ?? "").trim() : !node.value.trim() && !node.quoted) return null;
      return node;
    }
    const items = node.items.map(keep).filter((n): n is QueryNode => !!n);
    if (!items.length) return null;
    return { ...node, items };
  };
  const kept = keep(group);
  return kept ? simplify(kept) : null;
}
// Whether the builder can show a query: one that parses cleanly and nests
// at most three groups deep. Otherwise the text stays the way to edit it.
export function builderCanShow(input: string): boolean {
  const parsed = parseQuery(input);
  if (parsed.errors.length) return false;
  const depth = (node: QueryNode | null): number => (!node || !isGroup(node) ? 0 : 1 + Math.max(0, ...node.items.map(depth)));
  return depth(parsed.node) <= 3;
}

// ---- Dates ----

const DAY = 86_400_000;
export type DayRange = { start: number; end: number };
export const DATE_PRESETS = ["today", "yesterday", "this-week", "last-week", "this-month", "last-month", "this-year", "last-year"] as const;
const PRESETS = new Set([...DATE_PRESETS, "tomorrow", "next-week", "next-month", "next-year"]);
const ordinalOf = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d) / DAY;

function periodOf(expr: string, now: Date, timeZone: string): DayRange | null {
  const v = expr.trim().toLowerCase().replace(/_/g, "-");
  if (PRESETS.has(v)) {
    const w = relativeDateWindow(v.replace(/-/g, "_"), timeZone, undefined, now);
    return w ? { start: w.start, end: w.end } : null;
  }
  const rel = /^([-+])(\d{1,5})([dwmy])$/.exec(v);
  if (rel) {
    const today = relativeDateWindow("today", timeZone, undefined, now)?.start;
    if (today === undefined) return null;
    const n = Number(rel[2]);
    let span: number;
    if (rel[3] === "d" || rel[3] === "w") span = n * (rel[3] === "w" ? 7 : 1);
    else {
      const date = new Date(today * DAY);
      if (rel[3] === "m") date.setUTCMonth(date.getUTCMonth() + (rel[1] === "-" ? -n : n));
      else date.setUTCFullYear(date.getUTCFullYear() + (rel[1] === "-" ? -n : n));
      span = Math.abs(date.getTime() / DAY - today);
    }
    // The last N (including today) or the next N (from today).
    return rel[1] === "-" ? { start: today - span + 1, end: today + 1 } : { start: today, end: today + span };
  }
  const abs = /^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?$/.exec(v);
  if (abs) {
    const y = Number(abs[1]);
    if (!abs[2]) return { start: ordinalOf(y, 1, 1), end: ordinalOf(y + 1, 1, 1) };
    const m = Number(abs[2]);
    if (m < 1 || m > 12) return null;
    if (!abs[3]) return { start: ordinalOf(y, m, 1), end: ordinalOf(y, m + 1, 1) };
    const d = Number(abs[3]);
    const start = ordinalOf(y, m, d);
    if (new Date(start * DAY).getUTCDate() !== d) return null;
    return { start, end: start + 1 };
  }
  return null;
}
// The days (ordinals: days since 1970-01-01, the end excluded) a date
// expression covers in a time zone at `now`; null when it is none.
export function dateRange(expr: string, now: Date, timeZone = "UTC"): DayRange | null {
  const v = expr.trim();
  const cmp = /^(>=|<=|>|<)(.+)$/.exec(v);
  if (cmp) {
    const r = periodOf(cmp[2], now, timeZone);
    if (!r) return null;
    if (cmp[1] === ">") return { start: r.end, end: Infinity };
    if (cmp[1] === ">=") return { start: r.start, end: Infinity };
    if (cmp[1] === "<") return { start: -Infinity, end: r.start };
    return { start: -Infinity, end: r.end };
  }
  const between = /^(.+?)\.\.(.+)$/.exec(v);
  if (between) {
    const a = periodOf(between[1], now, timeZone),
      b = periodOf(between[2], now, timeZone);
    return a && b ? { start: Math.min(a.start, b.start), end: Math.max(a.end, b.end) } : null;
  }
  return periodOf(v, now, timeZone);
}
// Whether a stored time ("2026-03-01 10:00:00" in UTC, or ISO) or a date
// falls into a range, as a day in the time zone.
export function inDateRange(value: string | null | undefined, range: DayRange, timeZone = "UTC"): boolean {
  if (!value) return false;
  const day = relativeCellDay(value, timeZone);
  return Number.isFinite(day) && day >= range.start && day < range.end;
}
// Whether a value uses the relative forms (for date properties, which
// keep their own comparison of written dates otherwise).
export const isRelativeDate = (value: string) => /[a-z]/i.test(value) || /(^|[<>=.]|\.\.)[-+]\d/.test(value);

// The builder's view of a date value.
export type DateParts =
  | { mode: "last"; n: number; unit: "d" | "w" | "m" | "y" }
  | { mode: "preset"; preset: (typeof DATE_PRESETS)[number] }
  | { mode: "on" | "before" | "after"; date: string }
  | { mode: "between"; from: string; to: string }
  | { mode: "custom"; value: string };
export function splitDate(value: string): DateParts {
  const v = value.trim();
  const last = /^-(\d{1,5})([dwmy])$/.exec(v);
  if (last) return { mode: "last", n: Number(last[1]), unit: last[2] as "d" };
  if ((DATE_PRESETS as readonly string[]).includes(v)) return { mode: "preset", preset: v as (typeof DATE_PRESETS)[number] };
  const day = /^\d{4}-\d{2}-\d{2}$/;
  if (day.test(v)) return { mode: "on", date: v };
  if (v.startsWith("<") && day.test(v.slice(1))) return { mode: "before", date: v.slice(1) };
  if (v.startsWith(">") && day.test(v.slice(1))) return { mode: "after", date: v.slice(1) };
  const between = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/.exec(v);
  if (between) return { mode: "between", from: between[1], to: between[2] };
  return { mode: "custom", value: v };
}
export function joinDate(parts: DateParts): string {
  switch (parts.mode) {
    case "last":
      return `-${Math.max(1, Math.floor(parts.n) || 1)}${parts.unit}`;
    case "preset":
      return parts.preset;
    case "on":
      return parts.date;
    case "before":
      return parts.date ? `<${parts.date}` : "";
    case "after":
      return parts.date ? `>${parts.date}` : "";
    case "between":
      return parts.from && parts.to ? `${parts.from}..${parts.to}` : "";
    default:
      return parts.value;
  }
}

// The builder's view of a property value: an operator and an operand.
export type PropOp = "is" | "contains" | "gt" | "lt" | "gte" | "lte" | "between" | "set" | "empty";
export function splitPropValue(value: string, quoted = false): { op: PropOp; value: string; to?: string } {
  if (!quoted && (value === "*" || value === "")) return { op: "set", value: "" };
  if ((!quoted && value === "-") || (quoted && value === "")) return { op: "empty", value: "" };
  const range = /^(.+?)\.\.(.+)$/.exec(value);
  if (range) return { op: "between", value: range[1], to: range[2] };
  const cmp = /^(>=|<=|>|<)(.+)$/.exec(value);
  if (cmp) return { op: ({ ">=": "gte", "<=": "lte", ">": "gt", "<": "lt" } as const)[cmp[1] as ">="], value: cmp[2] };
  return { op: "is", value };
}
export function joinPropValue(op: PropOp, value: string, to = ""): { value: string; quoted?: boolean } {
  switch (op) {
    case "set":
      return { value: "*" };
    case "empty":
      return { value: "-" };
    case "gt":
      return { value: `>${value}` };
    case "lt":
      return { value: `<${value}` };
    case "gte":
      return { value: `>=${value}` };
    case "lte":
      return { value: `<=${value}` };
    case "between":
      return { value: `${value}..${to}` };
    default:
      // A value that reads as an operator is meant literally.
      return value === "*" || value === "-" ? { value, quoted: true } : { value };
  }
}
