// Tags on stickies: short words shown as coloured chips. The colour comes
// from the word, so the same tag looks the same on every note and for
// everyone. The board can highlight only the notes with one tag.
import type { WhiteboardItem } from "./whiteboard-model";

export const MAX_TAGS = 12;
export const MAX_TAG_LENGTH = 40;
// Pairs of chip background and text colour, readable on every note colour.
export const tagPalette: [string, string][] = [
  ["#3b3fd8", "#ffffff"],
  ["#2f9e44", "#ffffff"],
  ["#e8590c", "#ffffff"],
  ["#c2255c", "#ffffff"],
  ["#1971c2", "#ffffff"],
  ["#7048e8", "#ffffff"],
  ["#495057", "#ffffff"],
  ["#0c8599", "#ffffff"],
];
export function normalizeTag(raw: string) {
  return String(raw ?? "")
    .replace(/[\u0000-\u001f\u007f#,]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TAG_LENGTH);
}
const key = (tag: string) => normalizeTag(tag).toLocaleLowerCase("de");
// The tags of an item as stored: strings only, normalized, no doubles.
export function itemTags(item: Pick<WhiteboardItem, "tags">): string[] {
  if (!Array.isArray(item.tags)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of item.tags) {
    if (typeof raw !== "string") continue;
    const tag = normalizeTag(raw);
    if (!tag || seen.has(key(tag))) continue;
    seen.add(key(tag));
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}
export function addTag(tags: string[], raw: string) {
  const tag = normalizeTag(raw);
  if (!tag || tags.some((t) => key(t) === key(tag)) || tags.length >= MAX_TAGS) return tags;
  return [...tags, tag];
}
export function removeTag(tags: string[], tag: string) {
  return tags.filter((t) => key(t) !== key(tag));
}
export function hasTag(item: Pick<WhiteboardItem, "tags">, tag: string) {
  return itemTags(item).some((t) => key(t) === key(tag));
}
export function tagColor(tag: string): [string, string] {
  let hash = 7;
  for (const c of key(tag)) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  return tagPalette[hash % tagPalette.length];
}
// Every tag on the board with how often it is used, most used first.
export function boardTags(items: Pick<WhiteboardItem, "tags">[]) {
  const counts = new Map<string, { tag: string; count: number }>();
  for (const item of items)
    for (const tag of itemTags(item)) {
      const entry = counts.get(key(tag));
      if (entry) entry.count++;
      else counts.set(key(tag), { tag, count: 1 });
    }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, "de"));
}
