"use client";
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
      title="Cover auswählen"
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
            alt="Cover-Vorschau"
            style={{ objectPosition: `50% ${position}%` }}
          />
        ) : (
          !cover && <span className="muted">Kein Cover</span>
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
              aria-label={`Cover ${color}`}
              aria-pressed={cover === color}
              key={color}
              style={{ background: color }}
              onClick={() => setCover(color)}
            />
          ))}
        </div>
        <label>
          Coverbild hochladen
          <input
            type="file"
            accept={imageAccept}
            aria-label="Coverbild hochladen"
            onChange={async (event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (!file) return;
              if (file.size > 10 * 1024 * 1024) {
                setError("Maximal 10 MB pro Bild.");
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
                  throw new Error(result.error || "Upload fehlgeschlagen.");
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
        <p className="muted">PNG, JPEG, GIF, WebP oder AVIF · maximal 10 MB</p>
        {[...uploads, ...images].length > 0 && (
          <label>
            Vorhandenes Bild
            <Select
              aria-label="Vorhandenes Bild"
              value={image ? cover : ""}
              onChange={(event) => {
                setCover(event.target.value);
                setPosition(50);
              }}
            >
              <option value="">Bild auswählen</option>
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
            Bildausschnitt · {Math.round(position)} %
            <input
              type="range"
              aria-label="Vertikale Coverposition"
              min="0"
              max="100"
              value={position}
              onChange={(event) => setPosition(Number(event.target.value))}
            />
            <span className="cover-position-labels">
              <small>Oben</small>
              <small>Unten</small>
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
          Cover entfernen
        </button>
        <button className="button" disabled={busy} onClick={onClose}>
          Abbrechen
        </button>
        <button
          className="button primary"
          disabled={busy}
          onClick={() => save()}
        >
          {busy ? "Bitte warten …" : "Speichern"}
        </button>
      </div>
    </Modal>
  );
}
