// Flashcards (docs/specs/flashcards.md §3.1): how the records of a database
// become cards – stored per database in `databases.settings.study`, so two
// study views of one database learn the same cards (their filters only pick
// a subset, like sub-decks) – and the small configuration of a view of type
// "study". Client-safe (zod only).
import { z } from "zod";

const fid = z.string().min(1).max(500);
// All card types of the concept (§5): basic (and its reverse), cloze, typed,
// choice and occlusion (masks over a picture in the record's document,
// lib/study-occlusion.ts).
export const cardTypes = ["basic", "cloze", "typed", "choice", "occlusion"] as const;
export type CardType = (typeof cardTypes)[number];
// The card type of a record: the same for all, or from a select property
// whose options are mapped to types (unmapped options by their name, see
// typeOfOption; anything else is basic).
const cardTypeSetting = z.union([
  z.object({ fixed: z.enum(cardTypes) }).strict(),
  z.object({ field: fid, map: z.record(z.string().max(100), z.enum(cardTypes)).optional() }).strict(),
]);
// Typed answers (§5.3): what the comparison ignores.
export const typedCompareSchema = z
  .object({ ignoreCase: z.boolean().default(true), ignoreAccents: z.boolean().default(false), ignorePunctuation: z.boolean().default(true) })
  .strict();
export type TypedCompare = z.infer<typeof typedCompareSchema>;
// A side of the card: a property (text) or the record's document – all of
// it, or the part above / below its first top-level horizontal rule (`---`,
// lib/study-content.ts).
const frontSource = z.union([z.object({ field: fid }).strict(), z.object({ document: z.enum(["above"]) }).strict()]);
const backSource = z.union([z.object({ field: fid }).strict(), z.object({ document: z.enum(["all", "below"]) }).strict()]);
const stepMinutes = z.number().positive().max(60 * 24 * 7);

export const studySettingsSchema = z.object({
  version: z.literal(1),
  type: cardTypeSetting.default({ fixed: "basic" }),
  front: frontSource,
  back: backSource,
  // Shown on request before revealing / after the answer.
  hint: z.object({ field: fid }).strict().optional(),
  extra: z.object({ field: fid }).strict().optional(),
  // Multiple choice (§5.4): the wrong options from a property (a
  // multi-select, or text with one option per line); without one, from the
  // backs of other cards of the deck the person may see.
  choices: z.object({ field: fid }).strict().optional(),
  // A tags property: generated options prefer cards with the same tags.
  tags: z.object({ field: fid }).strict().optional(),
  // A select property whose values are sub-decks (the Anki import's
  // "Deck"): each may get FSRS weights of its own (#344, lib/study-params.ts).
  subdeck: z.object({ field: fid }).strict().optional(),
  // A second card per record, back → front.
  reverse: z.boolean().default(false),
  // The deck's defaults; each person may override limits and retention for
  // themselves (study_prefs).
  newPerDay: z.number().int().min(0).max(9999).default(20),
  reviewsPerDay: z.number().int().min(0).max(99999).default(200),
  retention: z.number().min(0.7).max(0.99).default(0.9),
  learningSteps: z.array(stepMinutes).max(10).default([1, 10]),
  relearningSteps: z.array(stepMinutes).max(10).default([10]),
  maxInterval: z.number().int().min(1).max(36500).default(36500),
  // Siblings (the reverse card of a record) wait for the next study day once
  // one card of the record was studied (§4.7).
  buryNew: z.boolean().default(true),
  buryReviews: z.boolean().default(true),
  typedCompare: typedCompareSchema.default({ ignoreCase: true, ignoreAccents: false, ignorePunctuation: true }),
});
export type StudySettings = z.infer<typeof studySettingsSchema>;
// The types a side may come from: text-like properties (stored values).
export const STUDY_FIELD_TYPES: ReadonlySet<string> = new Set(["text", "url", "email", "phone", "select", "multiselect", "number"]);
// Options of a card type property read by their name (German and English,
// any letter case) when the mapping does not name them.
const TYPE_NAMES: [RegExp, CardType][] = [
  [/^(cloze|l(ü|ue)cke(ntext)?|l(ü|ue)ckentext)$/, "cloze"],
  [/^(typed|type( in)?( the)? answer|eintippen|antwort eintippen|tippen)$/, "typed"],
  [/^(choice|multiple[ -]?choice|mc|auswahl)$/, "choice"],
  [/^(occlusion|image occlusion|bildverdeckung)$/, "occlusion"],
];
export function typeOfOption(value: string, map?: Record<string, CardType>): CardType {
  if (map && value in map) return map[value];
  const name = value.trim().toLowerCase();
  if ((cardTypes as readonly string[]).includes(name)) return name as CardType;
  return TYPE_NAMES.find(([re]) => re.test(name))?.[1] ?? "basic";
}
export const STUDY_DEFAULTS = { newPerDay: 20, reviewsPerDay: 200, retention: 0.9 } as const;

// A view of type "study" (lib/database-schema.ts view.study).
export const studyViewSchema = z.object({
  order: z.enum(["due", "random"]).default("due"),
  newOrder: z.enum(["added", "random"]).default("added"),
  // New cards between reviews (every n-th card), before or after them.
  mixNew: z.enum(["mixed", "after", "before"]).default("mixed"),
});
export type StudyViewConfig = z.infer<typeof studyViewSchema>;

// A person's own settings for a deck (study.prefs): null keeps the deck's.
export const studyPrefsInput = z.object({
  newPerDay: z.number().int().min(0).max(9999).nullable().optional(),
  reviewsPerDay: z.number().int().min(0).max(99999).nullable().optional(),
  retention: z.number().min(0.7).max(0.99).nullable().optional(),
});

// A mapping that came with a template, a package or a copy: kept only when
// it still fits the properties (each one there and of a type a side may
// use, front and back different) – else the deck starts without one.
export function fittingStudySettings(raw: unknown, fields: { id: string; type: string }[]): StudySettings | undefined {
  const parsed = studySettingsSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const s = parsed.data;
  const ids = [s.front, s.back, s.hint, s.extra, s.choices, "field" in s.type ? s.type : undefined].flatMap((x) => (x && "field" in x ? [x.field] : []));
  if (ids.some((id) => !STUDY_FIELD_TYPES.has(fields.find((f) => f.id === id)?.type ?? ""))) return undefined;
  if (s.tags && !fields.some((f) => f.id === s.tags!.field)) return undefined;
  if (s.subdeck && fields.find((f) => f.id === s.subdeck!.field)?.type !== "select") return { ...s, subdeck: undefined };
  if (JSON.stringify(s.front) === JSON.stringify(s.back)) return undefined;
  return s;
}

// The first text property for a side, as the setup dialog suggests it.
export function suggestStudySettings(fields: { id: string; type: string }[]): StudySettings {
  const texts = fields.filter((f) => f.type === "text");
  const front = texts[0]?.id || fields[0]?.id || "title";
  const back = texts.find((f) => f.id !== front);
  return studySettingsSchema.parse({ version: 1, front: { field: front }, back: back ? { field: back.id } : { document: "all" } });
}
