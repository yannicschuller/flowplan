"use client";
// The image alone over the page (components/image-tools.tsx, comment
// attachments #450); Escape, the close button or a click beside it closes it.
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "@phosphor-icons/react";
import { useT } from "./i18n";

export function ImageViewer({ image, onClose }: { image: { src: string; alt: string }; onClose: () => void }) {
  const t = useT();
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    close.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("keydown", key, true);
      before?.focus?.({ preventScroll: true });
    };
  }, [onClose]);
  return createPortal(
    <div className="image-viewer" role="dialog" aria-modal="true" aria-label={image.alt || t("Bild", "Image")} onClick={(e) => e.target === e.currentTarget && onClose()}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={image.src} alt={image.alt} />
      <button ref={close} type="button" className="image-viewer-close" aria-label={t("Schließen", "Close")} title={t("Schließen", "Close")} onClick={onClose}>
        <X size={20} />
      </button>
    </div>,
    document.body,
  );
}
