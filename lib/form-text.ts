// Formatted descriptions of forms and their questions (#306): inline
// Markdown with bracketed spans (lib/inline-markdown.ts, `{ spans: true }`)
// – bold, italic, underline, strike, code, links (http, https, mailto),
// the document editor's text colours and line breaks. Descriptions saved
// before are plain text and read the same way: their line breaks stay, and
// they only change their look if they happen to contain Markdown.
//
// Rendering never goes through HTML (components/inline-text.tsx).
import { normalizeInline, parseInline, toPlain, type InlineOptions } from "./inline-markdown";
import type { FormConfig } from "./form-settings";
import type { Survey } from "./survey";

export const FORM_TEXT: InlineOptions = { spans: true };

// The stored form of a description: formatting as the editor writes it,
// unsafe links reduced to their label, unknown classes dropped. A text
// without any formatting stays exactly as written (legacy plain text keeps
// its characters instead of gaining backslashes).
export function cleanFormText(value: string): string {
  const runs = parseInline(value, FORM_TEXT);
  const plain = runs.every((r) => !r.bold && !r.italic && !r.strike && !r.code && !r.href && !r.underline && !r.color);
  if (plain && runs.map((r) => r.text).join("") === value.replace(/\r\n?/g, "\n")) return value;
  return normalizeInline(value, FORM_TEXT);
}

// The text of a description without its formatting.
export const formTextPlain = (value: unknown) => toPlain(value, FORM_TEXT);

// The descriptions of a form's settings (and of its survey's questions),
// cleaned for storing.
export function cleanFormConfigTexts(config: FormConfig): FormConfig {
  return {
    ...config,
    description: cleanFormText(config.description),
    descriptions: Object.fromEntries(Object.entries(config.descriptions).map(([k, v]) => [k, cleanFormText(v)])),
    ...(config.survey ? { survey: cleanSurveyTexts(config.survey) } : {}),
  };
}

export function cleanSurveyTexts(survey: Survey): Survey {
  return { ...survey, items: survey.items.map((item) => (item.kind === "question" ? { ...item, description: cleanFormText(item.description) } : item)) };
}
