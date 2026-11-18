// A person's optimised FSRS weights (docs/specs/flashcards.md §23), stored
// in study_prefs.params: per deck (page_id = the deck) or for all their
// decks (page_id = ''), like their limits and retention. A deck uses its
// own weights, else the ones for all decks, else FSRS-6's defaults.
// Parts of a deck (#344) may have weights of their own: a sub-deck (a
// value of the select property the card mapping names as `subdeck`) or a
// card type, in study_prefs.group_params of the deck's row – a card uses
// its sub-deck's, else its card type's, else the deck's. Kept apart from
// `params`, so a deck's own weights read as before.
import { all, one } from "./db";
import { clampWeights, validWeights, type Fit } from "./fsrs/optimize";

export type ParamsScope = "deck" | "all";
// What study_prefs.params holds (JSON).
export type StoredParams = { version: 1; w: number[]; reviews: number; fit?: { before: Fit; after: Fit } };
export type ModelInfo = { source: "default" | ParamsScope; at: number | null; reviews: number | null; fit: StoredParams["fit"] | null };

// A part of a deck: "subdeck:<value>" or "type:<card type>".
export const GROUP_KEY = /^(subdeck:[^\u0000]{1,100}|type:(basic|cloze|typed|choice|occlusion))$/;
export const MAX_GROUPS = 100;
export type StoredGroup = StoredParams & { at: number };
export function parseGroups(raw: string | null | undefined): Map<string, StoredGroup> {
  const out = new Map<string, StoredGroup>();
  if (!raw) return out;
  try {
    const value = JSON.parse(raw) as Record<string, Partial<StoredGroup>>;
    for (const [key, entry] of Object.entries(value && typeof value === "object" ? value : {})) {
      const stored = GROUP_KEY.test(key) ? parseParams(JSON.stringify(entry)) : null;
      if (stored) out.set(key, { ...stored, at: Number(entry.at) || 0 });
    }
  } catch {
    // Unreadable: no weights of parts.
  }
  return out;
}
// The weights of the parts of a deck for the person.
export async function groupParams(userId: string, pageId: string) {
  const row = await one<{ group_params: string | null }>("SELECT group_params FROM study_prefs WHERE user_id=? AND page_id=?", userId, pageId);
  return parseGroups(row?.group_params);
}
// The value of a card's sub-deck property (a select: one value).
export function subdeckValue(cells: Record<string, unknown> | null | undefined, field: string | undefined) {
  if (!field || !cells) return null;
  const v = cells[field];
  const value = Array.isArray(v) ? v[0] : v;
  return typeof value === "string" && value.trim() ? value.slice(0, 100) : null;
}
// The part whose weights a card uses: its sub-deck's, else its type's.
export function groupOf(groups: { has(key: string): boolean }, card: { kind: string; subdeck: string | null }) {
  if (card.subdeck !== null && groups.has(`subdeck:${card.subdeck}`)) return `subdeck:${card.subdeck}`;
  if (groups.has(`type:${card.kind}`)) return `type:${card.kind}`;
  return null;
}

export function parseParams(raw: string | null | undefined): StoredParams | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<StoredParams>;
    if (!value || !validWeights(value.w)) return null;
    return { version: 1, w: clampWeights(value.w), reviews: Number(value.reviews) || 0, ...(value.fit ? { fit: value.fit } : {}) };
  } catch {
    return null;
  }
}
type Row = { page_id: string; params: string | null; params_at: number | null };
const info = (row: Row | undefined, scope: ParamsScope): (ModelInfo & { weights: number[] }) | null => {
  const stored = parseParams(row?.params);
  return stored ? { source: scope, at: row?.params_at == null ? null : Number(row.params_at), reviews: stored.reviews, fit: stored.fit ?? null, weights: stored.w } : null;
};
const DEFAULT_INFO: ModelInfo & { weights: null } = { source: "default", at: null, reviews: null, fit: null, weights: null };

// The weights a deck uses for the person, and where they come from.
export async function personalWeights(userId: string, pageId: string) {
  const rows = await all<Row>("SELECT page_id,params,params_at FROM study_prefs WHERE user_id=? AND page_id IN (?,'') AND params IS NOT NULL", userId, pageId);
  return (
    info(
      rows.find((r) => r.page_id === pageId && pageId !== ""),
      "deck",
    ) ??
    info(
      rows.find((r) => r.page_id === ""),
      "all",
    ) ??
    DEFAULT_INFO
  );
}
// The weights stored for one scope (for the "before" of a new fit).
export async function storedWeights(userId: string, pageId: string, scope: ParamsScope) {
  const row = await one<Row>("SELECT page_id,params,params_at FROM study_prefs WHERE user_id=? AND page_id=?", userId, scope === "all" ? "" : pageId);
  return info(row, scope);
}
// Every deck of the person with weights of its own.
export async function decksWithWeights(userId: string) {
  return new Set((await all<{ page_id: string }>("SELECT page_id FROM study_prefs WHERE user_id=? AND page_id<>'' AND params IS NOT NULL", userId)).map((r) => r.page_id));
}
