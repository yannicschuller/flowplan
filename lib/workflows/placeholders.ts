// Placeholders of workflows (docs/specs/workflows.md §7): the parser of the
// stored form ({{n_k3f9a2.record.fields.f_x81 | date: "dd.MM.yyyy"}}), the
// renderer with the filters of §7.2, the conversion of values to text, and
// the translation between the stored form and what people read and type
// ({{Neue Seite.Eintrag.Titel | kürzen: 140}}). Client-safe.
import { translate, type Locale } from "../i18n";

export type PathKey = string | number;
export type Path = { root: string; keys: PathKey[] };
export type FilterArg = { kind: "string"; value: string } | { kind: "number"; value: number } | { kind: "path"; value: Path };
export type FilterCall = { name: string; args: FilterArg[] };
export type Placeholder = { path: Path; filters: FilterCall[] };
export type Segment = string | Placeholder;

export class PlaceholderError extends Error {
  // "validation": a `required` value was empty or a filter got a wrong value.
  kind = "validation" as const;
}

// Built-in roots (stored form) and their names in the interface.
// i18n-table: 1 – names per language (de, en, fr)
export const BUILTIN_ROOTS: Record<string, [string, string, string]> = {
  $trigger: ["Auslöser", "Trigger", "Déclencheur"],
  $item: ["Element", "Item", "Élément"],
  $index: ["Index", "Index", "Index"],
  $run: ["Lauf", "Run", "Exécution"],
  $workflow: ["Workflow", "Workflow", "Workflow"],
  $runner: ["Ausführende", "Runner", "Exécutant"],
  $today: ["Heute", "Today", "Aujourd’hui"],
  $now: ["Jetzt", "Now", "Maintenant"],
};
// Filters: stored (English) name → German name (both are accepted when typed).
// i18n-table: 1 – [stored, German]
export const FILTERS: Record<string, string> = {
  date: "datum",
  add_days: "plus_tage",
  add_hours: "plus_stunden",
  truncate: "kürzen",
  upper: "groß",
  lower: "klein",
  trim: "trimmen",
  replace: "ersetzen",
  default: "standard",
  join: "verbinden",
  first: "erstes",
  last: "letztes",
  count: "anzahl",
  number: "zahl",
  plain: "klartext",
  required: "pflicht",
  json: "json",
};
const FILTER_ALIASES = new Map<string, string>([...Object.keys(FILTERS).map((k) => [k, k] as const), ...Object.entries(FILTERS).map(([k, de]) => [de, k] as const)]);
export const canonicalFilter = (name: string) => FILTER_ALIASES.get(name.toLowerCase());

/* ---------- Parser ---------- */

