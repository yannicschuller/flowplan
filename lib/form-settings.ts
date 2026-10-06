import { numberCell } from "./field-format";
import { z } from "zod";
import { validDateValue } from "./date-values";
import type { Field } from "./types";
import { surveySchema, validateSurvey } from "./survey";
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
  // Survey mode (lib/survey.ts): question types, pages, conditions …
  survey: surveySchema.optional(),
});
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
export function validateFormValues(
  fields: Field[],
  config: FormConfig,
  values: Record<string, unknown>,
  internal = false,
) {
  if (config.survey?.enabled) {
    const result = validateSurvey(config.survey, fields, values);
    // Files: the uploaded addresses the form route put in (or File objects
    // in the browser); checked like in ordinary forms.
    for (const item of config.survey.items)
      if (item.kind === "question" && item.type === "file") {
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
  for (const f of orderedFormFields(fields, config, internal)) {
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
      } else if (f.type === "checklist")
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
