"use client";
import { LOCALE_TAG } from "@/lib/locale-tag";
import { useT } from "./i18n";
import { PdfThumbnail } from "./pdf-viewer";
import { useEffect, useState } from "react";
import {
  File as FileIcon,
  FileAudio,
  FilePdf,
  FileVideo,
  Images,
} from "@phosphor-icons/react";
import type { MediaItem, MediaKind } from "@/lib/media-library";

const kinds: [MediaKind, string, string][] = [
  ["all", "Alle", "All"],
  ["image", "Bilder", "Images"],
  ["video", "Videos", "Videos"],
  ["audio", "Audio", "Audio"],
  ["pdf", "PDF", "PDF"],
  ["other", "Sonstige", "Other"],
];
const size = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toLocaleString(LOCALE_TAG, { maximumFractionDigits: 1 })} MB`;

// All files of the pages you can read in this workspace.
export function MediaLibrary({
  workspaceId,
  onOpen,
}: {
  workspaceId: string;
  onOpen: (pageId: string) => void;
}) {
  const t = useT();
  const [kind, setKind] = useState<MediaKind>("all"),
    [query, setQuery] = useState(""),
    [items, setItems] = useState<MediaItem[]>([]),
    [total, setTotal] = useState(0),
    [bytes, setBytes] = useState(0),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  async function load(offset: number, signal?: AbortSignal) {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(
        `/api/media?${new URLSearchParams({
          workspace: workspaceId,
          kind,
          q: query,
          offset: String(offset),
        })}`,
        { signal, cache: "no-store" },
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setItems((current) =>
        offset ? [...current, ...data.items] : data.items,
      );
      setTotal(data.total);
      setBytes(data.bytes);
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => void load(0, controller.signal), 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, kind, query]);
  return (
    <div className="utility-content media-library">
      <div className="utility-title">
        <Images size={30} />
        <h1>{t("Medien", "Media")}</h1>
        <p>
          {t("Bilder, Videos und Dateien aus allen Seiten, die du lesen kannst.", "Images, videos and files from all pages you can read.")}
          {total > 0 &&
            ` ${total} ${total === 1 ? "Datei" : "Dateien"} · ${size(bytes)}`}
        </p>
      </div>
      <div className="media-filters">
        <div role="radiogroup" aria-label={t("Medientyp", "Media type")}>
          {kinds.map(([id, de, en]) => (
            <button
              key={id}
              role="radio"
              aria-checked={kind === id}
              className={`chip${kind === id ? " active" : ""}`}
              onClick={() => setKind(id)}
            >
              {t(de, en)}
            </button>
          ))}
        </div>
        <input
          type="search"
          aria-label={t("Dateien suchen", "Search files")}
          placeholder={t("Dateiname suchen …", "Search file name …")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {error && (
        <p role="alert" className="field-error">
          {error}
        </p>
      )}
      <ul className="media-grid" aria-label={t("Dateien", "Files")}>
        {items.map((item) => (
          <li key={item.id} className="media-item">
            <a
              className="media-thumb"
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={t(`${item.name} öffnen`, `Open ${item.name}`)}
              data-pdf={item.kind === "pdf" ? item.name : undefined}
            >
              {item.kind === "image" ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={item.url} alt="" loading="lazy" />
              ) : item.kind === "video" ? (
                <FileVideo size={36} />
              ) : item.kind === "audio" ? (
                <FileAudio size={36} />
              ) : item.kind === "pdf" ? (
                <PdfThumbnail src={item.url} width={180} />
              ) : (
                <FileIcon size={36} />
              )}
            </a>
            <span className="media-name" title={item.name}>
              {item.name}
            </span>
            <small className="muted">
              {size(item.size)} ·{" "}
              {new Date(
                item.created_at.replace(" ", "T") + "Z",
              ).toLocaleDateString(LOCALE_TAG)}
            </small>
            <button
              className="text-button media-page"
              onClick={() => onOpen(item.pageId)}
              title={t(`Seite „${item.pageTitle}“ öffnen`, `Open page “${item.pageTitle}”`)}
            >
              {item.pageTitle}
            </button>
          </li>
        ))}
      </ul>
      {!loading && !items.length && !error && (
        <div className="empty-state">
          <Images size={38} />
          <h3>{t("Keine Dateien", "No files")}</h3>
          <p>
            {query || kind !== "all"
              ? t("Keine Datei passt zu diesem Filter.", "No file matches this filter.")
              : t("Lade Bilder oder Dateien in eine Seite hoch.", "Upload images or files to a page.")}
          </p>
        </div>
      )}
      {items.length < total && (
        <button
          className="button"
          disabled={loading}
          onClick={() => void load(items.length)}
        >
          {t("Weitere laden", "Load more")}
        </button>
      )}
    </div>
  );
}
