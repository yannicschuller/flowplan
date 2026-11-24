// The title of a record typed as text (#529): the record view's big title,
// a subtask's title, quick capture. The title is the first property
// (#463) and may have another type than text – a date, a number, a select
// … – so what people type is read into the value that property stores, in
// the same writings the table and imports read ("23.11.2026", "1.234,5",
// "12 kg"). The server stays strict (lib/database-operations.ts); the
// value is sent ready.
import { parseCheckbox, parseNumber } from "./table-database";
import { browserZone, draftDateValue, fieldValue, isTimed, validDateValue } from "./date-values";
import { currencies, displayText, fieldUnit, formatFieldDate, formatNumber, ratingMax, stripUnit } from "./field-format";
import { cellText, csvListValues } from "./cell-text";
import type { Field, FieldType } from "./types";

type Translate = (de: string, en: string) => string;
type TitleField = Pick<Field, "type" | "name" | "options" | "tagOptions" | "format" | "timeFormat" | "noTime" | "unit" | "decimals" | "rollupDisplay" | "rollupMax">;
type Member = { id: string; name: string; email?: string };

// How a title of this type is edited in the record view:
// "text" plain text, "typed" text read into the stored value, "editor"
// the property's own editor (components/cell-input.tsx), "readonly" a
// value Flowplan works out (formula, rollup; IDs and the like from before
// #463).
export type TitleMode = "text" | "typed" | "editor" | "readonly";
const READONLY: FieldType[] = ["formula", "rollup", "id", "progress", "time", "created_at", "updated_at", "created_by", "updated_by"];
const TEXT: FieldType[] = ["text", "url", "email", "phone"];
export function titleMode(field: Pick<Field, "type" | "tagOptions">): TitleMode {
  if (READONLY.includes(field.type)) return "readonly";
  if (TEXT.includes(field.type)) return "text";
  if (field.type === "date" || field.type === "number" || field.type === "select" || field.type === "person") return "typed";
  if (field.type === "multiselect" && !field.tagOptions) return "typed";
  return "editor";
}

export type TitleParse = { ok: true; value: unknown } | { ok: false; error: string };
const fold = (text: string) => text.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase();
const pad = (n: number, size = 2) => String(n).padStart(size, "0");

// ---- Dates ----

