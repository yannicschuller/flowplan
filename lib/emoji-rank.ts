// The emoji suggestions after ":" (#388, components/emoji-suggest-menu.tsx):
// which emojis match what was typed, in which order, in which skin tone, and
// the recently used ones of this browser. Loaded with the suggestions, not
// with the editor.
import type { EmojiEntry } from "./emoji-data";
import { EMOJI_TONE_KEY } from "./emoji-trigger";

export const MAX_SUGGESTIONS = 10;

const normalize = (value: string) =>
  value
    .toLocaleLowerCase("de")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[_\s]+/g, " ")
    .trim();

// An entry's names: its label in both languages and its shortcodes.
const namesOf = (entry: EmojiEntry) => [entry.label, entry.labelEn, ...entry.shortcodes].map(normalize);

// 0 the exact name or shortcode, 1 a name or shortcode starting with the
// query, 2 a word of a name starting with it, 3 a tag (or any other part of
// the search text) containing it; null: no match.
export function matchTier(entry: EmojiEntry, query: string): number | null {
  const q = normalize(query);
  if (!q) return null;
  const names = namesOf(entry);
  if (names.includes(q)) return 0;
  if (names.some((name) => name.startsWith(q))) return 1;
  if (names.some((name) => name.split(/[\s:,-]+/).some((word) => word.startsWith(q)))) return 2;
  return entry.search.replace(/_/g, " ").includes(q) ? 3 : null;
}

// The variant of `entry` in the skin tone `tone` (1–5), if it has one.
function inTone(entry: EmojiEntry, tone: number | null, variants: Map<string, EmojiEntry[]>) {
  if (!tone) return entry;
  return variants.get(entry.hexcode)?.find((v) => v.tones.length === 1 && v.tones[0] === tone) || entry;
}

const variantCache = new WeakMap<EmojiEntry[], { base: EmojiEntry[]; variants: Map<string, EmojiEntry[]> }>();
// The emojis without a tone (the suggestions show one per emoji) and their
// tone variants; regional indicators and the tone components are left out.
function split(entries: EmojiEntry[]) {
  let cached = variantCache.get(entries);
  if (!cached) {
    const variants = new Map<string, EmojiEntry[]>();
    const base: EmojiEntry[] = [];
    for (const entry of entries) {
      if (entry.parent) variants.set(entry.parent, [...(variants.get(entry.parent) || []), entry]);
      else if (entry.group !== undefined && entry.group !== 2) base.push(entry);
    }
    cached = { base, variants };
    variantCache.set(entries, cached);
  }
  return cached;
}

// The suggestions for `query`: an exact name or shortcode first, then the
// recently used ones (`recents`, emojis, newest first), then names starting
// with the query, words starting with it and tags; within one rank in the
// emoji order. Shown in the skin tone last chosen in the picker.
export function rankEmojis(
  entries: EmojiEntry[],
  query: string,
  { recents = [], tone = null, limit = MAX_SUGGESTIONS }: { recents?: string[]; tone?: number | null; limit?: number } = {},
): EmojiEntry[] {
  const { base, variants } = split(entries);
  // A recently used emoji in a tone counts for the emoji without it.
  const recentRank = new Map<string, number>();
  recents.forEach((emoji, index) => {
    const entry = entries.find((e) => e.emoji === emoji);
    const key = entry?.parent || entry?.hexcode;
    if (key && !recentRank.has(key)) recentRank.set(key, index);
  });
  const hits: { entry: EmojiEntry; tier: number; recent: number }[] = [];
  for (const entry of base) {
    const tier = matchTier(entry, query);
    if (tier !== null) hits.push({ entry, tier, recent: recentRank.get(entry.hexcode) ?? Infinity });
  }
  hits.sort(
    (a, b) =>
      Number(a.tier > 0) - Number(b.tier > 0) ||
      a.recent - b.recent ||
      a.tier - b.tier ||
      a.entry.order - b.entry.order,
  );
  return hits.slice(0, limit).map((hit) => inTone(hit.entry, tone, variants));
}

// ":smile:" – the emoji of an exact name or shortcode, or null.
export function exactEmoji(entries: EmojiEntry[], query: string, tone: number | null = null): EmojiEntry | null {
  const { base, variants } = split(entries);
  const q = normalize(query);
  // A shortcode wins over a name: ":smile:" is 😄 (GitHub), not 🙂.
  const hit =
    base.find((entry) => entry.shortcodes.some((code) => normalize(code) === q)) ||
    base.find((entry) => normalize(entry.label) === q || normalize(entry.labelEn) === q);
  return hit ? inTone(hit, tone, variants) : null;
}

// Recently inserted emojis of this browser, newest first.
const RECENTS_KEY = "flowplan.emoji-recents";
export const MAX_EMOJI_RECENTS = 12;
export function readEmojiRecents(): string[] {
  try {
    const stored = JSON.parse(localStorage.getItem(RECENTS_KEY) || "[]");
    return Array.isArray(stored) ? stored.filter((e): e is string => typeof e === "string").slice(0, MAX_EMOJI_RECENTS) : [];
  } catch {
    return [];
  }
}
export function rememberEmoji(entry: EmojiEntry, current = readEmojiRecents()): string[] {
  const next = [entry.emoji, ...current.filter((other) => other !== entry.emoji)].slice(0, MAX_EMOJI_RECENTS);
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {}
  return next;
}

// The skin tone last chosen in the emoji picker (components/emoji-picker.tsx):
// 1–5, or null for the default (yellow) one.
export function readEmojiTone(): number | null {
  try {
    const tone = Number(localStorage.getItem(EMOJI_TONE_KEY));
    return Number.isInteger(tone) && tone >= 1 && tone <= 5 ? tone : null;
  } catch {
    return null;
  }
}
