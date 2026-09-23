"use client";
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
        Emoji suchen
        <input
          autoFocus
          type="search"
          onKeyDown={(event) => {
            if (event.key === "Enter") event.preventDefault();
          }}
          placeholder="Zum Beispiel Rakete, Herz, Katze oder rocket"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setLimit(200);
          }}
        />
      </label>
      <div className="emoji-filters">
        <label>
          Kategorie
          <select
            aria-label="Kategorie"
            value={group}
            onChange={(e) => {
              setGroup(e.target.value);
              setLimit(200);
            }}
          >
            <option value="all">Alle Kategorien</option>
            {emojiGroups.map((g) => (
              <option key={g.key} value={g.order}>
                {g.message}
              </option>
            ))}
          </select>
        </label>
        <label>
          Hautton
          <select
            aria-label="Hautton"
            value={tone}
            onChange={(e) => {
              setTone(e.target.value);
              setLimit(200);
            }}
          >
            <option value="all">Alle Hauttöne</option>
            <option value="neutral">Ohne Hautton</option>
            {["Hell", "Mittelhell", "Mittel", "Mitteldunkel", "Dunkel"].map(
              (label, i) => (
                <option key={label} value={i + 1}>
                  {label}
                </option>
              ),
            )}
          </select>
        </label>
      </div>
      <p className="muted" role="status">
        {found.length} Emojis gefunden
      </p>
      <div className="emoji-grid" aria-label="Emoji-Auswahl">
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
          Weitere Emojis anzeigen
        </button>
      )}
      {allowSymbols && (
        <details>
          <summary>Symbole statt Emojis</summary>
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
                aria-label={`Symbol ${icon}`}
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