const MONTHS: Record<string, number> = {};
[
  ["jan", "januar", "january", "jän", "jänner"],
  ["feb", "februar", "february"],
  ["mär", "mrz", "märz", "mar", "march", "maerz"],
  ["apr", "april"],
  ["mai", "may"],
  ["jun", "juni", "june"],
  ["jul", "juli", "july"],
  ["aug", "august"],
  ["sep", "sept", "september"],
  ["okt", "oktober", "oct", "october"],
  ["nov", "november"],
  ["dez", "dezember", "dec", "december"],
].forEach((names, i) => names.forEach((name) => (MONTHS[name] = i + 1)));
const month = (name: string) => MONTHS[name.toLocaleLowerCase().replace(/\.$/, "")] ?? 0;
function validDay(y: number, m: number, d: number) {
  if (y < 1 || y > 9999 || m < 1 || m > 12 || d < 1) return null;
  const date = new Date(Date.UTC(2000, m - 1, d));
  if (date.getUTCMonth() !== m - 1 || (m === 2 && d === 29 && !(y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)))) return null;
  return `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
}
const year = (text: string) => (text.length === 2 ? 2000 + Number(text) : Number(text));
// The day of a typed date: ISO (2026-11-23), German (23.11.2026,
// 23.11.26), with slashes (23/11/2026; month first for the US format or
// when the first number cannot be a month: 11/23/2026) and with month
// names as dates are shown (23. Nov. 2026, 23 November 2026, Nov 23, 2026).
function typedDay(text: string, usFirst: boolean): string | null {
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (m) return validDay(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2})$/.exec(text);
  if (m) return validDay(year(m[3]), +m[2], +m[1]);
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})$/.exec(text);
  if (m) {
    const [a, b] = [+m[1], +m[2]];
    const monthFirst = b > 12 || (usFirst && a <= 12);
    return monthFirst ? validDay(year(m[3]), a, b) : validDay(year(m[3]), b, a);
  }
  m = /^(\d{1,2})\.?\s*([\p{L}]+\.?)\s*(\d{4})$/u.exec(text);
  if (m && month(m[2])) return validDay(+m[3], month(m[2]), +m[1]);
  m = /^([\p{L}]+\.?)\s*(\d{1,2}),?\s*(\d{4})$/u.exec(text);
  if (m && month(m[1])) return validDay(+m[3], month(m[1]), +m[2]);
  return null;
}
// A time of day: 14:30, 14.30 Uhr, 2:30 PM.
function typedTime(text: string): string | null {
  const m = /^(\d{1,2})(?:[:.](\d{2}))?\s*(uhr|am|pm|a\.m\.|p\.m\.)?$/i.exec(text.trim());
  if (!m || (m[2] === undefined && !m[3])) return null;
  let h = +m[1];
  const min = m[2] === undefined ? 0 : +m[2];
  const half = m[3]?.toLowerCase().replace(/\./g, "");
  if (half === "am" || half === "pm") {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (half === "pm" ? 12 : 0);
  }
  if (h > 23 || min > 59) return null;
  return `${pad(h)}:${pad(min)}`;
}
// A typed date (and time) as the local value "YYYY-MM-DD" or
// "YYYY-MM-DDTHH:MM"; null when it is none.
export function parseTypedDate(raw: string, usFirst = false): string | null {
  // As shown with a time: "23. Nov. 2026, 14:30 (UTC+01:00)".
  const text = raw.replace(/\s*\([^)]*\)\s*$/, "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  const iso = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::00(?:\.0+)?)?$/.exec(text);
  if (iso) return typedDay(iso[1], usFirst) && typedTime(iso[2]) ? `${iso[1]}T${iso[2]}` : null;
  const day = typedDay(text, usFirst);
  if (day) return day;
  // A date, then the time (after a space, a comma or "um"/"at").
  const parts = /^(.+?)(?:,\s*|\s+(?:um|at)\s+|\s+)(\d{1,2}(?:[:.]\d{2})?\s*(?:uhr|am|pm|a\.m\.|p\.m\.)?)$/i.exec(text);
  if (!parts) return null;
  const d = typedDay(parts[1].replace(/,$/, "").trim(), usFirst),
    time = typedTime(parts[2]);
  return d && time ? `${d}T${time}` : null;
}
function dateExample(field: Pick<Field, "format">) {
  return field.format === "us" ? "11/23/2026" : field.format === "iso" ? "2026-11-23" : "23.11.2026";
}

// ---- Numbers ----

// "1.234,5", "12 kg" (the property's unit, #522), "12,50 €", "15 %".
// Percent properties store the fraction (15 % → 0.15) when a % is typed;
// a plain number is taken as it is, as the table's number field does.
function typedNumber(raw: string, field: TitleField): number | null {
  let text = stripUnit(raw, field).trim();
  let percent = false;
  if (/%$/.test(text)) {
    percent = true;
    text = text.replace(/\s*%$/, "");
  }
  const currency = currencies[field.format as keyof typeof currencies];
  if (currency) text = text.replace(new RegExp(`^${currency[1]}\\s*|\\s*${currency[1]}$`, "i"), "");
  text = text.replace(/^\p{Sc}\s*|\s*\p{Sc}$/u, "").replace(/^\+/, "");
  const n = parseNumber(text);
  if (n === null) return null;
  return percent ? Number((n / 100).toPrecision(15)) : n;
}

// ---- Reading what was typed ----

// `current` is the stored value: a date with a time keeps its exact
// instant when its time is typed again unchanged.
export function parseTitleInput(
  field: TitleField,
  raw: string,
  context: { t: Translate; zone?: string; members?: Member[]; current?: unknown },
): TitleParse {
  const { t } = context;
  const text = raw.replace(/\s+/g, " ").trim();
  switch (field.type) {
    case "text":
    case "url":
    case "email":
    case "phone":
      return { ok: true, value: text };
    case "date": {
      if (!text) return { ok: true, value: "" };
      const local = parseTypedDate(text, field.format === "us");
      const example = dateExample(field);
      if (!local) return { ok: false, error: t(`Das ist kein Datum – z. B. ${example}`, `That's not a date – e.g. ${example}`) };
      if (!isTimed(local)) return { ok: true, value: local };
      // A date property without time (#327) takes none – unless the
      // stored value already has one (it may keep or move it).
      if (field.noTime && !isTimed(context.current))
        return { ok: false, error: t(`Diese Eigenschaft hat keine Uhrzeit – nur ein Datum, z. B. ${example}`, `This property has no time – only a date, e.g. ${example}`) };
      const zone = context.zone || browserZone();
      // The hour repeated when the clocks go back counts as the first one.
      for (const occurrence of ["reject", "earlier"] as const)
        try {
          return { ok: true, value: draftDateValue(local, true, occurrence, context.current, zone) };
        } catch {
          // The next choice, or the message below.
        }
      return { ok: false, error: t("Diese Uhrzeit gibt es an dem Tag nicht (Zeitumstellung).", "That time doesn't exist on that day (clock change).") };
    }
    case "number": {
      if (!text) return { ok: true, value: null };
      const n = typedNumber(text, field);
      const unit = fieldUnit(field);
      const example = unit ? `12 ${unit}` : field.format === "percent" ? "15 %" : null;
      if (n === null)
        return {
          ok: false,
          error: example
            ? t(`Das ist keine Zahl – z. B. ${example}`, `That's not a number – e.g. ${example}`)
            : t("Das ist keine Zahl – z. B. 1.234,5", "That's not a number – e.g. 1,234.5"),
        };
      if (field.rollupDisplay === "rating" && (!Number.isInteger(n) || n < 0 || n > ratingMax(field)))
        return { ok: false, error: t(`Bitte eine ganze Zahl von 0 bis ${ratingMax(field)}.`, `Please enter a whole number from 0 to ${ratingMax(field)}.`) };
      return { ok: true, value: n };
    }
    case "checkbox": {
      if (!text) return { ok: true, value: false };
      const v = parseCheckbox(text);
      return v === null ? { ok: false, error: t("Bitte „ja“ oder „nein“.", "Please enter “yes” or “no”.") } : { ok: true, value: v };
    }
    case "select": {
      if (!text) return { ok: true, value: "" };
      const option = (field.options || []).find((o) => fold(o) === fold(text));
      return option !== undefined ? { ok: true, value: option } : { ok: false, error: optionError(field, t) };
    }
    case "multiselect": {
      if (field.tagOptions) break;
      if (!text) return { ok: true, value: [] };
      const values: string[] = [];
      for (const part of csvListValues(text, field.options || [])) {
        if (!part.trim()) continue;
        const option = (field.options || []).find((o) => fold(o) === fold(part));
        if (option === undefined) return { ok: false, error: optionError(field, t) };
        if (!values.includes(option)) values.push(option);
      }
      return { ok: true, value: values };
    }
    case "person": {
      if (!text) return { ok: true, value: "" };
      const members = context.members || [];
      const match =
        members.find((m) => fold(m.name) === fold(text)) ||
        members.find((m) => !!m.email && fold(m.email) === fold(text));
      return match ? { ok: true, value: match.id } : { ok: false, error: t("Niemand im Arbeitsbereich heißt so.", "No one in the workspace has that name.") };
    }
  }
  return { ok: false, error: t("Dieser Titel lässt sich nicht tippen.", "This title can't be typed.") };
}
function optionError(field: TitleField, t: Translate) {
  const options = (field.options || []).slice(0, 5).join(", ");
  return options
    ? t(`Keine Option von „${field.name}“ – z. B. ${options}`, `Not an option of “${field.name}” – e.g. ${options}`)
    : t(`„${field.name}“ hat noch keine Optionen.`, `“${field.name}” has no options yet.`);
}

