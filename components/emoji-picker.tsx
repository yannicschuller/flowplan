"use client";
import { useT } from "./i18n";
import { Select } from "./select";
import { useMemo, useState } from "react";
import { emojiGroups, searchEmojis } from "@/lib/emoji-data";
import { PageIcon } from "./ui";
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
  const [query, setQuery] = useState(""),
    [group, setGroup] = useState("all"),
    [tone, setTone] = useState("all"),
    [limit, setLimit] = useState(200),
    [busy, setBusy] = useState(false);
  const found = useMemo(
    () => searchEmojis(query, group, tone),
    [query, group, tone],
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
                {g.message}
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
        {found.length} {t("Emojis gefunden", "emojis found")}
      </p>
      <div className="emoji-grid" aria-label={t("Emoji-Auswahl", "Emoji picker")}>
        {found.slice(0, limit).map((e) => (
          <button
            key={e.hexcode}
            type="button"
            title={e.label}
            aria-label={`${e.label} ${e.emoji}`}
            aria-pressed={selected === e.emoji}
            disabled={busy}
            onClick={() => select(e.emoji)}
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
