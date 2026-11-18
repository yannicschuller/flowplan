// A person's optimised FSRS weights (docs/specs/flashcards.md §23), stored
// in study_prefs.params: per deck (page_id = the deck) or for all their
// decks (page_id = ''), like their limits and retention. A deck uses its
// own weights, else the ones for all decks, else FSRS-6's defaults.
import { all, one } from "./db";
import { clampWeights, validWeights, type Fit } from "./fsrs/optimize";

export type ParamsScope = "deck" | "all";
// What study_prefs.params holds (JSON).
export type StoredParams = { version: 1; w: number[]; reviews: number; fit?: { before: Fit; after: Fit } };
export type ModelInfo = { source: "default" | ParamsScope; at: number | null; reviews: number | null; fit: StoredParams["fit"] | null };

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