// ---- Showing the title ----

// The title as the text to edit: the day as a number (23.11.2026, or as
// the property's ISO/US format says) with the time in `zone`; a number
// without thousands separators in the page's language.
export function titleEditText(field: TitleField, value: unknown, context: { zone?: string; members?: Member[] } = {}): string {
  if (value === null || value === undefined || value === "") return "";
  if (field.type === "date") {
    if (!validDateValue(value)) return cellText(value);
    const local = fieldValue(value, context.zone || browserZone());
    const [y, m, d] = local.slice(0, 10).split("-");
    const day = field.format === "iso" ? `${y}-${m}-${d}` : field.format === "us" ? `${m}/${d}/${y}` : `${d}.${m}.${y}`;
    return isTimed(local) ? `${day} ${local.slice(11, 16)}` : day;
  }
  if (field.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) return cellText(value);
    return field.format === "percent" ? formatNumber(value, "percent") : formatNumber(value, "plain");
  }
  if (field.type === "person") return context.members?.find((m) => m.id === value)?.name ?? "";
  if (field.type === "multiselect") return Array.isArray(value) ? value.map(String).join(", ") : cellText(value);
  return cellText(value);
}
// The title as the table's first column shows it (the breadcrumb, the
// record's header): dates and numbers formatted, people by name.
export function titleDisplayText(field: TitleField, value: unknown, context: { zone?: string; members?: Member[] } = {}): string {
  if (field.type === "date" && typeof value === "string" && value) return formatFieldDate(value, field, context.zone);
  if (field.type === "person" || field.type === "created_by" || field.type === "updated_by")
    return context.members?.find((m) => m.id === value)?.name ?? "";
  if ((field.type === "multiselect" || field.type === "rollup") && Array.isArray(value)) return value.map((v) => cellText(v)).join(", ");
  if (field.type === "number" && (value === null || value === "")) return "";
  if (field.type === "checkbox") return value ? "✓" : "";
  return displayText(field, value, context.zone);
}
// What an empty title field suggests.
export function titlePlaceholder(field: TitleField, t: Translate): string {
  if (field.type === "date") return t(`Datum, z. B. ${dateExample(field)}`, `Date, e.g. ${dateExample(field)}`);
  if (field.type === "number") {
    const unit = fieldUnit(field);
    return unit ? t(`Zahl, z. B. 12 ${unit}`, `Number, e.g. 12 ${unit}`) : t("Zahl, z. B. 1.234,5", "Number, e.g. 1,234.5");
  }
  return t("Ohne Titel", "Untitled");
}
