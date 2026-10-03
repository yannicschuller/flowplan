"use client";
import { useT } from "./i18n";
import { useState } from "react";
import { imageAccept, type PageImage } from "@/lib/page-appearance";
import { compressImage } from "@/lib/image-compress";

// Image icons are uploaded to (or chosen from) the images of a page; database
// records use the images of their database page.
export function IconImagePicker({
  pageId,
  current,
  images,
  onSelect,
}: {
  pageId: string;
  current: string;
  images: PageImage[];
  onSelect: (icon: string) => Promise<void>;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [uploads, setUploads] = useState<PageImage[]>([]);
  const all = [
    ...new Map([...uploads, ...images].map((i) => [i.url, i])).values(),
  ];
  async function choose(url: string) {
    setBusy(true);
    setError("");
    try {
      await onSelect(url);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="icon-image-picker">
      <label className="button">
        {t("Bild hochladen", "Upload image")}
        <input
          type="file"
          accept={imageAccept}
          hidden
          disabled={busy}
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
              body.set("pageId", pageId);
              body.set("file", file);
              body.set("purpose", "cover");
              const response = await fetch("/api/upload", {
                method: "POST",
                body,
              });
              const result = await response.json();
              if (!response.ok)
                throw new Error(result.error || t("Upload fehlgeschlagen.", "Upload failed."));
              setUploads((prior) => [...prior, result]);
              await onSelect(result.url);
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        />
      </label>
      <p className="muted">
        {t("Quadratische Bilder wirken am besten · PNG, JPEG, GIF, WebP oder AVIF · maximal 10 MB", "Square images work best · PNG, JPEG, GIF, WebP or AVIF · at most 10 MB")}
      </p>
      {all.length > 0 && (
        <div
          className="icon-image-grid"
          role="listbox"
          aria-label={t("Bilder dieser Seite", "Images on this page")}
        >
          {all.map((image) => (
            <button
              key={image.url}
              role="option"
              aria-selected={current === image.url}
              aria-label={t(`${image.name} als Seitensymbol`, `${image.name} as page icon`)}
              disabled={busy}
              onClick={() => void choose(image.url)}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={image.url} alt="" />
            </button>
          ))}
        </div>
      )}
      {error && (
        <p role="alert" className="lifecycle-error">
          {error}
        </p>
      )}
    </div>
  );
}
