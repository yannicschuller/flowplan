import { aliasList } from "./aliases";
import { numberCell } from "./field-format";
import { z } from "zod";
import { validDateValue } from "./date-values";
import type { Field } from "./types";
import { isQuestion, surveyLogic, surveySchema, validateSurvey } from "./survey";
import { conditionSchema, evaluateLogic, validRedirect, type Condition, type LogicItem } from "./form-logic";
// Text blocks and page breaks between the questions of an ordinary form:
// placed before a question (`before`, a property id) or at the end ("").
export const formBlockSchema = z.object({
  id: z.string().min(1).max(60),
  kind: z.enum(["text", "page"]),
  before: z.string().max(500).default(""),
  title: z.string().max(300).default(""),
  body: z.string().max(5000).default(""),
  showIf: conditionSchema.optional(),
});
export type FormBlock = z.infer<typeof formBlockSchema>;
// What happens after an answer arrived; shared by forms and surveys.
export const formFollowUpSchema = z.object({
  // Thank-you page: then go to this address (https only; {Question}
  // placeholders after the host) after this many seconds.
  redirectUrl: z.string().max(500).refine(validRedirect, "Bitte eine Adresse mit https:// angeben.").default(""),
  redirectDelay: z.number().int().min(0).max(60).default(3),
  // A copy of the answers by e-mail to the person who answered.
  confirmation: z
    .object({
      enabled: z.boolean().default(false),
      subject: z.string().max(200).default(""),
      message: z.string().max(3000).default(""),
    })
    .default({ enabled: false, subject: "", message: "" }),
  // Members told about each new answer (notification kind "guest").
  notifyMembers: z.array(z.string().max(60)).max(50).default([]),
});
export const formConfigSchema = z.object({
  title: z.string().max(200).default(""),
  description: z.string().max(3000).default(""),
  submitLabel: z.string().min(1).max(80).default("Antwort senden"),
  successTitle: z.string().min(1).max(200).default("Vielen Dank!"),
  successMessage: z
    .string()
    .max(3000)
    .default("Deine Antwort wurde gespeichert."),
  fieldOrder: z.array(z.string()).max(80).default([]),
  hiddenFields: z.array(z.string()).max(80).default([]),
  requiredFields: z.array(z.string()).max(80).default([]),
  descriptions: z.record(z.string(), z.string().max(1000)).default({}),
  // How a question is asked: long text, choice buttons or a 1–10 scale.
  questionStyles: z
    .record(z.string(), z.enum(["long", "buttons", "scale"]))
    .default({}),
  // Customer portal: each request gets a private link with its status and a
  // conversation with the team; these properties are shown there.
  portal: z.boolean().default(false),
  portalFields: z.array(z.string()).max(80).default([]),
  // Conditions per question ("only show if …"), text blocks, page breaks and
  // a progress bar for ordinary forms (surveys keep theirs in `survey`).
  logic: z.record(z.string(), conditionSchema).default({}),
  blocks: z.array(formBlockSchema).max(100).default([]),
  progress: z.boolean().default(true),
  ...formFollowUpSchema.shape,
  // Survey mode (lib/survey.ts): question types, pages, conditions …
  survey: surveySchema.optional(),
});
// The stored defaults are German; readers see them in their language as
// long as nobody changed them.
export function localizedFormTexts(
  config: Pick<FormConfig, "submitLabel" | "successTitle" | "successMessage">,
  t: (de: string, en: string) => string,
) {
  return {
    submitLabel: config.submitLabel === "Antwort senden" ? t("Antwort senden", "Send answer") : config.submitLabel,
    successTitle: config.successTitle === "Vielen Dank!" ? t("Vielen Dank!", "Thank you!") : config.successTitle,
    successMessage:
      config.successMessage === "Deine Antwort wurde gespeichert."
        ? t("Deine Antwort wurde gespeichert.", "Your answer has been saved.")
        : config.successMessage,
  };
}
// Where the thank-you page leads; surveys saved before the shared setting
// kept their address in `survey.redirect` (followed only with https).
export function formRedirect(config: Pick<FormConfig, "redirectUrl" | "redirectDelay" | "survey">) {
  const legacy = config.survey?.redirect || "";
  const url = config.redirectUrl || (validRedirect(legacy) ? legacy : "");
  return url ? { url, delay: config.redirectUrl ? config.redirectDelay : 3 } : undefined;
}
export type QuestionStyle = "long" | "buttons" | "scale";
export const SCALE_MIN = 1,
  SCALE_MAX = 10;
