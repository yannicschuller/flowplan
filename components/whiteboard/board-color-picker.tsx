"use client";
// An own colour besides the board's palettes (#455): the colour wheel of
// the handwriting and PDF annotations (components/ink/color-picker.tsx) with
// the colours used lately – the same list on this device as there
// (lib/ink/presets.ts). In the style bar it opens as a small menu under the
// bar; in a tool's options (pen, notes) it unfolds in place.
import { useEffect, useRef, useState } from "react";
import { Plus } from "@phosphor-icons/react";
import { useT } from "../i18n";
import { ColorPicker } from "../ink/color-picker";
import { loadRecentColors, rememberColor } from "@/lib/ink/presets";
import { isHexColor } from "@/lib/whiteboard-own-colors";
import { fitBarMenu } from "./item-tools";

const FALLBACK = "#1f2937";
const isOwn = (value: string | undefined, presets: readonly string[]) =>
  isHexColor(value) && !presets.some((p) => p.toLowerCase() === value.toLowerCase());

export function BoardColorPicker({
  label,
  value,
  presets,
  onPick,
  inline = false,
}: {
  label: string;
  value: string | undefined;
  presets: readonly string[];
  // Every move of the wheel; `done` once a colour is settled.
  onPick: (color: string, done: boolean) => void;
  inline?: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [recent, setRecent] = useState<string[]>([]);
  const anchor = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const own = isOwn(value, presets);
  useEffect(() => {
    if (!open) return;
    setRecent(loadRecentColors());
    if (inline) return;
    const close = (event: PointerEvent) => {
      if (!anchor.current?.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [open, inline]);
  const commit = (color: string) => {
    onPick(color, true);
    if (!presets.some((p) => p.toLowerCase() === color.toLowerCase())) setRecent(rememberColor(color));
  };
  const picker = (
    <ColorPicker value={isHexColor(value) ? value.toLowerCase() : FALLBACK} onChange={(c) => onPick(c, false)} onCommit={commit} recent={recent} />
  );
  return (
    <span className={inline ? "wb-own-color inline" : "wb-arrange wb-own-color"} ref={anchor}>
      <button
        ref={trigger}
        type="button"
        className={`wb-own-color-button${own ? " active" : ""}`}
        aria-label={label}
        title={label}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-pressed={own}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((o) => !o)}
      >
        {own ? <span className="wb-own-color-dot" ref={(el) => el?.style.setProperty("--own-color", value!)} /> : <Plus size={12} weight="bold" />}
      </button>
      {open &&
        (inline ? (
          <span className="wb-own-color-panel" role="group" aria-label={label} onKeyDown={(e) => e.stopPropagation()}>
            {picker}
          </span>
        ) : (
          <span ref={fitBarMenu} className="wb-arrange-menu wb-own-color-menu" role="dialog" aria-label={label} onKeyDown={(e) => e.stopPropagation()}>
            {picker}
            <small className="wb-own-color-hint">{t("Bleibt auch auf der dunklen Fläche so.", "Stays like this on the dark canvas too.")}</small>
          </span>
        ))}
    </span>
  );
}