const NAME = /[\p{L}\p{N}_$-]/u;
class Reader {
  i = 0;
  constructor(readonly s: string, readonly display: boolean) {}
  peek(n = 0) {
    return this.s[this.i + n];
  }
  ws() {
    while (/\s/.test(this.peek() || "")) this.i++;
  }
  expect(ch: string) {
    if (this.s[this.i] !== ch) throw new Error(`„${ch}“ erwartet bei Zeichen ${this.i + 1}.`);
    this.i++;
  }
  name(root = false) {
    const start = this.i;
    if (this.display && root) {
      // A node's label may hold spaces: up to the next . | [ or }}.
      while (this.i < this.s.length && !/[.|[\]{}]/.test(this.s[this.i])) this.i++;
      const v = this.s.slice(start, this.i).trim();
      if (!v) throw new Error(`Name erwartet bei Zeichen ${start + 1}.`);
      return v;
    }
    while (this.i < this.s.length && NAME.test(this.s[this.i])) this.i++;
    if (start === this.i) throw new Error(`Name erwartet bei Zeichen ${start + 1}.`);
    return this.s.slice(start, this.i);
  }
  string() {
    this.expect('"');
    let v = "";
    for (;;) {
      const ch = this.s[this.i++];
      if (ch === undefined) throw new Error("Text in Anführungszeichen nicht beendet.");
      if (ch === "\\" && (this.peek() === '"' || this.peek() === "\\")) v += this.s[this.i++];
      else if (ch === '"') return v;
      else v += ch;
    }
  }
  path(): Path {
    const root = this.name(true);
    const keys: PathKey[] = [];
    for (;;) {
      if (this.peek() === ".") {
        this.i++;
        keys.push(this.name());
      } else if (this.peek() === "[") {
        this.i++;
        this.ws();
        if (this.peek() === '"') keys.push(this.string());
        else {
          const m = /^\d+/.exec(this.s.slice(this.i));
          if (!m) throw new Error(`Zahl oder Text in [ ] erwartet bei Zeichen ${this.i + 1}.`);
          this.i += m[0].length;
          keys.push(Number(m[0]));
        }
        this.ws();
        this.expect("]");
      } else return { root, keys };
    }
  }
  arg(): FilterArg {
    if (this.peek() === '"') return { kind: "string", value: this.string() };
    const m = /^-?\d+(?:\.\d+)?/.exec(this.s.slice(this.i));
    if (m) {
      this.i += m[0].length;
      return { kind: "number", value: Number(m[0]) };
    }
    return { kind: "path", value: this.path() };
  }
  placeholder(): Placeholder {
    this.ws();
    const path = this.path();
    const filters: FilterCall[] = [];
    for (;;) {
      this.ws();
      if (this.peek() === "}" && this.peek(1) === "}") {
        this.i += 2;
        return { path, filters };
      }
      this.expect("|");
      this.ws();
      const raw = this.name();
      const name = canonicalFilter(raw);
      if (!name) throw new Error(`Unbekannter Filter „${raw}“.`);
      const args: FilterArg[] = [];
      this.ws();
      if (this.peek() === ":") {
        this.i++;
        for (;;) {
          this.ws();
          args.push(this.arg());
          this.ws();
          if (this.peek() !== ",") break;
          this.i++;
        }
      }
      filters.push({ name, args });
    }
  }
}

