"use client";
import { useState } from "react";
export function GalleryCover({
  url,
  fit,
  color,
}: {
  url?: string;
  fit: "cover" | "contain";
  color?: string;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <span
      className="gallery-cover"
      aria-hidden="true"
      style={
        !url && color && /^#[0-9a-f]{6}$/i.test(color)
          ? { background: color }
          : undefined
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
        />
      ) : (
        !color && <span className="muted">Kein Bild</span>
      )}
    </span>
  );
}
