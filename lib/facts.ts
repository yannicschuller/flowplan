// Numbers about Flowplan that the website and the documentation quote –
// "ten views", "23 property types", "three languages". They are counted
// here from the code itself, so the texts never drift from what the app
// does. `npm run facts` writes them to facts.json in the repository root
// (scripts/facts.mjs); the two sites read that file at build time and
// tests/facts.test.ts fails when it is out of date.
import { field, view } from "./database-schema";
import { surveyTypes } from "./survey";
import { LANGUAGES } from "./i18n";
import { CALLOUT_TYPES } from "./document-schema";
import { templateKeys } from "./template-catalog";
import { templateCategoryIds } from "./template-categories";
import type { FieldType, View } from "./types";
import type { MarkdownExportOptions } from "./markdown-export";

// `true` only when the list and the union name the same members, so a new
// member of either side fails the type check until both agree.
type Same<List extends readonly string[], Union extends string> = [
  Exclude<Union, List[number]>,
] extends [never]
  ? [Exclude<List[number], Union>] extends [never]
    ? true
    : never
  : never;

// The view and property types come from the validation schema, which the
// types in lib/types.ts must match.
export const viewTypes = view.shape.type.options;
export const fieldTypes = field.shape.type.options;
// Formats of the export menu (lib/markdown-export.ts).
export const exportFormats = ["markdown", "zip"] as const;
const checks: [
  Same<typeof viewTypes, View["type"]>,
  Same<typeof fieldTypes, FieldType>,
  Same<typeof exportFormats, MarkdownExportOptions["format"]>,
] = [true, true, true];
void checks;

export type Facts = ReturnType<typeof facts>;
export function facts() {
  const languages = Object.keys(LANGUAGES) as (keyof typeof LANGUAGES)[];
  return {
    views: viewTypes.length,
    fieldTypes: fieldTypes.length,
    questionTypes: surveyTypes.length,
    languages: languages.length,
    calloutTypes: CALLOUT_TYPES.length,
    exportFormats: exportFormats.length,
    templates: templateKeys.length,
    templateCategories: templateCategoryIds.length,
    names: {
      views: [...viewTypes],
      fieldTypes: [...fieldTypes],
      questionTypes: [...surveyTypes],
      languages: Object.fromEntries(
        languages.map((code) => [code, LANGUAGES[code].name]),
      ) as Record<keyof typeof LANGUAGES, string>,
      calloutTypes: [...CALLOUT_TYPES],
      exportFormats: [...exportFormats],
      templateCategories: [...templateCategoryIds],
    },
  };
}
// The file content of facts.json: stable key order, two-space indent.
export const factsJson = () => JSON.stringify(facts(), null, 2) + "\n";
