// Saving a survey from the builder in one step: questions become
// properties (new ones are created, renamed ones keep their answers; a
// changed answer type gets a new property so earlier answers stay), and the
// form settings follow the survey (order, required, hidden, hints).
import { z } from "zod";
import { id, one, run } from "./db";
import { HttpError } from "./auth";
import { field as fieldSchema } from "./database-schema";
import { formConfigSchema, publicFormFields } from "./form-settings";
import { formSettings } from "./forms";
import { isQuestion, questionFields, storageType, surveySchema, type Survey, type SurveyItem } from "./survey";
import { newQuestion } from "./survey";
import type { Field, Page } from "./types";

const inputSchema = z.object({
  version: z.number().int(),
  survey: surveySchema,
  // Question texts and choices, by question id.
  questions: z.record(z.string().max(60), z.object({ title: z.string().trim().min(1).max(300), options: z.array(z.string().trim().min(1).max(100)).max(60).optional() })),
  form: z
    .object({
      title: z.string().max(200).default(""),
      description: z.string().max(3000).default(""),
      submitLabel: z.string().min(1).max(80),
      successTitle: z.string().min(1).max(200),
      successMessage: z.string().max(3000).default(""),
    })
    .partial()
    .default({}),
});

export function saveSurvey(page: Pick<Page, "id">, raw: unknown) {
  const b = inputSchema.parse(raw);
  const db = one<{ fields: string; version: number }>("SELECT fields,version FROM databases WHERE page_id=?", page.id);
  if (!db) throw new HttpError(404, "Datenbank nicht gefunden.");
  if (db.version !== b.version) throw new HttpError(409, "Die Datenbank wurde zwischenzeitlich geändert. Bitte neu laden.");
  const fields: Field[] = JSON.parse(db.fields);
  const refs = new Map<string, string>();
  const want = (ref: string, name: string, type: Field["type"], options?: string[]) => {
    const existing = ref.startsWith("new:") ? undefined : fields.find((f) => f.id === ref);
    if (existing && existing.type === type) {
      existing.name = name;
      if (options) existing.options = [...new Set(options)];
      refs.set(ref, existing.id);
      return;
    }
    const created: Field = { id: `q${id().slice(0, 7)}`, name: unique(name, fields), type, ...(options ? { options: [...new Set(options)] } : {}) };
    fields.push(created);
    refs.set(ref, created.id);
  };
  for (const item of b.survey.items) {
    if (!isQuestion(item)) continue;
    const text = b.questions[item.id];
    if (!text) throw new HttpError(400, "Eine Frage hat keinen Text.");
    if (item.type === "matrix") {
      if (!item.rows.length || item.columns.length < 2) throw new HttpError(400, `„${text.title}“: Eine Matrix braucht Zeilen und mindestens zwei Spalten.`);
      for (const row of item.rows) want(row.field, `${text.title} – ${row.label}`.slice(0, 300), "select", item.columns);
      continue;
    }
    const choice = ["single", "dropdown", "multiple", "ranking", "yesno"].includes(item.type);
    if (choice && !text.options?.length) throw new HttpError(400, `„${text.title}“: Bitte mindestens eine Antwort angeben.`);
    want(item.field, text.title, storageType[item.type], choice ? text.options : undefined);
  }
  if (fields.length > 80) throw new HttpError(400, "Eine Datenbank hat höchstens 80 Eigenschaften – bitte weniger Fragen.");
  const map = (ref: string) => refs.get(ref) || ref;
  const items: SurveyItem[] = b.survey.items.map((item) => {
    const showIf = item.kind !== "page" && item.showIf ? { ...item.showIf, field: map(item.showIf.field) } : undefined;
    if (!isQuestion(item)) return item.kind === "text" ? { ...item, showIf } : item;
    return { ...item, title: b.questions[item.id].title, field: item.type === "matrix" ? map(item.rows[0].field) : map(item.field), rows: item.rows.map((r) => ({ ...r, field: map(r.field) })), showIf };
  });
  // Conditions may only look at questions before them.
  const seen = new Set<string>();
  for (const item of items) {
    if (item.kind !== "page" && item.showIf && !seen.has(item.showIf.field)) throw new HttpError(400, "Eine Bedingung verweist auf eine spätere oder fehlende Frage.");
    if (isQuestion(item)) questionFields(item).forEach((f) => seen.add(f));
  }
  const survey: Survey = { ...b.survey, items };
  const stored = z.array(fieldSchema).max(80).parse(fields);
  run("UPDATE databases SET fields=?,version=version+1 WHERE page_id=?", JSON.stringify(stored), page.id);

  // Form settings follow the survey, so other places show the same questions.
  const previous = formSettings(page.id);
  const config = previous?.config || formConfigSchema.parse({});
  const questions = items.filter(isQuestion);
  const asked = questions.flatMap(questionFields);
  const next = formConfigSchema.parse({
    ...config,
    ...Object.fromEntries(Object.entries(b.form).filter(([, v]) => v !== undefined)),
    fieldOrder: asked,
    requiredFields: questions.filter((q) => q.required).flatMap(questionFields),
    hiddenFields: publicFormFields(stored, true)
      .map((f) => f.id)
      .filter((f) => !asked.includes(f)),
    descriptions: Object.fromEntries(questions.filter((q) => q.description).map((q) => [q.field, q.description])),
    questionStyles: Object.fromEntries(
      questions.flatMap((q) => (q.type === "long" ? [[q.field, "long"]] : ["single", "yesno"].includes(q.type) ? [[q.field, "buttons"]] : [])),
    ),
    survey,
  });
  run(
    "INSERT INTO forms(page_id,token,enabled,internal,anonymous,config) VALUES(?,?,?,?,?,?) ON CONFLICT(page_id) DO UPDATE SET config=excluded.config",
    page.id,
    id(),
    previous?.enabled ?? 0,
    previous?.internal ?? 1,
    previous?.anonymous ?? 0,
    JSON.stringify(next),
  );
  return { fields: Object.fromEntries(refs), survey };
}

function unique(name: string, fields: Field[]) {
  let candidate = name.slice(0, 300);
  for (let n = 2; fields.some((f) => f.name === candidate); n++) candidate = `${name.slice(0, 290)} (${n})`;
  return candidate;
}

// A starter survey for the "Survey" template: recommendation (NPS), what
// people use, and an open question for low scores.
export function starterSurvey(pageId: string, de: boolean) {
  const version = one<{ version: number }>("SELECT version FROM databases WHERE page_id=?", pageId)!.version;
  const nps = newQuestion("nps", de),
    use = newQuestion("multiple", de),
    why = newQuestion("long", de);
  use.title = de ? "Was nutzt du am meisten?" : "What do you use most?";
  use.options = de ? ["Dokumente", "Datenbanken", "Whiteboards", "Journal"] : ["Documents", "Databases", "Whiteboards", "Journal"];
  why.title = de ? "Was sollten wir besser machen?" : "What should we improve?";
  nps.question.required = true;
  why.question.showIf = { field: nps.question.field, op: "lte", value: "6" };
  return saveSurvey(
    { id: pageId },
    {
      version,
      survey: { enabled: true, items: [nps.question, use.question, why.question], welcome: { enabled: true, title: "", text: "", button: "" } },
      questions: Object.fromEntries([nps, use, why].map((q) => [q.question.id, { title: q.title, options: q.options }])),
      form: { submitLabel: de ? "Absenden" : "Submit", successTitle: de ? "Danke für deine Antwort!" : "Thanks for your answer!" },
    },
  );
}
