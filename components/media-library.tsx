"use client";
import { serverMessage } from "@/lib/i18n-errors";
import { LOCALE_TAG } from "@/lib/locale-tag";
import { useT } from "./i18n";
import { PdfThumbnail } from "./pdf-viewer";
import { Modal } from "./ui";
import { useEffect, useRef, useState } from "react";
import {
  File as FileIcon,
  FileAudio,
  FileVideo,
  Images,
  Trash,
} from "@phosphor-icons/react";
import type { MediaItem, MediaKind, MediaUsage } from "@/lib/media-library";

// i18n-table: 2 – [kind, German, English]
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

type Act = (b: Record<string, unknown>) => Promise<unknown>;

// All files of the pages you can read in this workspace. Files nothing
// refers to any more are marked "Nicht verwendet"; those you may edit can be
// moved to the trash, one, several or all unused at once (#164,
// lib/file-trash.ts).
export function MediaLibrary({
  workspaceId,
  act,
  onOpen,
  onOpenTrash,
}: {
  workspaceId: string;
  act: Act;
  onOpen: (pageId: string) => void;
  onOpenTrash: () => void;
}) {
  const t = useT();
  const [kind, setKind] = useState<MediaKind>("all"),
    [usage, setUsage] = useState<MediaUsage>("all"),
    [query, setQuery] = useState(""),
    [items, setItems] = useState<MediaItem[]>([]),
    [total, setTotal] = useState(0),
    [bytes, setBytes] = useState(0),
    [unused, setUnused] = useState(0),
    [unusedDeletable, setUnusedDeletable] = useState(0),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [selected, setSelected] = useState<Set<string>>(new Set()),
    [confirmUnused, setConfirmUnused] = useState(false),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [reload, setReload] = useState(0);
  const requested = useRef(0);
  async function load(offset: number, signal?: AbortSignal) {
    const request = ++requested.current;
    setLoading(true);
    setError("");
    try {
      const response = await fetch(
        `/api/media?${new URLSearchParams({
          workspace: workspaceId,
          kind,
          usage,
          q: query,
          offset: String(offset),
        })}`,
        { signal, cache: "no-store" },
      );
      const data = await response.json();
      if (!response.ok) throw new Error(serverMessage(data.error));
      if (request !== requested.current) return;
      setItems((current) =>
        offset ? [...current, ...data.items] : data.items,
      );
      setTotal(data.total);
      setBytes(data.bytes);
      setUnused(data.unused || 0);
      setUnusedDeletable(data.unusedDeletable || 0);
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => void load(0, controller.signal), 200);
    setSelected(new Set());
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, kind, usage, query, reload]);
  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const moved = (count: number) =>
    setNotice(
      count === 1
        ? t("1 Datei in den Papierkorb verschoben.", "1 file moved to the trash.")
        : t(`${count} Dateien in den Papierkorb verschoben.`, `${count} files moved to the trash.`),
    );
  async function trash(ids: string[]) {
    if (!ids.length || busy) return;
    setBusy(true);
    try {
      const result = (await act({ action: "file.delete", fileIds: ids })) as { files?: number } | null;
      if (result) {
        moved(result.files ?? ids.length);
        setReload((n) => n + 1);
      }
    } finally {
      setBusy(false);
    }
  }
  async function trashUnused() {
    setBusy(true);
    try {
      const result = (await act({ action: "files.deleteUnused", workspaceId, kind, query })) as { files?: number } | null;
      if (result) {
        setConfirmUnused(false);
        moved(result.files ?? 0);
        setReload((n) => n + 1);
      }
    } finally {
      setBusy(false);
    }
  }
  const selectable = items.filter((i) => i.canDelete);
  return (
    <div className="utility-content media-library">
      <div className="utility-title">
        <Images size={30} />
        <h1>{t("Medien", "Media")}</h1>
        <p>
          {t("Bilder, Videos und Dateien aus allen Seiten, die du lesen kannst.", "Images, videos and files from all pages you can read.")}
          {total > 0 &&
            (total === 1
              ? t(` 1 Datei · ${size(bytes)}`, ` 1 file · ${size(bytes)}`)
              : t(` ${total} Dateien · ${size(bytes)}`, ` ${total} files · ${size(bytes)}`))}
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
      <div className="media-usage">
        <div role="radiogroup" aria-label={t("Verwendung", "Usage||whether files are used")}>
          <button
            role="radio"
            aria-checked={usage === "all"}
            className={`chip${usage === "all" ? " active" : ""}`}
            onClick={() => setUsage("all")}
          >
            {t("Alle Dateien", "All files")}
          </button>
          <button
            role="radio"
            aria-checked={usage === "unused"}
            className={`chip${usage === "unused" ? " active" : ""}`}
            onClick={() => setUsage("unused")}
          >
            {t(`Nicht verwendet (${unused})`, `Not used (${unused})`)}
          </button>
        </div>
        {usage === "unused" && unusedDeletable > 0 && (
          <button className="button danger compact" disabled={busy} onClick={() => setConfirmUnused(true)}>
            <Trash />
            {t("Alle unbenutzten löschen", "Delete all unused")}
          </button>
        )}
      </div>
      {notice && (
        <p className="media-notice" role="status">
          {notice}{" "}
          <button className="text-button" onClick={onOpenTrash}>
            {t("Papierkorb öffnen", "Open trash")}
          </button>
        </p>
      )}
      {selected.size > 0 && (
        <div className="media-selection-bar" role="toolbar" aria-label={t("Dateiauswahl", "File selection")}>
          <span>{selected.size} {t("ausgewählt", "selected")}</span>
          {selected.size < selectable.length && (
            <button className="text-button" onClick={() => setSelected(new Set(selectable.map((i) => i.id)))}>
              {t("Alle auswählen", "Select all")}
            </button>
          )}
          <button className="text-button danger" disabled={busy} onClick={() => void trash([...selected])}>
            {t("In den Papierkorb", "Move to trash")}
          </button>
          <button className="text-button" onClick={() => setSelected(new Set())}>
            {t("Auswahl aufheben", "Clear selection")}
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="field-error">
          {error}
        </p>
      )}
      <ul className="media-grid" aria-label={t("Dateien", "Files")}>
        {items.map((item) => (
          <li key={item.id} className={`media-item${selected.has(item.id) ? " is-selected" : ""}`}>
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
            {item.canDelete && (
              <label className="media-select" title={t("Auswählen", "Select")}>
                <input
                  type="checkbox"
                  checked={selected.has(item.id)}
                  onChange={() => toggle(item.id)}
                  aria-label={t(`${item.name} auswählen`, `Select ${item.name}`)}
                />
              </label>
            )}
            {item.unused && <span className="media-unused">{t("Nicht verwendet", "Not used")}</span>}
            <span className="media-name" title={item.name}>
              {item.name}
            </span>
            <small className="muted">
              {size(item.size)} ·{" "}
              {new Date(
                item.created_at.replace(" ", "T") + "Z",
              ).toLocaleDateString(LOCALE_TAG)}
            </small>
            <span className="media-actions">
              <button
                className="text-button media-page"
                onClick={() => onOpen(item.pageId)}
                title={t(`Seite „${item.pageTitle}“ öffnen`, `Open page “${item.pageTitle}”`)}
              >
                {item.pageTitle}
              </button>
              {item.canDelete && (
                <button
                  className="icon-button media-delete"
                  disabled={busy}
                  onClick={() => void trash([item.id])}
                  title={t("In den Papierkorb", "Move to trash")}
                  aria-label={t(`${item.name} in den Papierkorb`, `Move ${item.name} to the trash`)}
                >
                  <Trash size={15} />
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
      {!loading && !items.length && !error && (
        <div className="empty-state">
          <Images size={38} />
          <h3>{t("Keine Dateien", "No files")}</h3>
          <p>
            {usage === "unused" && !query && kind === "all"
              ? t("Alle Dateien werden verwendet.", "Every file is in use.")
              : query || kind !== "all" || usage !== "all"
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
      <Modal
        open={confirmUnused}
        onClose={() => !busy && setConfirmUnused(false)}
        title={t("Alle unbenutzten löschen", "Delete all unused")}
      >
        <p>
          {unusedDeletable === 1
            ? t(
                "1 Datei, die in keiner Seite, keinem Eintrag, Whiteboard oder Kommentar mehr vorkommt, in den Papierkorb verschieben?",
                "Move 1 file that no page, record, whiteboard or comment uses any more to the trash?",
              )
            : t(
                `${unusedDeletable} Dateien, die in keiner Seite, keinem Eintrag, Whiteboard oder Kommentar mehr vorkommen, in den Papierkorb verschieben?`,
                `Move ${unusedDeletable} files that no page, record, whiteboard or comment uses any more to the trash?`,
              )}{" "}
          {t(
            "Ältere Versionen im Versionsverlauf können sie noch zeigen: Sobald sie endgültig gelöscht sind, erscheint dort ein Platzhalter für eine fehlende Datei. Bis dahin kannst du sie aus dem Papierkorb wiederherstellen.",
            "Older versions in the version history may still show them: once they are deleted for good, a placeholder for a missing file appears there instead. Until then you can restore them from the trash.",
          )}
        </p>
        <div className="modal-actions">
          <button className="button" disabled={busy} onClick={() => setConfirmUnused(false)}>
            {t("Abbrechen", "Cancel")}
          </button>
          <button className="button danger" disabled={busy} onClick={() => void trashUnused()}>
            {t("In den Papierkorb", "Move to trash")}
          </button>
        </div>
      </Modal>
    </div>
  );
}
