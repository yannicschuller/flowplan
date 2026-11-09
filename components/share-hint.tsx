"use client";
// A small (i) beside a label in the share dialog: the longer explanation
// shows as a tooltip on hover, focus or tap and is the button's accessible
// description all the time, so screen readers read it with the label.
import { Info } from "@phosphor-icons/react";
import { useEffect, useId, useState } from "react";
import { useT } from "./i18n";

export function Hint({ text }: { text: string }) {
  const t = useT();
  const id = useId();
  const [open, setOpen] = useState(false);
  // Escape closes the tooltip first, the dialog only after that: this
  // listener on the window runs before the dialog's own on the document.
  useEffect(() => {
    if (!open) return;
    const close = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    };
    window.addEventListener("keydown", close, true);
    return () => window.removeEventListener("keydown", close, true);
  }, [open]);
  return (
    <>
      <button
        type="button"
        className="sh-hint"
        aria-label={t("Erklärung", "Explanation")}
        aria-describedby={id}
        aria-expanded={open}
        data-open={open || undefined}
        onClick={() => setOpen(true)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
      >
        <Info aria-hidden />
      </button>
      <span role="tooltip" id={id} className="sh-tip" hidden={!open}>
        {text}
      </span>
    </>
  );
}
