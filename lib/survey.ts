// Surveys: a form in "survey" mode – question types beyond the property
// types (stars, NPS, scales, sliders, matrix, ranking, yes/no …), pages,
// text blocks, conditions ("only show if …"), welcome and thank-you screens,
// a closing date, a response limit and one response per person. Every
// answer is still a record: each question is a property of the database
// (a matrix has one per row). Client-safe: the same checks run in the
// browser and on the server.
import { z } from "zod";
import { validDateValue } from "./date-values";
import type { Field, FieldType } from "./types";

export const surveyTypes = [
  "short",
  "long",
  "single",
  "dropdown",
  "multiple",
  "yesno",
  "rating",
  "nps",
  "scale",
  "slider",
  "number",
  "email",
  "phone",
  "url",
  "date",
  "time",
  "file",
  "matrix",
  "ranking",
] as const;
export type SurveyType = (typeof surveyTypes)[number];

// The property type that stores the answer.
export const storageType: Record<SurveyType, FieldType> = {
  short: "text",
  long: "text",
  single: "select",
  dropdown: "select",
  multiple: "multiselect",
  yesno: "select",
  rating: "number",
  nps: "number",
  scale: "number",
  slider: "number",
  number: "number",
  email: "email",
  phone: "phone",
  url: "url",
  date: "date",
  time: "text",
  file: "files",
  matrix: "select",
  ranking: "multiselect",
};
export const choiceTypes = new Set<SurveyType>(["single", "dropdown", "multiple", "ranking"]);

const fid = z.string().min(1).max(500);
export const conditionSchema = z.object({
  field: fid,
  op: z.enum(["is", "isNot", "includes", "answered", "notAnswered", "gte", "lte"]),
  value: z.string().max(300).default(""),
});
export type Condition = z.infer<typeof conditionSchema>;

const questionSchema = z.object({
  kind: z.literal("question"),
  id: z.string().min(1).max(60),
  type: z.enum(surveyTypes),
  // The property holding the answer (a matrix: one per row, in `rows`).
  field: fid,
  // The question as asked (the property is named after it).
  title: z.string().max(300).default(""),
  description: z.string().max(1000).default(""),
  placeholder: z.string().max(200).default(""),
  required: z.boolean().default(false),
  // Choices: an "Other" field and a shuffled order.
  other: z.boolean().default(false),
  randomize: z.boolean().default(false),
  minChoices: z.number().int().min(0).max(100).optional(),
  maxChoices: z.number().int().min(1).max(100).optional(),
  // Numbers, scales, sliders and stars.
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
  step: z.number().positive().finite().optional(),
  minLabel: z.string().max(80).default(""),
  maxLabel: z.string().max(80).default(""),
  // Matrix (Likert): rows are properties, columns the answers of each row.
  rows: z.array(z.object({ field: fid, label: z.string().min(1).max(300) })).max(30).default([]),
  columns: z.array(z.string().min(1).max(100)).max(12).default([]),
  showIf: conditionSchema.optional(),
});
const textSchema = z.object({
  kind: z.literal("text"),
  id: z.string().min(1).max(60),
  title: z.string().max(300).default(""),
  body: z.string().max(5000).default(""),
  showIf: conditionSchema.optional(),
});
const pageSchema = z.object({
  kind: z.literal("page"),
  id: z.string().min(1).max(60),
  title: z.string().max(300).default(""),
});
export const surveyItemSchema = z.discriminatedUnion("kind", [questionSchema, textSchema, pageSchema]);
export type SurveyItem = z.infer<typeof surveyItemSchema>;
export type SurveyQuestion = z.infer<typeof questionSchema>;

export const surveySchema = z.object({
  enabled: z.boolean().default(false),
  items: z.array(surveyItemSchema).max(300).default([]),
  welcome: z.object({ enabled: z.boolean().default(false), title: z.string().max(200).default(""), text: z.string().max(3000).default(""), button: z.string().max(60).default("") }).default({ enabled: false, title: "", text: "", button: "" }),
  progress: z.boolean().default(true),
  closesAt: z.string().max(40).optional(),
  limit: z.number().int().min(1).max(1_000_000).optional(),
  onePerPerson: z.boolean().default(false),
  redirect: z.string().max(500).optional(),
  accent: z.enum(["blue", "violet", "green", "orange", "rose", "slate"]).default("blue"),
});
export type Survey = z.infer<typeof surveySchema>;

export const isQuestion = (item: SurveyItem): item is SurveyQuestion => item.kind === "question";
// All properties a question writes to.
export const questionFields = (q: SurveyQuestion) => (q.type === "matrix" ? q.rows.map((r) => r.field) : [q.field]);

// Default ranges per type.
export function range(q: SurveyQuestion) {
  if (q.type === "nps") return { min: 0, max: 10, step: 1 };
  if (q.type === "rating") return { min: 1, max: Math.min(10, Math.max(3, q.max ?? 5)), step: 1 };
  if (q.type === "scale") return { min: q.min ?? 1, max: q.max ?? 5, step: 1 };
  if (q.type === "slider") return { min: q.min ?? 0, max: q.max ?? 100, step: q.step ?? 1 };
  return { min: q.min, max: q.max, step: q.step };
}

