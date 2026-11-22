// The placeholder picker of the database rules (#413): which placeholders
// a rule's text may hold and how one goes into it. The rules fill them as
// record templates do (lib/record-placeholders.ts, lib/record-template-
// apply.ts): "{{Name}}" is the property of that name (any case, spaces
// squeezed), the built-ins answer to their German, English, French and
// Russian names. A property whose name cannot stand between braces (braces or
// angle brackets in it, a line break, over 120 characters) or that
// another property's name hides goes in by id ("{{field:abc}}"), which the
// resolver reads as well. Names are what the rule stores: a property
// renamed later no longer matches and its placeholder stays as written.
// Pure and client-safe.
import { BUILTINS, FIELD_PREFIX, placeholderTarget, type Builtin } from "./record-placeholders";
import { readRestricted } from "./field-access-rules";
import type { Field, FieldType } from "./types";

export type RulePlaceholder =
  | { kind: "field"; id: string; name: string; type: FieldType; token: string }
  | { kind: "builtin"; id: string; builtin: Builtin; token: string };

// What the resolver's pattern takes between "{{" and "}}".
const SAYABLE = /^[^{}<>\n]{1,120}$/;
const resolvesTo = (key: string, fields: Field[]) => (SAYABLE.test(key) ? placeholderTarget(key, fields) : null);

// The text that fills in this property: its name where the name finds it
// again, else its id.
export function fieldToken(field: Field, fields: Field[]): string | null {
  const name = field.name.trim();
  const byName = name ? resolvesTo(name, fields) : null;
  if (byName && "field" in byName && byName.field.id === field.id) return `{{${name}}}`;
  const byId = resolvesTo(`${FIELD_PREFIX}${field.id}`, fields);
  return byId && "field" in byId ? `{{${FIELD_PREFIX}${field.id}}}` : null;
}

// A built-in in the reader's language where a property of that name does
// not hide it, else in one of the other languages; null when all are hidden.
export function builtinToken(key: Builtin, fields: Field[], lang: BuiltinLang): string | null {
  const entry = BUILTINS.find((b) => b.key === key);
  if (!entry) return null;
  for (const name of new Set([entry.token[lang], entry.token.de, entry.token.en, entry.token.fr, entry.token.ru])) {
    const target = resolvesTo(name, fields);
    if (target && "builtin" in target && target.builtin === key) return `{{${name}}}`;
  }
  return null;
}

// The placeholders of a rule's text: the database's properties (not those
// only some people may read – they stay empty, as in record templates),
// then the built-ins. A scheduled rule has no record: only the date, the
// time, the person who saved it and the database's name have a value.
export function rulePlaceholders(fields: Field[], options: { scheduled: boolean; lang: BuiltinLang }): RulePlaceholder[] {
  const out: RulePlaceholder[] = [];
  if (!options.scheduled)
    for (const field of fields) {
      if (readRestricted(field.access)) continue;
      const token = fieldToken(field, fields);
      if (token) out.push({ kind: "field", id: `field:${field.id}`, name: field.name, type: field.type, token });
    }
  const builtins: Builtin[] = options.scheduled ? ["today", "now", "me", "database"] : ["title", "today", "now", "creator", "me", "database"];
  for (const builtin of builtins) {
    const token = builtinToken(builtin, fields, options.lang);
    if (token) out.push({ kind: "builtin", id: `builtin:${builtin}`, builtin, token });
  }
  return out;
}

// The picker's language for the built-ins (Chinese and others: English).
export type BuiltinLang = "de" | "en" | "fr" | "ru";
export const builtinLang = (locale: string): BuiltinLang => (locale.startsWith("de") ? "de" : locale.startsWith("fr") ? "fr" : locale.startsWith("ru") ? "ru" : "en");

// Typing "{{" opens the picker (not a third brace).
export function opensPicker(before: string, after: string, caret: number) {
  return after.slice(caret - 2, caret) === "{{" && before.slice(caret - 3, caret - 1) !== "{{";
}

// `token` in place of the selection; a "{{" typed just before it is part
// of the placeholder. Null when the text would be longer than `max`.
export function insertToken(text: string, start: number, end: number, token: string, max = Infinity): { text: string; caret: number } | null {
  const from = start >= 2 && text.slice(start - 2, start) === "{{" ? start - 2 : start;
  const next = text.slice(0, from) + token + text.slice(end);
  if (next.length > max) return null;
  return { text: next, caret: from + token.length };
}
