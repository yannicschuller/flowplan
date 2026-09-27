"use client";
// Pictures and symbols for the board: openly licensed images (Openverse,
// with credit) and the icon library in any of its colours.
import { useState } from "react";
import { MagnifyingGlass } from "@phosphor-icons/react";
import { Modal, api } from "../ui";
import { LibraryIcon } from "../library-icons";
import { iconColors, iconLibrary, libraryIconValue } from "@/lib/icon-library";

type Result = { id: string; title: string; thumbnail: string; url: string; width: number; height: number; credit: string };

export function MediaSearch({
  open,
  canSearchImages,
  onClose,
  onImage,
  onIcon,
}: {
  open: boolean;
  canSearchImages: boolean;
  onClose: () => void;
  onImage: (result: Result) => Promise<void>;
  onIcon: (value: string) => void;
}) {
  const [tab, setTab] = useState<"images" | "icons">(canSearchImages ? "images" : "icons");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Result[] | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [color, setColor] = useState<string>(iconColors[1][1]);
  const [iconQuery, setIconQuery] = useState("");
  const search = async () => {
    if (query.trim().length < 2) return;
    setBusy("search");
    setError("");
    try {
      setResults((await api<{ results: Result[] }>(`/api/images/search?q=${encodeURIComponent(query.trim())}`)).results);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const needle = iconQuery.trim().toLocaleLowerCase("de");
  const icons = Object.entries(iconLibrary).filter(
    ([name, words]) => !needle || name.toLowerCase().includes(needle) || words.includes(needle),
  );
  return (
    <Modal open={open} onClose={onClose} title="Bilder und Symbole" wide className="wb-media-search">
      <div className="journal-layout" role="tablist" aria-label="Art">
        {canSearchImages && (
          <button type="button" role="tab" aria-selected={tab === "images"} className={tab === "images" ? "active" : ""} onClick={() => setTab("images")}>
            Bilder
          </button>
        )}
        <button type="button" role="tab" aria-selected={tab === "icons"} className={tab === "icons" ? "active" : ""} onClick={() => setTab("icons")}>
          Symbole
        </button>
      </div>
      {tab === "images" ? (
        <>
          <form
            className="wb-media-query"
            onSubmit={(e) => {
              e.preventDefault();
              void search();
            }}
          >
            <MagnifyingGlass size={16} />
            <input aria-label="Bilder suchen" placeholder="z. B. Berge, Team, Kaffee …" value={query} onChange={(e) => setQuery(e.target.value)} autoFocus />
            <button className="button compact" disabled={busy === "search" || query.trim().length < 2}>
              Suchen
            </button>
          </form>
          <p className="muted wb-media-note">Frei lizenzierte Bilder von Openverse. Der Bildnachweis wird mitgespeichert.</p>
          {error && <p className="error" role="alert">{error}</p>}
          {results && !results.length && <p className="muted">Keine Bilder gefunden.</p>}
          <div className="wb-media-grid">
            {results?.map((r) => (
              <button
                key={r.id}
                type="button"
                title={r.credit}
                aria-label={r.title || "Bild"}
                disabled={!!busy}
                className={busy === r.id ? "busy" : ""}
                onClick={async () => {
                  setBusy(r.id);
                  setError("");
                  try {
                    await onImage(r);
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setBusy("");
                  }
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={r.thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer" />
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="wb-media-query">
            <MagnifyingGlass size={16} />
            <input aria-label="Symbole suchen" placeholder="Symbol suchen …" value={iconQuery} onChange={(e) => setIconQuery(e.target.value)} />
          </div>
          <div className="wb-icon-colors" role="radiogroup" aria-label="Farbe">
            {iconColors.map(([name, value]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={color === value}
                aria-label={name}
                title={name}
                className={color === value ? "active" : ""}
                style={{ background: value }}
                onClick={() => setColor(value)}
              />
            ))}
          </div>
          <div className="wb-icon-grid">
            {icons.map(([name]) => (
              <button key={name} type="button" aria-label={`Symbol ${name}`} title={name} onClick={() => onIcon(libraryIconValue(name, color))}>
                <LibraryIcon value={libraryIconValue(name, color)} size={26} />
              </button>
            ))}
          </div>
        </>
      )}
    </Modal>
  );
}