const empty = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length);

// Is a condition met by the answers so far?
export function conditionMet(c: Condition | undefined, values: Record<string, unknown>) {
  if (!c) return true;
  const v = values[c.field];
  const list = Array.isArray(v) ? v.map(String) : empty(v) ? [] : [String(v)];
  switch (c.op) {
    case "answered":
      return list.length > 0;
    case "notAnswered":
      return list.length === 0;
    case "is":
      return list.length === 1 && list[0] === c.value;
    case "isNot":
      return !(list.length === 1 && list[0] === c.value);
    case "includes":
      return list.includes(c.value);
    case "gte":
      return list.length > 0 && Number(list[0]) >= Number(c.value);
    case "lte":
      return list.length > 0 && Number(list[0]) <= Number(c.value);
  }
}

// Pages: groups of items between page breaks (the first page has no break).
export function surveyPages(survey: Survey) {
  const pages: { title: string; items: SurveyItem[] }[] = [{ title: "", items: [] }];
  for (const item of survey.items) {
    if (item.kind === "page") pages.push({ title: item.title, items: [] });
    else pages.at(-1)!.items.push(item);
  }
  return pages.filter((p, i) => i === 0 || p.items.length || p.title);
}
export const visible = (item: SurveyItem, values: Record<string, unknown>) => item.kind === "page" || conditionMet(item.showIf, values);

// Is the survey open right now?
export function surveyClosed(survey: Survey, responses: number, now = new Date()) {
  if (survey.closesAt && now.toISOString() > survey.closesAt) return "closed" as const;
  if (survey.limit && responses >= survey.limit) return "full" as const;
  return null;
}

const PHONE = /^\+?[0-9 ()/.-]{3,30}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

// Checks the answers of the questions that are shown; returns the cells to
// store and messages per property. Files are checked by the form route.
export function validateSurvey(survey: Survey, fields: Field[], values: Record<string, unknown>, de = true) {
  const cells: Record<string, unknown> = {},
    errors: Record<string, string> = {};
  const say = (a: string, b: string) => (de ? a : b);
  for (const item of survey.items) {
    if (!isQuestion(item) || !visible(item, values)) continue;
    const q = item;
    const name = (id: string) => fields.find((f) => f.id === id)?.name || say("Frage", "Question");
    if (q.type === "matrix") {
      for (const row of q.rows) {
        const v = values[row.field];
        if (empty(v)) {
          if (q.required) errors[row.field] = `${row.label}: ${say("Bitte eine Antwort wählen.", "Please choose an answer.")}`;
          continue;
        }
        if (typeof v !== "string" || !q.columns.includes(v)) errors[row.field] = `${row.label}: ${say("Ungültige Antwort.", "Invalid answer.")}`;
        else cells[row.field] = v;
      }
      continue;
    }
    const field = fields.find((f) => f.id === q.field);
    if (!field) continue;
    const v = values[q.field];
    const label = name(q.field);
    if (empty(v)) {
      if (q.required) errors[q.field] = `${label}: ${say("Bitte ausfüllen.", "Please answer.")}`;
      continue;
    }
    const bad = (de2: string, en: string) => (errors[q.field] = `${label}: ${say(de2, en)}`);
    const options = field.options || [];
    if (q.type === "file") continue;
    if (["single", "dropdown", "yesno"].includes(q.type)) {
      if (typeof v !== "string" || v.length > 300 || (!options.includes(v) && !(q.other && q.type !== "yesno" && v.trim()))) bad("Bitte eine der Antworten wählen.", "Please choose one of the answers.");
      else cells[q.field] = v.trim();
    } else if (q.type === "multiple" || q.type === "ranking") {
      if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || x.length > 300)) {
        bad("Ungültige Auswahl.", "Invalid selection.");
        continue;
      }
      const list = [...new Set(v as string[])];
      const unknown = list.filter((x) => !options.includes(x));
      if (unknown.length > (q.type === "multiple" && q.other ? 1 : 0)) bad("Ungültige Auswahl.", "Invalid selection.");
      else if (q.type === "ranking" && list.length !== options.length) bad("Bitte alle Einträge ordnen.", "Please rank all items.");
      else if (q.minChoices && list.length < q.minChoices) bad(`Bitte mindestens ${q.minChoices} wählen.`, `Please choose at least ${q.minChoices}.`);
      else if (q.maxChoices && list.length > q.maxChoices) bad(`Bitte höchstens ${q.maxChoices} wählen.`, `Please choose at most ${q.maxChoices}.`);
      else cells[q.field] = list;
    } else if (["rating", "nps", "scale", "slider", "number"].includes(q.type)) {
      const n = typeof v === "number" ? v : Number(String(v).replace(",", "."));
      const r = range(q);
      if (!Number.isFinite(n)) bad("Bitte eine Zahl angeben.", "Please enter a number.");
      else if ((r.min !== undefined && n < r.min) || (r.max !== undefined && n > r.max)) bad(`Bitte zwischen ${r.min ?? "…"} und ${r.max ?? "…"}.`, `Please between ${r.min ?? "…"} and ${r.max ?? "…"}.`);
      else if (q.type !== "number" && q.type !== "slider" && !Number.isInteger(n)) bad("Bitte eine ganze Zahl.", "Please a whole number.");
      else cells[q.field] = n;
    } else {
      if (typeof v !== "string") {
        bad("Ungültige Eingabe.", "Invalid input.");
        continue;
      }
      const text = v.trim();
      if (text.length > (q.type === "long" ? 10000 : 1000)) bad("Zu lang.", "Too long.");
      else if (q.type === "short" && /\n/.test(text)) bad("Bitte nur eine Zeile.", "Please a single line.");
      else if (q.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) bad("Bitte eine gültige E-Mail-Adresse.", "Please a valid e-mail address.");
      else if (q.type === "phone" && !PHONE.test(text)) bad("Bitte eine gültige Telefonnummer.", "Please a valid phone number.");
      else if (q.type === "url" && !/^https?:\/\/\S+$/i.test(text)) bad("Bitte eine Adresse mit https://.", "Please an address with https://.");
      else if (q.type === "date" && !validDateValue(text)) bad("Bitte ein gültiges Datum.", "Please a valid date.");
      else if (q.type === "time" && !TIME.test(text)) bad("Bitte eine Uhrzeit wie 14:30.", "Please a time like 14:30.");
      else cells[q.field] = text;
    }
  }
  return { cells, errors };
}

