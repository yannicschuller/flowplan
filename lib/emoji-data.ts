import german from "emojibase-data/de/data.json";
import english from "emojibase-data/en/data.json";
import messages from "emojibase-data/de/messages.json";
type Entry = {
  label: string;
  emoji: string;
  hexcode: string;
  tags?: string[];
  group?: number;
  order?: number;
  tone?: number | number[];
  skins?: Entry[];
};
const normalize = (value: string) =>
  value
    .toLocaleLowerCase("de")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
const englishByCode = new Map(
  (english as Entry[])
    .flatMap((e) => [e, ...(e.skins || [])])
    .map((e) => [e.hexcode, e]),
);
export const emojiGroups = messages.groups;
export const emojiEntries = (german as Entry[])
  .flatMap((parent) =>
    [parent, ...(parent.skins || [])].map((entry) => {
      const en = englishByCode.get(entry.hexcode);
      return {
        emoji: entry.emoji,
        label: entry.label,
        hexcode: entry.hexcode,
        group: entry.group ?? parent.group,
        order: entry.order ?? 99999,
        tones: Array.isArray(entry.tone)
          ? entry.tone
          : entry.tone
            ? [entry.tone]
            : [],
        search: normalize(
          [
            entry.label,
            parent.label,
            ...(parent.tags || []),
            en?.label || "",
            ...(en?.tags || []),
            entry.emoji,
          ].join(" "),
        ),
      };
    }),
  )
  .sort((a, b) => a.order - b.order);
export function searchEmojis(query: string, group = "all", tone = "all") {
  const words = normalize(query.trim()).split(/\s+/).filter(Boolean);
  return emojiEntries.filter(
    (e) =>
      (group === "all" || String(e.group) === group) &&
      (tone === "all" ||
        (tone === "neutral"
          ? !e.tones.length
          : e.tones.includes(Number(tone)))) &&
      words.every((word) => e.search.includes(word)),
  );
}
