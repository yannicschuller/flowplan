"use client";
import { serverMessage } from "@/lib/server-message";
import { useT } from "./i18n";
import { useEffect, useId, useRef, useState } from "react";
import { Trash, UploadSimple } from "@phosphor-icons/react";
import { Modal, needsConnection } from "./ui";
import {
  imageAccept,
  imageFileId,
  pageAppearance,
  type PageAppearance,
  type PageImage,
} from "@/lib/page-appearance";
import type { Page } from "@/lib/types";
import type { MediaItem } from "@/lib/media-library";
import { compressImage } from "@/lib/image-compress";
import { idempotencyHeaders } from "@/lib/idempotency-key";
import { primePlaceholder } from "./image-placeholder";

// Whether each of the page's images is used, from the media library
// (GET /api/media?page=…, lib/file-usage.ts): at most this many calls of 60.
const USAGE_CALLS = 10;
type Usage = Map<string, Pick<MediaItem, "unused" | "canDelete">>;

// The cover dialog. Existing images of the page that nothing refers to any
// more (a replaced or removed cover, #396) are marked "Nicht verwendet" and,
// for those who may delete the page's files, can be moved to the trash: the
// media library's file.delete (lib/file-trash.ts) with `unusedOnly`, so an
// image that is in use again meanwhile stays. Never in end-to-end encrypted
// spaces – the server cannot tell whether their files are used.
export function CoverPicker({
  page,
  images,
  onSave,
  onClose,
  removeImage,
  positioned = true,
}: {
  positioned?: boolean;
  page: Page;
  images: PageImage[];
  onSave: (
    appearance: PageAppearance,
    base: PageAppearance,
  ) => Promise<boolean>;
  onClose: () => void;
  // Moves the file to the trash (file.delete with unusedOnly); throws on
  // failure. Without it the dialog offers no removal.
  removeImage?: (fileId: string) => Promise<unknown>;
}) {
  const t = useT();
  const [base, setBase] = useState(() => pageAppearance(page));
  const [cover, setCover] = useState(base.cover);
  const [position, setPosition] = useState(base.coverPosition);
  // Opened from the page's kept copy (shown while the fresh one loads, lib/
  // swr-cache.ts): the fresh cover arrives a moment later. Untouched, the
  // dialog follows it, so saving does not report the page as changed in
  // between; with a choice made, its base stays and saving says so.
  const live = pageAppearance(page);
  const touched = cover !== base.cover || position !== base.coverPosition;
  useEffect(() => {
    if (touched || (live.cover === base.cover && live.coverPosition === base.coverPosition)) return;
    setBase(live);
    setCover(live.cover);
    setPosition(live.coverPosition);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live.cover, live.coverPosition]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [uploads, setUploads] = useState<PageImage[]>([]);
  const [fileName, setFileName] = useState("");
  const uploadId = useId();
  const image = !!imageFileId(cover);
  const [usage, setUsage] = useState<Usage>(new Map()),
    [usageRound, setUsageRound] = useState(0),
    [removed, setRemoved] = useState<Set<string>>(new Set()),
    [confirm, setConfirm] = useState<PageImage | null>(null),
    [removing, setRemoving] = useState(false),
    [notice, setNotice] = useState(""),
    list = useRef<HTMLUListElement>(null),
    justRemoved = useRef(false);
  const canRemove = !!removeImage;
  useEffect(() => {
    if (!canRemove) return;
    const controller = new AbortController();
    void (async () => {
      const found: Usage = new Map();
      for (let offset = 0, call = 0; call < USAGE_CALLS; call++) {
        const response = await fetch(
          `/api/media?${new URLSearchParams({ workspace: page.workspace_id, page: page.id, kind: "image", offset: String(offset) })}`,
          { signal: controller.signal, cache: "no-store" },
        );
        if (!response.ok) return;
        const data = (await response.json()) as { items: MediaItem[]; total: number };
        for (const item of data.items) found.set(item.id, { unused: item.unused, canDelete: item.canDelete });
        offset += data.items.length;
        if (!data.items.length || offset >= data.total) break;
      }
      if (!controller.signal.aborted) setUsage(found);
    })().catch(() => {
      // Offline or refused: no marks, nothing offered for removal.
    });
    return () => controller.abort();
  }, [canRemove, page.id, page.workspace_id, usageRound]);
  const existing = [
    ...new Map(
      [...uploads, ...images]
        .filter((item) => !removed.has(item.id))
        .map((item) => [item.url, item]),
    ).values(),
  ];
  async function remove(item: PageImage) {
    if (!removeImage || needsConnection()) return;
    setRemoving(true);
    setError("");
    setNotice("");
    try {
      await removeImage(item.id);
      justRemoved.current = true;
      setRemoved((prior) => new Set(prior).add(item.id));
      setNotice(
        t(
          `„${item.name}“ ist jetzt im Papierkorb. Von dort kannst du es wiederherstellen.`,
          `“${item.name}” is in the trash now. You can restore it from there.`,
        ),
      );
      setUsageRound((n) => n + 1);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setRemoving(false);
      setConfirm(null);
    }
  }
  async function save(value = cover) {
    setBusy(true);
    setError("");
    try {
      if (await onSave({ cover: value, coverPosition: position }, base))
        onClose();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open
      title={t("Cover auswählen", "Choose cover")}
      onClose={() => {
        if (!busy && !removing) onClose();
      }}
    >
      <div
        className="cover-preview"
        style={{ backgroundColor: cover.startsWith("#") ? cover : undefined }}
      >
        {image ? (
          <img
            src={cover}
            alt={t("Cover-Vorschau", "Cover preview")}
            style={{ objectPosition: `50% ${position}%` }}
          />
        ) : (
          !cover && <span className="muted">{t("Kein Cover", "No cover")}</span>
        )}
      </div>
      <fieldset disabled={busy} className="cover-controls">
        <div className="cover-colors">
          {[
            "#dce7f5",
            "#cdded8",
            "#f1dfc8",
            "#e2dded",
            "#263b55",
            "#c4d4e6",
          ].map((color) => (
            <button
              type="button"
              aria-label={t(`Cover ${color}`, `Cover ${color}`)}
              aria-pressed={cover === color}
              key={color}
              style={{ background: color }}
              onClick={() => setCover(color)}
            />
          ))}
        </div>
        {/* The file field as one of Flowplan's buttons: the input stays
            focusable but hidden, its label is the button. */}
        <div className="file-pick">
          <input
            id={uploadId}
            type="file"
            className="sr-only"
            accept={imageAccept}
            aria-describedby={`${uploadId}-name`}
            onChange={async (event) => {
              const picked = event.target.files?.[0];
              event.target.value = "";
              if (!picked || needsConnection()) return;
              setFileName(picked.name);
              const file = await compressImage(picked);
              if (file.size > 10 * 1024 * 1024) {
                setError(t("Maximal 10 MB pro Bild.", "At most 10 MB per image."));
                return;
              }
              setBusy(true);
              setError("");
              try {
                const body = new FormData();
                body.set("pageId", page.id);
                body.set("file", file);
                body.set("purpose", "cover");
                const response = await fetch("/api/upload", {
                  method: "POST",
                  body,
                  headers: idempotencyHeaders(),
                });
                const result = await response.json();
                if (!response.ok)
                  throw new Error(serverMessage(result.error) || t("Upload fehlgeschlagen.", "Upload failed."));
                primePlaceholder(result.url, result.placeholder);
                setUploads((prior) => [...prior, result]);
                setCover(result.url);
                setPosition(50);
              } catch (error) {
                setError((error as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          />
          <label htmlFor={uploadId} className="button">
            <UploadSimple size={16} aria-hidden />
            {t("Coverbild hochladen", "Upload cover image")}
          </label>
          <span id={`${uploadId}-name`} className="file-pick-name muted">
            {fileName || t("Keine Datei ausgewählt", "No file chosen")}
          </span>
        </div>
        <p className="muted">{t("PNG, JPEG, GIF, WebP oder AVIF · maximal 10 MB", "PNG, JPEG, GIF, WebP or AVIF · at most 10 MB")}</p>
        {/* The page's images as a list of pictures to pick (pressed: the
            chosen one); unused ones carry a mark and "Entfernen". */}
        {existing.length > 0 && (
          <fieldset className="cover-images">
            <legend>{t("Vorhandenes Bild", "Existing image")}</legend>
            <ul className="cover-image-list" ref={list} tabIndex={-1} aria-label={t("Vorhandene Bilder", "Existing images")}>
              {existing.map((item) => {
                const selected = image && cover === item.url;
                const state = usage.get(item.id);
                // The image chosen right now is about to be used: no mark.
                const unused = !!state?.unused && !selected;
                const hint = `${uploadId}-unused-${item.id}`;
                return (
                  <li key={item.id} className="cover-image">
                    <button
                      type="button"
                      className="cover-image-pick"
                      aria-pressed={selected}
                      aria-describedby={unused ? hint : undefined}
                      onClick={() => {
                        setCover(item.url);
                        setPosition(50);
                      }}
                    >
                      <img src={item.url} alt="" loading="lazy" />
                      <span className="cover-image-name" title={item.name}>
                        {item.name}
                      </span>
                    </button>
                    {unused && (
                      <span className="cover-image-meta">
                        <span id={hint} className="cover-image-unused">
                          {t("Nicht verwendet", "Not used")}
                        </span>
                        {state.canDelete && (
                          <button
                            type="button"
                            className="text-button danger cover-image-remove"
                            disabled={removing}
                            aria-label={t(`„${item.name}“ entfernen`, `Remove “${item.name}”`)}
                            onClick={() => setConfirm(item)}
                          >
                            <Trash size={14} aria-hidden />
                            {t("Entfernen", "Remove")}
                          </button>
                        )}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </fieldset>
        )}
        {notice && (
          <p className="cover-image-notice" role="status">
            {notice}
          </p>
        )}
        {image && positioned && (
          <label>
            {t("Bildausschnitt ·", "Image crop ·")}{" "}{Math.round(position)} %
            <input
              type="range"
              aria-label={t("Vertikale Coverposition", "Vertical cover position")}
              min="0"
              max="100"
              value={position}
              onChange={(event) => setPosition(Number(event.target.value))}
            />
            <span className="cover-position-labels">
              <small>{t("Oben", "Top")}</small>
              <small>{t("Unten", "Bottom")}</small>
            </span>
          </label>
        )}
      </fieldset>
      {error && (
        <p role="alert" className="math-validation">
          {error}
        </p>
      )}
      {/* Removing apart on the left (a row of its own on phones),
          Cancel and Save together on the right. */}
      <div className="modal-actions cover-actions">
        <button className="button cover-remove" disabled={busy} onClick={() => save("")}>
          {t("Cover entfernen", "Remove cover")}
        </button>
        <button className="button" disabled={busy} onClick={onClose}>
          {t("Abbrechen", "Cancel")}
        </button>
        <button
          className="button primary"
          disabled={busy}
          onClick={() => save()}
        >
          {busy ? t("Bitte warten …", "Please wait …") : t("Speichern", "Save")}
        </button>
      </div>
      <Modal
        open={!!confirm}
        title={t("Bild entfernen", "Remove image")}
        onClose={() => {
          if (!removing) setConfirm(null);
        }}
        onCloseAutoFocus={(event) => {
          // The image went with its button: focus goes to the list.
          if (!justRemoved.current) return;
          justRemoved.current = false;
          event.preventDefault();
          list.current?.focus();
        }}
      >
        <p>
          {confirm &&
            t(
              `„${confirm.name}“ wird auf keiner Seite, in keinem Eintrag, Whiteboard oder Kommentar mehr verwendet. In den Papierkorb verschieben? Bis es endgültig gelöscht ist, kannst du es von dort wiederherstellen.`,
              `No page, record, whiteboard or comment uses “${confirm.name}” any more. Move it to the trash? Until it is deleted for good, you can restore it from there.`,
            )}
        </p>
        <div className="modal-actions">
          <button className="button" disabled={removing} onClick={() => setConfirm(null)}>
            {t("Abbrechen", "Cancel")}
          </button>
          <button className="button danger" disabled={removing} onClick={() => confirm && void remove(confirm)}>
            {removing ? t("Bitte warten …", "Please wait …") : t("In den Papierkorb", "Move to trash")}
          </button>
        </div>
      </Modal>
    </Modal>
  );
}
