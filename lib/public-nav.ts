// Getting around a published or shared database (#393, components/public-page.tsx):
// a record opened from a view carries the view's state in its address
// (?row=…&view=…&month=…), so its page offers "← Back to <view>" to the
// same view, month and scroll position; and the last item of the path is
// the record's title – when visitors may read the title property.
// Plain functions (no database, no React): the server page and the client
// helpers (components/public-view-memory.tsx) share them.
import { cellText } from "./cell-text";
import type { Field } from "./types";

// The query parameters that make up a view's state (the view, its month,
// a timeline's scale or period, the part of a deck's cards), in the order
// they are written.
export const VIEW_STATE_KEYS = ["view", "month", "scale", "period", "cards"] as const;
export type ViewStateKey = (typeof VIEW_STATE_KEYS)[number];
export type ViewState = Partial<Record<ViewStateKey, string>>;
type Query = URLSearchParams | Record<string, string | string[] | undefined> | null | undefined;

// Ids, months ("2026-11"), scales ("week") and numbers – nothing else is
// passed on into a link.
const SAFE = /^[\w.:-]{1,80}$/;

export function viewStateOf(query: Query): ViewState {
  const state: ViewState = {};
  if (!query) return state;
  for (const key of VIEW_STATE_KEYS) {
    const raw = query instanceof URLSearchParams ? query.get(key) : query[key];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value === "string" && SAFE.test(value)) state[key] = value;
  }
  return state;
}
export function viewStateQuery(state: ViewState) {
  return VIEW_STATE_KEYS.filter((key) => state[key])
    .map((key) => `${key}=${encodeURIComponent(state[key]!)}`)
    .join("&");
}
// A record opened from a view: its address keeps the view's state.
export function recordHref(base: string, rowId: string, state: ViewState = {}) {
  const query = viewStateQuery(state);
  return `${base}?row=${encodeURIComponent(rowId)}${query ? `&${query}` : ""}`;
}
// Back from the record: the view with the same state.
export function viewHref(base: string, state: ViewState) {
  const query = viewStateQuery(state);
  return query ? `${base}?${query}` : base;
}
// Where a view's scroll position waits in sessionStorage (per tab) until
// the back link returns to it; RETURN_KEY names the view being returned to.
export const viewScrollKey = (pageId: string, state: ViewState) => `flowplan-public-view:${pageId}?${viewStateQuery(state)}`;
export const RETURN_KEY = "flowplan-public-return";

export function truncateTitle(text: string, max = 60) {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}
// The record's title for the path, or null (the caller shows the generic
// "Eintrag"): only when the title property – the database's first – is
// one visitors may read (`publicIds`, lib/shared-content.ts publicFieldIds)
// and the record has one.
export function recordCrumb(cells: Record<string, unknown>, fields: Field[], publicIds: Set<string>, max = 60) {
  const title = fields[0];
  if (!title || !publicIds.has(title.id)) return null;
  const text = truncateTitle(cellText(cells[title.id]), max);
  return text || null;
}
