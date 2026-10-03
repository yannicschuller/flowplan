"use client";
import { serverMessage } from "@/lib/i18n-errors";
import { useT } from "./i18n";
import { Select } from "./select";
import { useState } from "react";
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
  const [base] = useState(() => pageAppearance(page));
  const [cover, setCover] = useState(base.cover);
  const [position, setPosition] = useState(base.coverPosition);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [uploads, setUploads] = useState<PageImage[]>([]);
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
        <label>
          {t("Coverbild hochladen", "Upload cover image")}
          <input
            type="file"
            accept={imageAccept}
            aria-label={t("Coverbild hochladen", "Upload cover image")}
            onChange={async (event) => {
              const picked = event.target.files?.[0];
              event.target.value = "";
              if (!picked) return;
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
                });
                const result = await response.json();
                if (!response.ok)
                  throw new Error(serverMessage(result.error) || t("Upload fehlgeschlagen.", "Upload failed."));
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
        </label>
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
      <div className="modal-actions">
        <button className="button" disabled={busy} onClick={() => save("")}>
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