// Styles that fit a property type; others are ignored.
export function questionStyles(field: Field): QuestionStyle[] {
  if (field.type === "text") return ["long"];
  if (field.type === "select") return ["buttons"];
  if (field.type === "number" && field.rollupDisplay !== "rating")
    return ["scale"];
  return [];
}
export function questionStyle(field: Field, config: FormConfig) {
  const style = config.questionStyles?.[field.id];
  return style && questionStyles(field).includes(style) ? style : undefined;
}
const PHONE = /^\+?[0-9 ()/.-]{3,30}$/;
export type FormConfig = z.infer<typeof formConfigSchema>;
export const FORM_FILES_PER_QUESTION = 5;
export const FORM_FILE_BYTES = 10 * 1024 * 1024;
export const FORM_TOTAL_BYTES = 25 * 1024 * 1024;
// People and relations reveal members and records, so only forms restricted
// to workspace members ask for them.
export function publicFormFields(fields: Field[], internal = false) {
  return fields.filter(
    (f) =>
      ![
        "formula",
        "rollup",
        "created_at",
        "updated_at",
        "created_by",
        "updated_by",
        "id",
        "progress",
        "time",
        ...(internal ? [] : ["person", "relation"]),
      ].includes(f.type),
  );
}
export function orderedFormFields(
  fields: Field[],
  config: FormConfig,
  internal = false,
) {
  const order = config.fieldOrder;
  return publicFormFields(fields, internal)
    .filter((f) => !config.hiddenFields.includes(f.id))
    .sort(
      (a, b) =>
        (order.includes(a.id) ? order.indexOf(a.id) : 999) -
        (order.includes(b.id) ? order.indexOf(b.id) : 999),
    );
}
// An ordinary form in order: questions with the text blocks and page
// breaks placed before them; blocks at the end (or before a question that
// is not asked) come last.
export type FormItem =
  | { kind: "question"; id: string; field: Field; showIf?: Condition }
  | (FormBlock & { kind: "text" | "page" });
export function formItems(fields: Field[], config: FormConfig, internal = false): FormItem[] {
  const questions = orderedFormFields(fields, config, internal);
  const asked = new Set(questions.map((f) => f.id));
  const items: FormItem[] = [];
  for (const f of questions) {
    items.push(...config.blocks.filter((b) => b.before === f.id));
    items.push({ kind: "question", id: f.id, field: f, showIf: config.logic[f.id] });
  }
  items.push(...config.blocks.filter((b) => !asked.has(b.before)));
  // A condition may only look at a question before it.
  const seen = new Set<string>();
  return items.map((item) => {
    const valid = !item.showIf || seen.has(item.showIf.field);
    if (item.kind === "question") seen.add(item.id);
    return valid ? item : { ...item, showIf: undefined };
  });
}
export const formLogicItems = (items: FormItem[]): LogicItem[] =>
  items.map((i) => ({ id: i.id, kind: i.kind, fields: i.kind === "question" ? [i.id] : [], showIf: i.showIf }));
