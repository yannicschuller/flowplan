"use client";
import { useLocale, useT } from "./i18n";
import { Select } from "./select";
import { useEffect, useMemo, useState } from "react";
import { emojiGroups, loadEmojiEntries, searchEmojis, type EmojiEntry } from "@/lib/emoji-data";
import { PageIcon } from "./ui";
import { rememberEmojiTone } from "@/lib/emoji-trigger";
export default function EmojiPicker({
  selected,
  onSelect,
  allowSymbols = true,
}: {
  selected?: string;
  onSelect: (icon: string) => Promise<void>;
  allowSymbols?: boolean;
}) {
  const t = useT();
  const locale = useLocale();
  // The emoji data's category names are German (#310).
  const groupNames: Record<string, string> = {
    "smileys-emotion": t("Smileys & Emotionen", "Smileys & emotion"),
    "people-body": t("Menschen & Körper", "People & body"),
    component: t("Komponenten", "Components"),
    "animals-nature": t("Tiere & Natur", "Animals & nature"),
    "food-drink": t("Essen & Trinken", "Food & drink"),
    "travel-places": t("Reisen & Orte", "Travel & places"),
    activities: t("Aktivitäten", "Activities"),
    objects: t("Gegenstände", "Objects"),
    symbols: t("Symbole", "Symbols"),
    flags: t("Flaggen", "Flags"),
  };
  const groupName = (key: string, fallback: string) => groupNames[key] ?? fallback;
  const [query, setQuery] = useState(""),
    [group, setGroup] = useState("all"),
    [tone, setTone] = useState("all"),
    [limit, setLimit] = useState(200),
    [busy, setBusy] = useState(false),
    // Loaded when the picker opens, in the interface language.
    [entries, setEntries] = useState<EmojiEntry[] | null>(null);
  useEffect(() => {
    let alive = true;
    void loadEmojiEntries(locale)
      .then((list) => alive && setEntries(list))
      .catch(() => alive && setEntries([]));
    return () => {
      alive = false;
    };
  }, [locale]);
  const found = useMemo(
    () => (entries ? searchEmojis(entries, query, group, tone) : []),
    [entries, query, group, tone],
  );
  async function select(icon: string) {
    setBusy(true);
    try {
      await onSelect(icon);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="emoji-picker">
      <label>
        {t("Emoji suchen", "Search emoji")}
        <input
          autoFocus
          type="search"
          onKeyDown={(event) => {
            if (event.key === "Enter") event.preventDefault();
          }}
          placeholder={t("Zum Beispiel Rakete, Herz, Katze oder rocket", "For example rocket, heart, cat")}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setLimit(200);
          }}
        />
      </label>
      <div className="emoji-filters">
        <label>
          {t("Kategorie", "Category")}
          <Select
            aria-label={t("Kategorie", "Category")}
            value={group}
            onChange={(e) => {
              setGroup(e.target.value);
              setLimit(200);
            }}
          >
            <option value="all">{t("Alle Kategorien", "All categories")}</option>
            {emojiGroups.map((g) => (
              <option key={g.key} value={g.order}>
                {groupName(g.key, g.message)}
              </option>
            ))}
          </Select>
        </label>
        <label>
          {t("Hautton", "Skin tone")}
          <Select
            aria-label={t("Hautton", "Skin tone")}
            value={tone}
            onChange={(e) => {
              setTone(e.target.value);
              setLimit(200);
              // The emoji suggestions after ":" use this tone (#388).
              if (e.target.value !== "all") rememberEmojiTone(Number(e.target.value) || null);
            }}
          >
            <option value="all">{t("Alle Hauttöne", "All skin tones")}</option>
            <option value="neutral">{t("Ohne Hautton", "No skin tone")}</option>
            {[t("Hell", "Light"), t("Mittelhell", "Medium light"), t("Mittel", "Medium"), t("Mitteldunkel", "Medium dark"), t("Dunkel", "Dark")].map(
              (label, i) => (
                <option key={label} value={i + 1}>
                  {label}
                </option>
              ),
            )}
          </Select>
        </label>
      </div>
      <p className="muted" role="status">
        {entries ? `${found.length} ${t("Emojis gefunden", "emojis found")}` : t("Emojis werden geladen …", "Loading emojis …")}
      </p>
      <div className="emoji-grid" aria-label={t("Emoji-Auswahl", "Emoji picker")}>
        {found.slice(0, limit).map((e) => (
          <button
            key={e.hexcode}
            type="button"
            title={locale === "de" ? e.label : e.labelEn}
            aria-label={`${locale === "de" ? e.label : e.labelEn} ${e.emoji}`}
            aria-pressed={selected === e.emoji}
            disabled={busy}
            onClick={() => {
              if (e.tones.length === 1) rememberEmojiTone(e.tones[0]);
              void select(e.emoji);
            }}
          >
            {e.emoji}
          </button>
        ))}
      </div>
      {found.length > limit && (
        <button
          type="button"
          className="button"
          onClick={() => setLimit(limit + 200)}
        >
          {t("Weitere Emojis anzeigen", "Show more emojis")}
        </button>
      )}
      {allowSymbols && (
        <details>
          <summary>{t("Symbole statt Emojis", "Icons instead of emojis")}</summary>
          <div className="icon-grid">
            {[
              "file",
              "book",
              "rocket",
              "hand",
              "folder",
              "flag",
              "idea",
              "notes",
              "stack",
              "table",
            ].map((icon) => (
              <button
                key={icon}
                type="button"
                aria-label={t(`Symbol ${icon}`, `Icon ${icon}`)}
                disabled={busy}
                onClick={() => select(icon)}
              >
                <PageIcon name={icon} size={24} />
              </button>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
