"use client";
import { useEffect, useState } from "react";
import {
  File as FileIcon,
  FileAudio,
  FilePdf,
  FileVideo,
  Images,
} from "@phosphor-icons/react";
import type { MediaItem, MediaKind } from "@/lib/media-library";

const kinds: [MediaKind, string][] = [
  ["all", "Alle"],
  ["image", "Bilder"],
  ["video", "Videos"],
  ["audio", "Audio"],
  ["pdf", "PDF"],
  ["other", "Sonstige"],
];
const size = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toLocaleString("de-DE", { maximumFractionDigits: 1 })} MB`;

// All files of the pages you can read in this workspace.
export function MediaLibrary({
  workspaceId,
  onOpen,
}: {
  workspaceId: string;
  onOpen: (pageId: string) => void;
}) {
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
        <h1>Medien</h1>
        <p>
          Bilder, Videos und Dateien aus allen Seiten, die du lesen kannst.
          {total > 0 &&
            ` ${total} ${total === 1 ? "Datei" : "Dateien"} · ${size(bytes)}`}
        </p>
      </div>
      <div className="media-filters">
        <div role="radiogroup" aria-label="Medientyp">
          {kinds.map(([id, label]) => (
            <button
              key={id}
              role="radio"
              aria-checked={kind === id}
              className={`chip${kind === id ? " active" : ""}`}
              onClick={() => setKind(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <input
          type="search"
          aria-label="Dateien suchen"
          placeholder="Dateiname suchen …"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {error && (
        <p role="alert" className="field-error">
          {error}
        </p>
      )}
      <ul className="media-grid" aria-label="Dateien">
        {items.map((item) => (
          <li key={item.id} className="media-item">
            <a
              className="media-thumb"
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`${item.name} öffnen`}
            >
              {item.kind === "image" ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={item.url} alt="" loading="lazy" />
              ) : item.kind === "video" ? (
                <FileVideo size={36} />
              ) : item.kind === "audio" ? (
                <FileAudio size={36} />
              ) : item.kind === "pdf" ? (
                <FilePdf size={36} />
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
              ).toLocaleDateString("de-DE")}
            </small>
            <button
              className="text-button media-page"
              onClick={() => onOpen(item.pageId)}
              title={`Seite „${item.pageTitle}“ öffnen`}
            >
              {item.pageTitle}
            </button>
          </li>
        ))}
      </ul>
      {!loading && !items.length && !error && (
        <div className="empty-state">
          <Images size={38} />
          <h3>Keine Dateien</h3>
          <p>
            {query || kind !== "all"
              ? "Keine Datei passt zu diesem Filter."
              : "Lade Bilder oder Dateien in eine Seite hoch."}
          </p>
        </div>
      )}
      {items.length < total && (
        <button
          className="button"
          disabled={loading}
          onClick={() => void load(items.length)}
        >
          Weitere laden
        </button>
      )}
    </div>
  );
}