// Which questions are shown for these answers – surveys and forms alike.
export function formLogic(fields: Field[], config: FormConfig, values: Record<string, unknown>, internal = false) {
  if (config.survey?.enabled) return surveyLogic(config.survey, values);
  return evaluateLogic(formLogicItems(formItems(fields, config, internal)), values);
}
export function validateFormValues(
  fields: Field[],
  config: FormConfig,
  values: Record<string, unknown>,
  internal = false,
) {
  if (config.survey?.enabled) {
    const result = validateSurvey(config.survey, fields, values);
    const logic = surveyLogic(config.survey, values);
    // Files: the uploaded addresses the form route put in (or File objects
    // in the browser); checked like in ordinary forms.
    for (const item of config.survey.items)
      if (isQuestion(item) && item.type === "file" && logic.shown.has(item.id)) {
        const value = values[item.field];
        if (Array.isArray(value) && value.length) {
          if (value.length > FORM_FILES_PER_QUESTION) result.errors[item.field] = "Zu viele Dateien.";
          else if (value.every((v) => typeof v === "string" && /^\/api\/files\/[0-9a-f-]{36}$/i.test(v))) result.cells[item.field] = value;
          else if (!value.every((v) => typeof File !== "undefined" && v instanceof File)) result.errors[item.field] = "Ungültige Datei.";
        } else if (item.required && item.kind === "question") result.errors[item.field] = "Bitte eine Datei wählen.";
      }
    return result;
  }
  const cells: Record<string, unknown> = {},
    errors: Record<string, string> = {};
  // Questions hidden by conditions are not required; their answers are
  // dropped.
  const logic = evaluateLogic(formLogicItems(formItems(fields, config, internal)), values);
  for (const f of orderedFormFields(fields, config, internal)) {
    if (logic.hiddenFields.has(f.id)) continue;
    const value = values[f.id],
      required = config.requiredFields.includes(f.id),
      empty =
        value === undefined ||
        value === null ||
        value === "" ||
        (typeof value === "string" && !value.trim()) ||
        (Array.isArray(value) && !value.length) ||
        (f.type === "checkbox" && value === false);
    if (required && empty) {
      errors[f.id] = `${f.name}: Bitte ausfüllen.`;
      continue;
    }
    if (value === undefined) continue;
    if (value === null) {
      if (f.type === "number") cells[f.id] = null;
      continue;
    }
    try {
      if (f.type === "checkbox") cells[f.id] = z.boolean().parse(value);
      else if (f.type === "number") {
        cells[f.id] = numberCell(f, value);
        if (
          questionStyle(f, config) === "scale" &&
          (!Number.isInteger(value) ||
            (value as number) < SCALE_MIN ||
            (value as number) > SCALE_MAX)
        )
          throw new Error();
      } else if (f.type === "multiselect") {
        const selected = z.array(z.string()).max(100).parse(value);
        if (selected.some((v) => !f.options?.includes(v))) throw new Error();
        cells[f.id] = [...new Set(selected)];
      } else if (f.type === "relation") {
        const ids = z.array(z.string().uuid()).max(100).parse(value);
        cells[f.id] = [...new Set(ids)];
      } else if (f.type === "files") {
        // Files are attached by the server from the submitted uploads.
        if (!Array.isArray(value)) throw new Error();
        if (value.length > FORM_FILES_PER_QUESTION) throw new Error();
        if (value.every((v) => typeof v === "string"))
          cells[f.id] = z
            .array(z.string().regex(/^\/api\/files\/[0-9a-f-]{36}$/i))
            .parse(value);
        else if (
          !value.every((v) => typeof File !== "undefined" && v instanceof File)
        )
          throw new Error();
      } else if (f.type === "aliases")
        cells[f.id] = aliasList(z.array(z.string().max(100)).max(10).parse(value));
      else if (f.type === "checklist")
        cells[f.id] = z
          .array(
            z.object({
              text: z.string().trim().min(1).max(500),
              done: z.boolean(),
            }),
          )
          .max(100)
          .parse(value);
      else {
        const text = z.string().max(10000).parse(value);
        if (f.type === "select" && text && !f.options?.includes(text))
          throw new Error();
        if (f.type === "email" && text) z.email().parse(text);
        if (f.type === "phone" && text && !PHONE.test(text)) throw new Error();
        if (
          f.type === "text" &&
          questionStyle(f, config) !== "long" &&
          text.includes("\n")
        )
          throw new Error();
        if (f.type === "url" && text)
          z.url({ protocol: /^https?$/ }).parse(text);
        if (f.type === "date" && text) {
          if (!validDateValue(text)) throw new Error();
        }
        cells[f.id] = text;
      }
    } catch {
      errors[f.id] = `${f.name}: Bitte eine gültige Eingabe verwenden.`;
    }
  }
  return { cells, errors };
}