// A new question of a type with sensible defaults (options in the reader's
// language; the property is created when the survey is saved).
export function newQuestion(type: SurveyType, de: boolean): { question: SurveyQuestion; title: string; options?: string[] } {
  const id = Math.random().toString(36).slice(2, 10);
  const base = { kind: "question" as const, id, type, field: `new:${id}`, title: "", description: "", placeholder: "", required: false, other: false, randomize: false, minLabel: "", maxLabel: "", rows: [], columns: [] };
  const t = (a: string, b: string) => (de ? a : b);
  switch (type) {
    case "single":
    case "dropdown":
    case "multiple":
      return { question: base, title: t("Deine Frage", "Your question"), options: [t("Option 1", "Option 1"), t("Option 2", "Option 2"), t("Option 3", "Option 3")] };
    case "ranking":
      return { question: base, title: t("Bring in eine Reihenfolge", "Put in order"), options: ["A", "B", "C"] };
    case "yesno":
      return { question: base, title: t("Ja oder nein?", "Yes or no?"), options: [t("Ja", "Yes"), t("Nein", "No")] };
    case "rating":
      return { question: { ...base, max: 5 }, title: t("Wie zufrieden bist du?", "How satisfied are you?") };
    case "nps":
      return {
        question: { ...base, minLabel: t("Gar nicht wahrscheinlich", "Not at all likely"), maxLabel: t("Sehr wahrscheinlich", "Extremely likely") },
        title: t("Wie wahrscheinlich ist es, dass du uns weiterempfiehlst?", "How likely are you to recommend us?"),
      };
    case "scale":
      return { question: { ...base, min: 1, max: 5, minLabel: t("Stimme gar nicht zu", "Strongly disagree"), maxLabel: t("Stimme voll zu", "Strongly agree") }, title: t("Wie sehr stimmst du zu?", "How much do you agree?") };
    case "slider":
      return { question: { ...base, min: 0, max: 100, step: 1 }, title: t("Wähle einen Wert", "Pick a value") };
    case "matrix":
      return {
        question: {
          ...base,
          rows: [
            { field: `new:${id}-1`, label: t("Aussage 1", "Statement 1") },
            { field: `new:${id}-2`, label: t("Aussage 2", "Statement 2") },
          ],
          columns: de ? ["Stimme gar nicht zu", "Eher nicht", "Neutral", "Eher ja", "Stimme voll zu"] : ["Strongly disagree", "Disagree", "Neutral", "Agree", "Strongly agree"],
        },
        title: t("Bewerte die Aussagen", "Rate the statements"),
      };
    default:
      return {
        question: base,
        title: {
          short: t("Kurze Antwort", "Short answer"),
          long: t("Ausführliche Antwort", "Detailed answer"),
          number: t("Eine Zahl", "A number"),
          email: t("Deine E-Mail-Adresse", "Your e-mail address"),
          phone: t("Deine Telefonnummer", "Your phone number"),
          url: t("Website", "Website"),
          date: t("Datum", "Date"),
          time: t("Uhrzeit", "Time"),
          file: t("Datei hochladen", "Upload a file"),
        }[type as "short"] || t("Frage", "Question"),
      };
  }
}
