"use client";
// Beyond the toolbar's preset colours and widths: an own colour (colour
// picker with recent colours) and a free width – for text the size and the
// typeface. Two buttons, each with its small menu (.ink-menu, placed by
// menu-placement.ts); self-contained so they can move into another pen
// settings layout as they are.
import { useEffect, useRef, useState } from "react";
import { Plus, SlidersHorizontal } from "@phosphor-icons/react";
import { useLocale, useT } from "../i18n";
import { HIGHLIGHTER_OPACITY, clampWidth } from "@/lib/ink/presets";
import { INK_FONTS, INK_FONT_NAMES, inkFontFamily, type InkFont } from "@/lib/ink/fonts";
import type { InkEditor } from "./use-ink-editor";
import { useMenuPlacement } from "./menu-placement";
import { ColorPicker } from "./color-picker";

// A button with a menu under it; closes on a tap elsewhere and on Escape.
function InkPopover({
  label,
  title,
  className,
  pressed,
  button,
  children,
}: {
  label: string;
  title?: string;
  className?: string;
  pressed?: boolean;
  button: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const place = useMenuPlacement();
  useEffect(() => {
    if (!open) return;
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
  }, [open]);
  return (
    <div className="ink-menu-anchor" ref={anchor}>
      <button
        ref={trigger}
        type="button"
        aria-label={label}
        title={title || label}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-pressed={pressed}
        className={`${className || ""}${pressed ? " active" : ""}`}
        onClick={() => setOpen((o) => !o)}
      >
        {button}
      </button>
      {open && (
        <div ref={place} className="ink-menu ink-picker" role="dialog" aria-label={label}>
          {children}
        </div>
      )}
    </div>
  );
}

// "+" after the colours: the colour picker. Shows the own colour in use.
export function InkCustomColor({ editor }: { editor: InkEditor }) {
  const t = useT();
  const color = editor.style.color;
  const custom = !editor.palette.includes(color);
  return (
    <InkPopover
      label={t("Eigene Farbe", "Custom colour")}
      className="ink-swatch ink-swatch-custom"
      pressed={custom}
      button={custom ? <span className="ink-swatch-custom-dot" style={{ background: color }} /> : <Plus size={14} weight="bold" />}
    >
      <ColorPicker value={color} onChange={(c) => editor.setStyle({ color: c })} onCommit={editor.rememberCustomColor} recent={editor.recentColors} />
    </InkPopover>
  );
}

// The free width (pen, highlighter) or size and face (text).
export function InkWidthControl({ editor }: { editor: InkEditor }) {
  const t = useT();
  const locale = useLocale();
  const text = editor.tool === "text";
  const kind = text ? "text" : editor.tool === "highlighter" ? "highlighter" : "pen";
  const { min, max, step } = editor.widthRange;
  const width = editor.style.width;
  const custom = !editor.widths.includes(width) || (text && !!editor.style.font);
  const number = (n: number) => n.toLocaleString(locale, { maximumFractionDigits: step < 1 ? 1 : 0 });
  const set = (value: number) => editor.setStyle({ width: clampWidth(kind, value) });
  const label = text ? t("Schriftgröße und Schriftart", "Text size and font") : t("Strichstärke einstellen", "Set line width");
  return (
    <InkPopover label={label} pressed={custom} button={<SlidersHorizontal size={19} />}>
      <div className="ink-picker-head">
        <span>{text ? t("Schriftgröße", "Text size") : t("Strichstärke", "Line width")}</span>
        <output>{number(width)} pt</output>
      </div>
      <div className="ink-picker-slider">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={width}
          aria-label={text ? t("Schriftgröße", "Text size") : t("Strichstärke", "Line width")}
          aria-valuetext={`${number(width)} pt`}
          onChange={(e) => set(Number(e.target.value))}
        />
        {text && (
          <input
            type="number"
            className="ink-picker-number"
            min={min}
            max={max}
            step={step}
            value={width}
            aria-label={t("Schriftgröße in Punkt", "Text size in points")}
            onChange={(e) => e.target.value !== "" && Number.isFinite(e.target.valueAsNumber) && set(e.target.valueAsNumber)}
          />
        )}
      </div>
      <div className="ink-picker-preview" aria-hidden="true">
        {text ? (
          <span style={{ fontFamily: inkFontFamily(editor.style.font), fontSize: Math.min(width, 44), color: editor.style.color }}>
            {t("Notiz", "Note")} Abc 123
          </span>
        ) : (
          <svg viewBox="0 0 240 48" preserveAspectRatio="xMidYMid meet">
            <path
              d="M14 30 C 50 6, 80 6, 110 24 S 170 44, 226 18"
              fill="none"
              stroke={editor.style.color}
              strokeOpacity={kind === "highlighter" ? HIGHLIGHTER_OPACITY : 1}
              strokeWidth={Math.min(40, width * 1.33)}
              strokeLinecap="round"
            />
          </svg>
        )}
      </div>
      {text && (
        <div className="ink-picker-fonts" role="radiogroup" aria-label={t("Schriftart", "Font")}>
          {([undefined, ...INK_FONTS] as (InkFont | undefined)[]).map((font) => (
            <button
              key={font || "default"}
              type="button"
              role="radio"
              aria-checked={editor.style.font === font}
              className={editor.style.font === font ? "active" : ""}
              style={{ fontFamily: inkFontFamily(font) }}
              onClick={() => editor.setStyle({ font })}
            >
              {font ? INK_FONT_NAMES[font] : t("Standard", "Default||font")}
            </button>
          ))}
        </div>
      )}
    </InkPopover>
  );
}
