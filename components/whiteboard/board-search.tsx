"use client";
// Search on the board (Ctrl/⌘+F): a bar at the top with the number of
// matches, next/previous (Enter, Shift+Enter, the arrows) and the filter by
// tag ("nur Zettel mit Schlagwort X"), which dims everything else. The board
// flies to the current match and outlines it (components/whiteboard/
// board-extras.tsx draws the outline).
import { useEffect, useRef } from "react";
import { CaretDown, CaretUp, MagnifyingGlass, Tag, X } from "@phosphor-icons/react";
import { useT } from "../i18n";
import { Select } from "../select";
import type { BoardMatch } from "@/lib/whiteboard-search";

export function BoardSearch({
  query,
  matches,
  index,
  tags,
  tag,
  onQuery,
  onStep,
  onTag,
  onClose,
}: {
  query: string;
  matches: BoardMatch[];
  index: number;
  tags: { tag: string; count: number }[];
  tag: string;
  onQuery: (query: string) => void;
  onStep: (delta: number) => void;
  onTag: (tag: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, []);
  const current = matches[index];
  return (
    <div className="wb-search" role="search" aria-label={t("Auf dem Board suchen", "Search the board")} onPointerDown={(e) => e.stopPropagation()}>
      <div className="wb-search-row">
        <MagnifyingGlass size={16} aria-hidden="true" />
        <input
          ref={field}
          type="search"
          value={query}
          placeholder={t("Auf dem Board suchen …", "Search the board …")}
          aria-label={t("Suchbegriff", "Search term")}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") {
              e.preventDefault();
              onStep(e.shiftKey ? -1 : 1);
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
              e.preventDefault();
              e.currentTarget.select();
            }
          }}
        />
        <span className="wb-search-count" aria-live="polite">
          {query.trim() ? (matches.length ? `${index + 1}/${matches.length}` : t("Keine Treffer", "No matches")) : ""}
        </span>
        <button type="button" aria-label={t("Vorheriger Treffer", "Previous match")} disabled={!matches.length} onClick={() => onStep(-1)}>
          <CaretUp size={15} />
        </button>
        <button type="button" aria-label={t("Nächster Treffer", "Next match")} disabled={!matches.length} onClick={() => onStep(1)}>
          <CaretDown size={15} />
        </button>
        <button type="button" aria-label={t("Suche schließen", "Close search")} onClick={onClose}>
          <X size={15} />
        </button>
      </div>
      {current?.snippet && (
        <p className="wb-search-snippet">
          {current.length ? (
            <>
              {current.snippet.slice(0, current.start)}
              <mark>{current.snippet.slice(current.start, current.start + current.length)}</mark>
              {current.snippet.slice(current.start + current.length)}
            </>
          ) : (
            current.snippet
          )}
        </p>
      )}
      {tags.length > 0 && (
        <label className="wb-search-tag">
          <Tag size={15} aria-hidden="true" />
          <span>{t("Nur Zettel mit Schlagwort", "Only notes tagged")}</span>
          <Select value={tag} onChange={(e) => onTag(e.target.value)} aria-label={t("Nur Zettel mit Schlagwort", "Only notes tagged")}>
            <option value="">{t("– alle –", "– all –")}</option>
            {tags.map((entry) => (
              <option key={entry.tag} value={entry.tag}>
                {entry.tag} ({entry.count})
              </option>
            ))}
          </Select>
        </label>
      )}
    </div>
  );
}
