"use client";
import { useState } from "react";
export function GalleryCover({
  url,
  fit,
}: {
  url?: string;
  fit: "cover" | "contain";
}) {
  const [failed, setFailed] = useState(false);
  return (
    <span className="gallery-cover" aria-hidden="true">
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
        <span className="muted">Kein Bild</span>
      )}
    </span>
  );
}