function parse(text: string, display: boolean): Segment[] {
  const out: Segment[] = [];
  let buf = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\" && text[i + 1] === "\\") {
      buf += "\\";
      i += 2;
    } else if (ch === "\\" && text[i + 1] === "{" && text[i + 2] === "{") {
      buf += "{{";
      i += 3;
    } else if (ch === "{" && text[i + 1] === "{") {
      if (buf) out.push(buf);
      buf = "";
      const r = new Reader(text, display);
      r.i = i + 2;
      const close = text.indexOf("}}", i + 2);
      if (close < 0) throw new Error("Platzhalter nicht geschlossen.");
      out.push(r.placeholder());
      i = r.i;
    } else {
      buf += ch;
      i++;
    }
  }
  if (buf) out.push(buf);
  return out;
}
// Parses the stored form; throws on a malformed placeholder.
export const parseTemplate = (text: string) => parse(text, false);
export const hasPlaceholders = (text: string) => /(^|[^\\])\{\{/.test(text);
// The roots a template names (node ids and built-ins), args included.
export function placeholderRoots(segments: Segment[]): string[] {
  const roots: string[] = [];
  const add = (p: Path) => roots.push(p.root);
  for (const s of segments)
    if (typeof s !== "string") {
      add(s.path);
      for (const f of s.filters) for (const a of f.args) if (a.kind === "path") add(a.value);
    }
  return roots;
}
// Writes a parsed template back in the stored form.
export function formatTemplate(segments: Segment[]): string {
  return segments.map((s) => (typeof s === "string" ? escapeText(s) : `{{${formatPlaceholder(s)}}}`)).join("");
}
export const escapeText = (s: string) => s.replace(/\\/g, "\\\\").replace(/\{\{/g, "\\{{");
const quote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const plainName = (k: string) => /^[\p{L}\p{N}_$-]+$/u.test(k);
function formatPath(p: Path) {
  return p.root + p.keys.map((k) => (typeof k === "number" ? `[${k}]` : plainName(k) ? `.${k}` : `[${quote(k)}]`)).join("");
}
function formatPlaceholder(p: Placeholder, filterName: (n: string) => string = (n) => n, path = formatPath) {
  const filters = p.filters.map((f) => {
    const args = f.args.map((a) => (a.kind === "string" ? quote(a.value) : a.kind === "number" ? String(a.value) : path(a.value)));
    return ` | ${filterName(f.name)}${args.length ? `: ${args.join(", ")}` : ""}`;
  });
  return `${path(p.path)}${filters.join("")}`;
}

/* ---------- Values ---------- */

export type RenderScope = {
  // Roots: node ids and built-ins ($trigger, $run, …) with their values.
  values: Record<string, unknown>;
  timeZone: string;
  locale: Locale;
  // Called for missing values (a node that did not run, a deleted field).
  warn?: (message: string) => void;
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/;
export const isEmpty = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length);

export function resolvePath(path: Path, scope: RenderScope): unknown {
  let value: unknown = scope.values[path.root];
  if (value === undefined && !(path.root in scope.values)) {
    scope.warn?.(`Kein Wert für ${formatPath(path)}.`);
    return undefined;
  }
  for (const key of path.keys) {
    if (value === null || value === undefined) return undefined;
    if (typeof key === "number") value = Array.isArray(value) ? value[key] : undefined;
    else if (typeof value === "object") value = (value as Record<string, unknown>)[key];
    else value = undefined;
  }
  return value;
}

// Text of a value (§7.3): dates in the workflow's language, people by name,
// pages and records by title, lists with ", ", objects as JSON, null empty.
export function valueText(value: unknown, locale: Locale = "de", timeZone = "UTC"): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") {
    if (DATE.test(value)) return formatDate(value, "kurz", locale, timeZone);
    if (DATETIME.test(value)) return formatDate(value, "kurz", locale, timeZone);
    return value;
  }
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return translate(locale)(value ? "Ja" : "Nein", value ? "Yes" : "No");
  if (Array.isArray(value)) return value.map((v) => valueText(v, locale, timeZone)).filter(Boolean).join(", ");
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    if (typeof o.title === "string") return o.title;
    if (typeof o.name === "string") return o.name;
    return JSON.stringify(value);
  }
  return String(value);
}

/* ---------- Dates ---------- */

function zonedParts(ms: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
  }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value || "";
  return { y: Number(get("year")), m: Number(get("month")), d: Number(get("day")), H: Number(get("hour")) % 24, M: Number(get("minute")), S: Number(get("second")) };
}
const pad = (n: number, w = 2) => String(n).padStart(w, "0");
const localeTagOf = (locale: Locale) => (locale.startsWith("de") ? "de-DE" : locale.startsWith("fr") ? "fr-FR" : locale.startsWith("zh") ? "zh-CN" : "en-GB");

