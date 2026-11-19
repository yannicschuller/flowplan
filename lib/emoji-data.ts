// The emoji picker's data (components/emoji-picker.tsx), loaded when a
// picker opens – not with the page: 1.5 MB of JSON for both languages.
// German needs the German and the English names (a search for "rocket"
// finds 🚀 as well); every other interface language the English ones only
// (#310).
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
export type EmojiEntry = {
  emoji: string;
  label: string;
  labelEn: string;
  hexcode: string;
  group: number | undefined;
  order: number;
  tones: number[];
  // The shortcodes (":rocket:" without the colons): GitHub's, for German
  // the German CLDR ones as well (#388).
  shortcodes: string[];
  // A skin tone variant: the hexcode of the emoji without a tone.
  parent?: string;
  search: string;
};
type Shortcodes = Record<string, string | string[]>;
const normalize = (value: string) =>
  value
    .toLocaleLowerCase("de")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
export const emojiGroups = messages.groups;

// The entries of `primary` (the names shown), searchable by its names and
// tags and by those of `english` as well.
export function buildEmojiEntries(primary: Entry[], english: Entry[], shortcodeSets: Shortcodes[] = []): EmojiEntry[] {
  const codesOf = (hexcode: string) => shortcodeSets.flatMap((set) => set[hexcode] ?? []);
  const englishByCode = new Map(english.flatMap((e) => [e, ...(e.skins || [])]).map((e) => [e.hexcode, e]));
  return primary
    .flatMap((parent) =>
      [parent, ...(parent.skins || [])].map((entry) => {
        const en = englishByCode.get(entry.hexcode);
        const shortcodes = codesOf(entry.hexcode);
        return {
          emoji: entry.emoji,
          label: entry.label,
          // The English name for other languages (#310).
          labelEn: en?.label || entry.label,
          hexcode: entry.hexcode,
          group: entry.group ?? parent.group,
          order: entry.order ?? 99999,
          tones: Array.isArray(entry.tone) ? entry.tone : entry.tone ? [entry.tone] : [],
          shortcodes,
          ...(entry === parent ? {} : { parent: parent.hexcode }),
          search: normalize([entry.label, parent.label, ...(parent.tags || []), en?.label || "", ...(en?.tags || []), ...shortcodes, entry.emoji].join(" ")),
        };
      }),
    )
    .sort((a, b) => a.order - b.order);
}

const loaded = new Map<string, Promise<EmojiEntry[]>>();
// The entries for an interface language, loaded once.
export function loadEmojiEntries(locale: string): Promise<EmojiEntry[]> {
  const key = locale === "de" ? "de" : "en";
  let entries = loaded.get(key);
  if (!entries) {
    entries = (async () => {
      const [english, github] = await Promise.all([
        import("emojibase-data/en/data.json").then((m) => (m.default as unknown) as Entry[]),
        import("emojibase-data/en/shortcodes/github.json").then((m) => (m.default as unknown) as Shortcodes),
      ]);
      if (key !== "de") return buildEmojiEntries(english, english, [github]);
      const [german, cldr] = await Promise.all([
        import("emojibase-data/de/data.json").then((m) => (m.default as unknown) as Entry[]),
        import("emojibase-data/de/shortcodes/cldr.json").then((m) => (m.default as unknown) as Shortcodes),
      ]);
      return buildEmojiEntries(german, english, [github, cldr]);
    })();
    entries.catch(() => loaded.delete(key));
    loaded.set(key, entries);
  }
  return entries;
}

export function searchEmojis(entries: EmojiEntry[], query: string, group = "all", tone = "all") {
  const words = normalize(query.trim()).split(/\s+/).filter(Boolean);
  return entries.filter(
    (e) =>
      (group === "all" || String(e.group) === group) &&
      (tone === "all" || (tone === "neutral" ? !e.tones.length : e.tones.includes(Number(tone)))) &&
      words.every((word) => e.search.includes(word)),
  );
}
