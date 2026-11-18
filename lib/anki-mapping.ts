// The Anki import's mapping (docs/specs/flashcards.md §8.1), shared by the
// server (lib/importers/anki.ts) and the wizard
// (components/study/anki-import.tsx): per note type the card type, whether
// every note gets a reverse card, and what each field becomes. The preview
// suggests it, the person may change it. Client-safe (zod only).
import { z } from "zod";

export const ANKI_ROLES = ["front", "back", "hint", "extra", "skip"] as const;
export type AnkiRole = (typeof ANKI_ROLES)[number];
export const ANKI_CARD_TYPES = ["basic", "typed", "cloze"] as const;
export type AnkiCardType = (typeof ANKI_CARD_TYPES)[number];
// What a note type is in Anki (its stock kind, else by name and templates).
export type AnkiKind = "basic" | "reversed" | "optional" | "typed" | "cloze" | "occlusion" | "custom";

export const notetypeMappingSchema = z.object({
  type: z.enum(ANKI_CARD_TYPES),
  reverse: z.boolean(),
  roles: z.array(z.enum(ANKI_ROLES)).max(50),
});
export type NotetypeMapping = z.infer<typeof notetypeMappingSchema>;
export const ankiOptionsSchema = z.object({
  // By note type id; note types left out keep the suggestion.
  notetypes: z.record(z.string().regex(/^-?\d{1,20}$/), notetypeMappingSchema).default({}),
  // The person's own learning state from Anki's review log (§8.1).
  state: z.boolean().default(false),
});
export type AnkiOptions = z.infer<typeof ankiOptionsSchema>;

// What the preview tells the wizard.
export type AnkiPreview = {
  format: "anki2" | "anki21" | "anki21b";
  notes: number;
  cards: number;
  reviews: number;
  suspended: number;
  media: { files: number; bytes: number; missing: number; skipped: number };
  // One database per top-level deck; its sub-decks as values of "Deck".
  decks: { name: string; notes: number; subdecks: string[]; rich: boolean; reverse: boolean }[];
  notetypes: {
    id: string;
    name: string;
    kind: AnkiKind;
    notes: number;
    fields: { name: string; sample: string }[];
    mapping: NotetypeMapping;
    // Up to three notes as the mapping turns them into cards (plain text).
    samples: { front: string; back: string }[];
  }[];
};
