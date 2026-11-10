// Favourite pens (Lieblingsstifte): a tool with its colour and width – for
// text the size and face – picked with one tap from the toolbar or the pen
// panel. Up to MAX_FAVORITES, in the person's order, remembered on this
// device (localStorage, like the other ink choices in presets.ts; there is
// no per-person store for ink settings on the server).
//
// The three favourite pens of earlier versions (key "flowplan-ink-presets",
// always exactly three pen/highlighter entries that followed colour and
// width changes) become the first favourites once; that key is left as it
// was, so an older version of the app still finds its three pens.
import { isInkFont, type InkFont } from "./fonts";
import { DEFAULT_PRESETS, clampWidth, loadPresets } from "./presets";

export type InkFavoriteType = "pen" | "highlighter" | "text";
export type InkFavorite = { type: InkFavoriteType; color: string; width: number; font?: InkFont };

export const MAX_FAVORITES = 8;
export const DEFAULT_FAVORITES: InkFavorite[] = DEFAULT_PRESETS.map((p) => ({ ...p }));

const KEY = "flowplan-ink-favorites";
const LEGACY_KEY = "flowplan-ink-presets";
const COLOR = /^#[0-9a-f]{6}$/i;

export function cleanFavorite(raw: unknown): InkFavorite | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const type = value.type;
  if (type !== "pen" && type !== "highlighter" && type !== "text") return null;
  if (typeof value.color !== "string" || !COLOR.test(value.color)) return null;
  if (typeof value.width !== "number" || !Number.isFinite(value.width)) return null;
  const width = clampWidth(type, value.width);
  return { type, color: value.color.toLowerCase(), width, ...(type === "text" && isInkFont(value.font) ? { font: value.font } : {}) };
}
export function cleanFavorites(raw: unknown): InkFavorite[] {
  if (!Array.isArray(raw)) return [];
  const out: InkFavorite[] = [];
  for (const item of raw) {
    const fav = cleanFavorite(item);
    if (fav && !out.some((f) => sameFavorite(f, fav))) out.push(fav);
    if (out.length === MAX_FAVORITES) break;
  }
  return out;
}

function read(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
export function loadFavorites(): InkFavorite[] {
  const stored = read(KEY);
  if (stored !== null) {
    try {
      return cleanFavorites(JSON.parse(stored));
    } catch {}
  }
  // Never chosen here: the three pens of earlier versions, or the defaults.
  return read(LEGACY_KEY) !== null ? cleanFavorites(loadPresets()) : DEFAULT_FAVORITES.map((f) => ({ ...f }));
}
export function saveFavorites(list: InkFavorite[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {}
}

const near = (a: number, b: number) => Math.abs(a - b) < 0.05;
export const sameFavorite = (a: InkFavorite, b: InkFavorite) =>
  a.type === b.type && a.color.toLowerCase() === b.color.toLowerCase() && near(a.width, b.width) && (a.type !== "text" || (a.font || null) === (b.font || null));

// The favourite that is the tool and style in hand (-1: none).
export function favoriteIndex(list: InkFavorite[], fav: InkFavorite | null) {
  return fav ? list.findIndex((f) => sameFavorite(f, fav)) : -1;
}
// The list with `fav` at the end – unchanged when it is there already or the list is full.
export function addFavorite(list: InkFavorite[], fav: InkFavorite) {
  const clean = cleanFavorite(fav);
  if (!clean || list.length >= MAX_FAVORITES || list.some((f) => sameFavorite(f, clean))) return list;
  return [...list, clean];
}
export const removeFavorite = (list: InkFavorite[], index: number) => (index >= 0 && index < list.length ? list.filter((_, i) => i !== index) : list);
// The list with the favourite at `from` moved to `to` (clamped).
export function moveFavorite(list: InkFavorite[], from: number, to: number) {
  if (from < 0 || from >= list.length) return list;
  const target = Math.max(0, Math.min(list.length - 1, to));
  if (target === from) return list;
  const next = list.slice();
  const [item] = next.splice(from, 1);
  next.splice(target, 0, item);
  return next;
}

// How wide the mark of a favourite chip is drawn (CSS pixels).
export const favoriteMark = (fav: InkFavorite) => Math.max(2, Math.min(10, fav.type === "highlighter" ? fav.width / 2 : fav.width * 1.6));
