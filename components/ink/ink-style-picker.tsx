"use client";
// Beyond the toolbar's preset colours: an own colour (colour picker with
// recent colours) – a button with its small menu (.ink-menu, placed by
// menu-placement.ts). The free width, the text size and face are in the
// tool's panel (ink-panel.tsx).
import { useEffect, useRef, useState } from "react";
import { Plus } from "@phosphor-icons/react";
import { useT } from "../i18n";
import type { InkEditor } from "./use-ink-editor";
import { useMenuPlacement } from "./menu-placement";
import { ColorPicker } from "./color-picker";

// A button with a menu under it; closes on a tap elsewhere and on Escape.
export function InkPopover({
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
