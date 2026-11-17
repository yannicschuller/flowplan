"use client";
import { serverMessage } from "@/lib/server-message";
import { useT } from "./i18n";
import { Select } from "./select";
import { useEffect, useId, useState } from "react";
import { UploadSimple } from "@phosphor-icons/react";
import { Modal } from "./ui";
import {
  imageAccept,
  imageFileId,
  pageAppearance,
  type PageAppearance,
  type PageImage,
} from "@/lib/page-appearance";
import type { Page } from "@/lib/types";
import { compressImage } from "@/lib/image-compress";
import { idempotencyHeaders } from "@/lib/idempotency-key";
import { primePlaceholder } from "./image-placeholder";
export function CoverPicker({
  page,
  images,
  onSave,
  onClose,
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
        if (!busy) onClose();
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
              if (!picked) return;
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
        {[...uploads, ...images].length > 0 && (
          <label>
            {t("Vorhandenes Bild", "Existing image")}
            <Select
              aria-label={t("Vorhandenes Bild", "Existing image")}
              value={image ? cover : ""}
              onChange={(event) => {
                setCover(event.target.value);
                setPosition(50);
              }}
            >
              <option value="">{t("Bild auswählen", "Choose image")}</option>
              {[
                ...new Map(
                  [...uploads, ...images].map((item) => [item.url, item]),
                ).values(),
              ].map((item) => (
                <option key={item.id} value={item.url}>
                  {item.name}
                </option>
              ))}
            </Select>
          </label>
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
    </Modal>
  );
}
