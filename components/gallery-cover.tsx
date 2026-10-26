"use client";
import { useT } from "./i18n";
import { useState } from "react";
import { useImagePlaceholder } from "./image-placeholder";
export function GalleryCover({
  url,
  fit,
  color,
}: {
  url?: string;
  fit: "cover" | "contain";
  color?: string;
}) {
  const t = useT();
  const [failed, setFailed] = useState(false);
  // Uploaded images: their blurred placeholder until they have loaded.
  const placeholder = useImagePlaceholder(url && !failed ? url : null, { fit });
  return (
    <span
      className="gallery-cover"
      aria-hidden="true"
      style={
        !url && color && /^#[0-9a-f]{6}$/i.test(color)
          ? { background: color }
          : placeholder.frameStyle
      }
    >
      {url && !failed ? (
        <img
          src={url}
          alt=""
          loading="lazy"
          draggable={false}
          style={{ objectFit: fit }}
          onError={() => setFailed(true)}
          {...placeholder.imgProps}
        />
      ) : (
        !color && <span className="muted">{t("Kein Bild", "No image")}</span>
      )}
    </span>
  );
}
