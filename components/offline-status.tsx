"use client";
// Offline as a small icon at the end of the top bar (#296) instead of a
// full-width banner: tapping it opens the explanation. Screen readers still
// hear the change once (the status text below), without the banner taking
// the page's room while offline.
import { useEffect, useRef, useState } from "react";
import { WifiSlash } from "@phosphor-icons/react";
import { useT } from "./i18n";

export function OfflineStatus() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const explanation = t(
    "Offline – du siehst den zuletzt gespeicherten Stand. Textänderungen werden später abgeglichen.",
    "Offline – you see the last saved state. Text changes are synced later.",
  );
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  return (
    <span className="offline-status" ref={box}>
      <button
        type="button"
        className="icon-button offline-status-button"
        aria-label={t("Offline – Details", "Offline – details")}
        title={t("Offline", "Offline")}
        aria-expanded={open}
        aria-controls="offline-status-note"
        onClick={() => setOpen((value) => !value)}
      >
        <WifiSlash size={18} weight="bold" />
      </button>
      <span className="sr-only" role="status">
        {t("Offline", "Offline")}
      </span>
      {open && (
        <span className="offline-status-note" id="offline-status-note" role="note">
          {explanation}
        </span>
      )}
    </span>
  );
}
