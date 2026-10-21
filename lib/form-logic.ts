// Form logic shared by ordinary forms and surveys, in the browser and on
// the server: "only show if …" conditions on questions, text blocks and
// page breaks, placeholders like {Name} in the thank-you texts, and the
// redirect after sending. Client-safe (no server imports).
import { z } from "zod";

export const conditionOps = ["is", "isNot", "includes", "notIncludes", "contains", "answered", "notAnswered", "gt", "lt", "gte", "lte"] as const;
export type ConditionOp = (typeof conditionOps)[number];
export const conditionSchema = z.object({
  field: z.string().min(1).max(500),
  op: z.enum(conditionOps),
  value: z.string().max(300).default(""),
});
export type Condition = z.infer<typeof conditionSchema>;

const empty = (v: unknown) =>
  v === undefined || v === null || v === "" || v === false || (typeof v === "string" && !v.trim()) || (Array.isArray(v) && !v.length);
const number = (v: string) => Number(v.replace(",", "."));

// Is a condition met by the answers so far?
export function conditionMet(c: Condition | undefined, values: Record<string, unknown>) {
  if (!c) return true;
  const v = values[c.field];
  const list = Array.isArray(v) ? v.map(String) : empty(v) ? [] : [String(v)];
  const first = list[0];
  const compare = (check: (a: number, b: number) => boolean) => {
    if (first === undefined || c.value.trim() === "") return false;
    const a = number(first),
      b = number(c.value);
    return Number.isFinite(a) && Number.isFinite(b) && check(a, b);
  };
  switch (c.op) {
    case "answered":
      return list.length > 0;
    case "notAnswered":
      return list.length === 0;
    case "is":
      return list.length === 1 && first === c.value;
    case "isNot":
      return !(list.length === 1 && first === c.value);
    case "includes":
      return list.includes(c.value);
    case "notIncludes":
      return !list.includes(c.value);
    case "contains":
      return !!c.value && list.some((x) => x.toLocaleLowerCase().includes(c.value.toLocaleLowerCase()));
    case "gt":
      return compare((a, b) => a > b);
    case "lt":
      return compare((a, b) => a < b);
    case "gte":
      return compare((a, b) => a >= b);
    case "lte":
      return compare((a, b) => a <= b);
  }
}

// One step of a form in order: a question (writing to one or more
// properties), a text block or a page break. A hidden page break hides
// everything up to the next page break.
export type LogicItem = { id: string; kind: "question" | "text" | "page"; fields?: string[]; showIf?: Condition };
export type LogicResult = {
  // Ids of the items that are shown.
  shown: Set<string>;
  // Properties of hidden questions: not required, answers dropped.
  hiddenFields: Set<string>;
  // The answers of shown questions only.
  answers: Record<string, unknown>;
};

// Conditions look at the answers of shown questions only, so hiding a
// question also hides what depends on it.
export function evaluateLogic(items: LogicItem[], values: Record<string, unknown>): LogicResult {
  const shown = new Set<string>(),
    hiddenFields = new Set<string>(),
    answers: Record<string, unknown> = {};
  let pageHidden = false;
  for (const item of items) {
    if (item.kind === "page") {
      pageHidden = !conditionMet(item.showIf, answers);
      if (!pageHidden) shown.add(item.id);
      continue;
    }
    const visible = !pageHidden && conditionMet(item.showIf, answers);
    if (visible) shown.add(item.id);
    for (const field of item.fields || []) {
      if (visible) {
        if (field in values) answers[field] = values[field];
      } else hiddenFields.add(field);
    }
  }
  return { shown, hiddenFields, answers };
}

// Pages of a form: the items between page breaks (the first page has no
// break). Pages whose break is hidden or that show nothing are skipped.
export function logicPages<T extends LogicItem>(items: T[], result: LogicResult) {
  const pages: { brk: T | null; items: T[] }[] = [{ brk: null, items: [] }];
  for (const item of items) {
    if (item.kind === "page") pages.push({ brk: item, items: [] });
    else pages.at(-1)!.items.push(item);
  }
  return pages
    .map((p) => ({ ...p, shown: p.items.filter((i) => result.shown.has(i.id)) }))
    .filter((p, i) => i === 0 || (p.brk && result.shown.has(p.brk.id) && p.shown.length));
}

// An answer as plain text (for placeholders and e-mails).
export function answerText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "boolean") return value ? "✓" : "";
  if (Array.isArray(value))
    return value
      .map((v) => (v && typeof v === "object" && "text" in v ? String((v as { text: unknown }).text) : String(v)))
      .filter(Boolean)
      .join(", ");
  return String(value).trim();
}

// {Question} placeholders: replaced by the answer to the question of that
// name (any case); unknown names stay as they are.
export function fillPlaceholders(text: string, answer: (name: string) => string | undefined, encode = false) {
  return text.replace(/\{([^{}\n]{1,300})\}/g, (whole, name: string) => {
    const value = answer(name.trim());
    if (value === undefined) return whole;
    return encode ? encodeURIComponent(value) : value;
  });
}
// Answers by question name, from the properties and the values.
export function answersByName(fields: { id: string; name: string; type?: string }[], values: Record<string, unknown>) {
  const byName = new Map<string, string>();
  for (const f of fields) {
    // People, relations and files are ids, not readable answers.
    if (["person", "relation", "files", "created_by", "updated_by"].includes(f.type || "")) continue;
    const key = f.name.trim().toLocaleLowerCase();
    if (!byName.has(key)) byName.set(key, answerText(values[f.id]));
  }
  return (name: string) => byName.get(name.toLocaleLowerCase());
}

// The redirect after sending: https only, and placeholders may not reach
// into the address's host (an answer must not choose the target site).
export const REDIRECT_PATTERN = /^https:\/\/[^\s/?#{}]+(?:[/?#]\S*)?$/i;
export const validRedirect = (url: string) => url === "" || REDIRECT_PATTERN.test(url);
export function redirectTarget(url: string | undefined, answer: (name: string) => string | undefined) {
  if (!url || !REDIRECT_PATTERN.test(url)) return null;
  const target = fillPlaceholders(url, answer, true);
  try {
    const parsed = new URL(target);
    return parsed.protocol === "https:" && parsed.host === new URL(url.replace(/\{[^{}]*\}/g, "")).host ? parsed.toString() : null;
  } catch {
    return null;
  }
}
