"use client";
// Pictures and symbols for the board: openly licensed images (Openverse,
// with credit), GIFs (GIPHY or Tenor, when the server has a key –
// lib/gif-search.ts) and the icon library in any of its colours.
import { useT } from "../i18n";
import { useEffect, useState } from "react";
import { MagnifyingGlass } from "@phosphor-icons/react";
import { Modal, api } from "../ui";
import { LibraryIcon } from "../library-icons";
import { iconColors, iconLibrary, libraryIconValue } from "@/lib/icon-library";

type Result = { id: string; title: string; thumbnail: string; url: string; width: number; height: number; credit: string; gif?: boolean };
// Whether the server offers GIFs (asked once per page load).
let gifsOffered: Promise<boolean> | null = null;
const gifsEnabled = () =>
  (gifsOffered ??= api<{ enabled: boolean }>("/api/images/gifs")
    .then((r) => !!r.enabled)
    .catch(() => false));

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
  const t = useT();
  const [tab, setTab] = useState<"images" | "gifs" | "icons">(canSearchImages ? "images" : "icons");
  const [gifs, setGifs] = useState(false);
  useEffect(() => {
    if (!canSearchImages) return;
    let alive = true;
    void gifsEnabled().then((on) => alive && setGifs(on));
    return () => {
      alive = false;
    };
  }, [canSearchImages]);
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
      setResults(
        tab === "gifs"
          ? (await api<{ results: Result[] }>(`/api/images/gifs?q=${encodeURIComponent(query.trim())}`)).results.map((r) => ({ ...r, gif: true }))
          : (await api<{ results: Result[] }>(`/api/images/search?q=${encodeURIComponent(query.trim())}`)).results,
      );
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
    <Modal open={open} onClose={onClose} title={t("Bilder und Symbole", "Images and icons")} wide className="wb-media-search">
      <div className="journal-layout" role="tablist" aria-label={t("Art", "Kind")}>
        {canSearchImages && (
          <button type="button" role="tab" aria-selected={tab === "images"} className={tab === "images" ? "active" : ""} onClick={() => {
            setTab("images");
            setResults(null);
          }}>
            {t("Bilder", "Images")}
          </button>
        )}
        {canSearchImages && gifs && (
          <button type="button" role="tab" aria-selected={tab === "gifs"} className={tab === "gifs" ? "active" : ""} onClick={() => {
            setTab("gifs");
            setResults(null);
          }}>
            {t("GIFs", "GIFs")}
          </button>
        )}
        <button type="button" role="tab" aria-selected={tab === "icons"} className={tab === "icons" ? "active" : ""} onClick={() => setTab("icons")}>
          {t("Symbole", "Icons")}
        </button>
      </div>
      {tab === "images" || tab === "gifs" ? (
        <>
          <form
            className="wb-media-query"
            onSubmit={(e) => {
              e.preventDefault();
              void search();
            }}
          >
            <MagnifyingGlass size={16} />
            <input
              aria-label={tab === "gifs" ? t("GIFs suchen", "Search GIFs") : t("Bilder suchen", "Search images")}
              placeholder={tab === "gifs" ? t("z. B. Applaus, Danke, Hurra …", "e.g. applause, thanks, hooray …") : t("z. B. Berge, Team, Kaffee …", "e.g. mountains, team, coffee …")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoFocus
            />
            <button className="button compact" disabled={busy === "search" || query.trim().length < 2}>
              {t("Suchen", "Search")}
            </button>
          </form>
          <p className="muted wb-media-note">
            {tab === "gifs"
              ? t("GIFs werden beim Einfügen auf dem Server gespeichert; danach lädt das Board nichts mehr vom Anbieter.", "GIFs are stored on the server when inserted; afterwards the board loads nothing from the provider.")
              : t("Frei lizenzierte Bilder von Openverse. Der Bildnachweis wird mitgespeichert.", "Openly licensed images from Openverse. The image credit is saved too.")}
          </p>
          {error && <p className="error" role="alert">{error}</p>}
          {results && !results.length && <p className="muted">{t("Keine Bilder gefunden.", "No images found.")}</p>}
          <div className="wb-media-grid">
            {results?.map((r) => (
              <button
                key={r.id}
                type="button"
                title={r.credit}
                aria-label={r.title || t("Bild", "Image")}
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
            <input aria-label={t("Symbole suchen", "Search icons")} placeholder={t("Symbol suchen …", "Search icon …")} value={iconQuery} onChange={(e) => setIconQuery(e.target.value)} />
          </div>
          <div className="wb-icon-colors" role="radiogroup" aria-label={t("Farbe", "Colour")}>
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
              <button key={name} type="button" aria-label={t(`Symbol ${name}`, `Icon ${name}`)} title={name} onClick={() => onIcon(libraryIconValue(name, color))}>
                <LibraryIcon value={libraryIconValue(name, color)} size={26} />
              </button>
            ))}
          </div>
        </>
      )}
    </Modal>
  );
}