// Formats a date (YYYY-MM-DD, kept as the day) or a date-time (in the
// workflow's time zone). `format`: "kurz"/"short", "lang"/"long" or a
// pattern of dd d MM M MMMM MMM yyyy yy HH H mm ss EEEE EEE.
export function formatDate(value: string, format: string, locale: Locale, timeZone: string): string {
  const dateOnly = DATE.test(value);
  const ms = dateOnly ? Date.parse(`${value}T12:00:00Z`) : Date.parse(value);
  if (!Number.isFinite(ms)) return value;
  const zone = dateOnly ? "UTC" : timeZone;
  const tag = localeTagOf(locale);
  if (format === "kurz" || format === "short" || format === "lang" || format === "long") {
    const long = format === "lang" || format === "long";
    return new Intl.DateTimeFormat(tag, {
      timeZone: zone,
      ...(long ? { dateStyle: "long" } : { dateStyle: "medium" }),
      ...(dateOnly ? {} : { timeStyle: "short" }),
    }).format(new Date(ms));
  }
  const p = zonedParts(ms, zone);
  const month = (style: "long" | "short") => new Intl.DateTimeFormat(tag, { timeZone: zone, month: style }).format(new Date(ms));
  const weekday = (style: "long" | "short") => new Intl.DateTimeFormat(tag, { timeZone: zone, weekday: style }).format(new Date(ms));
  return format.replace(/yyyy|yy|MMMM|MMM|MM|M|dd|d|HH|H|mm|ss|EEEE|EEE/g, (t) => {
    switch (t) {
      case "yyyy": return String(p.y);
      case "yy": return pad(p.y % 100);
      case "MMMM": return month("long");
      case "MMM": return month("short");
      case "MM": return pad(p.m);
      case "M": return String(p.m);
      case "dd": return pad(p.d);
      case "d": return String(p.d);
      case "HH": return pad(p.H);
      case "H": return String(p.H);
      case "mm": return pad(p.M);
      case "ss": return pad(p.S);
      case "EEEE": return weekday("long");
      default: return weekday("short");
    }
  });
}
function addDays(value: unknown, days: number): unknown {
  if (typeof value !== "string") return value;
  if (DATE.test(value)) {
    const d = new Date(`${value}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms + days * 86_400_000).toISOString() : value;
}
function addHours(value: unknown, hours: number): unknown {
  if (typeof value !== "string") return value;
  const ms = Date.parse(DATE.test(value) ? `${value}T00:00:00Z` : value);
  return Number.isFinite(ms) ? new Date(ms + hours * 3_600_000).toISOString() : value;
}

/* ---------- Filters ---------- */

function truncate(text: string, length: number, ending: string) {
  if (text.length <= length) return text;
  const cut = text.slice(0, Math.max(0, length));
  const space = cut.lastIndexOf(" ");
  return (space > length * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:–-]+$/, "") + ending;
}
export function plainText(value: string) {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[*_~`]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
function applyFilter(value: unknown, f: FilterCall, scope: RenderScope, label: string): unknown {
  const arg = (i: number): unknown => {
    const a = f.args[i];
    if (!a) return undefined;
    return a.kind === "path" ? resolvePath(a.value, scope) : a.value;
  };
  const text = () => valueText(value, scope.locale, scope.timeZone);
  const num = (v: unknown, fallback: number) => {
    const n = typeof v === "number" ? v : Number(String(v ?? "").replace(",", "."));
    return Number.isFinite(n) ? n : fallback;
  };
  switch (f.name) {
    case "date":
      return typeof value === "string" && value ? formatDate(value, String(arg(0) ?? "kurz"), scope.locale, scope.timeZone) : "";
    case "add_days":
      return addDays(value, Math.trunc(num(arg(0), 0)));
    case "add_hours":
      return addHours(value, num(arg(0), 0));
    case "truncate":
      return truncate(text(), Math.max(1, Math.trunc(num(arg(0), 100))), arg(1) === undefined ? "…" : String(arg(1)));
    case "upper":
      return text().toLocaleUpperCase();
    case "lower":
      return text().toLocaleLowerCase();
    case "trim":
      return text().trim();
    case "replace": {
      const from = String(arg(0) ?? "");
      return from ? text().split(from).join(String(arg(1) ?? "")) : text();
    }
    case "default":
      return isEmpty(value) ? arg(0) : value;
    case "join":
      return Array.isArray(value) ? value.map((v) => valueText(v, scope.locale, scope.timeZone)).join(arg(0) === undefined ? ", " : String(arg(0))) : text();
    case "first":
      return Array.isArray(value) ? value[0] : value;
    case "last":
      return Array.isArray(value) ? value[value.length - 1] : value;
    case "count":
      return Array.isArray(value) ? value.length : isEmpty(value) ? 0 : text().length;
    case "number": {
      const n = num(value, NaN);
      if (!Number.isFinite(n)) return "";
      const digits = arg(0) === undefined ? undefined : Math.max(0, Math.min(10, Math.trunc(num(arg(0), 0))));
      return new Intl.NumberFormat(localeTagOf(scope.locale), digits === undefined ? {} : { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
    }
    case "plain":
      return plainText(text());
    case "required":
      if (isEmpty(value)) throw new PlaceholderError(`Kein Wert für {{${label}}} (Pflicht).`);
      return value;
    case "json":
      return JSON.stringify(value ?? null);
  }
  return value;
}

// The value of one placeholder, its filters applied.
export function evaluatePlaceholder(p: Placeholder, scope: RenderScope): unknown {
  let value = resolvePath(p.path, scope);
  for (const f of p.filters) value = applyFilter(value, f, scope, formatPath(p.path));
  return value;
}

// Renders a template. A template that is exactly one placeholder gives its
// typed value (`whole`, §7.3: a date stays a date for a date property);
// anything else is text.
export function renderTemplate(text: string, scope: RenderScope, options: { whole?: boolean; encode?: (s: string) => string } = {}): unknown {
  const segments = parseTemplate(text);
  if (options.whole && segments.length === 1 && typeof segments[0] !== "string") return evaluatePlaceholder(segments[0], scope);
  return segments
    .map((s) => {
      if (typeof s === "string") return s;
      const v = valueText(evaluatePlaceholder(s, scope), scope.locale, scope.timeZone);
      return options.encode ? options.encode(v) : v;
    })
    .join("");
}
export const renderText = (text: string, scope: RenderScope) => String(renderTemplate(text, scope));
export const renderValue = (text: string, scope: RenderScope) => renderTemplate(text, scope, { whole: true });
// For an HTTP header (§7.4): no CR/LF or other control characters, ≤ 8 KB.
export const headerSafe = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 8192);

/* ---------- Display form ---------- */

export type DisplayContext = {
  locale: Locale;
  // Node id ↔ label.
  labels: Map<string, string>;
  // A path key's name in the interface and back (output fields, properties).
  keyName?: (root: string, keys: PathKey[], key: string) => string;
  keyId?: (root: string, keys: PathKey[], name: string) => string;
};
const langIndex = (locale: Locale) => (locale.startsWith("de") ? 0 : locale.startsWith("fr") ? 2 : 1);

// Stored → display: node labels, built-ins and filters in the reader's language.
export function toDisplay(text: string, ctx: DisplayContext): string {
  const segments = parseTemplate(text);
  const de = langIndex(ctx.locale) === 0;
  const path = (p: Path) => {
    const root = BUILTIN_ROOTS[p.root] ? `$${BUILTIN_ROOTS[p.root][langIndex(ctx.locale)]}` : ctx.labels.get(p.root) || p.root;
    const keys = p.keys.map((k, i) => (typeof k === "string" && ctx.keyName ? ctx.keyName(p.root, p.keys.slice(0, i), k) : k));
    return root + keys.map((k) => (typeof k === "number" ? `[${k}]` : plainName(k) ? `.${k}` : `[${quote(k)}]`)).join("");
  };
  return segments.map((s) => (typeof s === "string" ? escapeText(s) : `{{${formatPlaceholder(s, (n) => (de ? FILTERS[n] || n : n), path)}}}`)).join("");
}
// Display → stored: names are matched ignoring case, built-ins in German,
// English and French; filters in German or English.
export function fromDisplay(text: string, ctx: DisplayContext): string {
  const segments = parse(text, true);
  const byLabel = new Map([...ctx.labels].map(([id, label]) => [label.toLowerCase(), id]));
  const builtin = new Map<string, string>();
  for (const [key, names] of Object.entries(BUILTIN_ROOTS)) {
    builtin.set(key.toLowerCase(), key);
    for (const n of names) builtin.set(`$${n}`.toLowerCase(), key);
  }
  const root = (name: string) => {
    const lower = name.toLowerCase();
    const found = builtin.get(lower) || byLabel.get(lower) || (ctx.labels.has(name) ? name : undefined);
    if (!found) throw new Error(`Unbekannter Name „${name}“.`);
    return found;
  };
  const mapPath = (p: Path): Path => {
    const r = root(p.root);
    const keys: PathKey[] = [];
    for (const k of p.keys) keys.push(typeof k === "string" && ctx.keyId ? ctx.keyId(r, keys.slice(), k) : k);
    return { root: r, keys };
  };
  return formatTemplate(
    segments.map((s) =>
      typeof s === "string"
        ? s
        : { path: mapPath(s.path), filters: s.filters.map((f) => ({ name: f.name, args: f.args.map((a) => (a.kind === "path" ? { kind: "path" as const, value: mapPath(a.value) } : a)) })) },
    ),
  );
}
