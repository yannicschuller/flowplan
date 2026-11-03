"use client";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DotsThree } from "@phosphor-icons/react";
import { useT } from "./i18n";
import {
  COLLAPSED_LINE_CHOICES,
  collapsedLines,
  formatLineRanges,
  normalizeLineRanges,
  parseLineRanges,
  startLine,
  type CodeBlockOptions,
} from "@/lib/code-block-options";

// The options of a code block (#93, #94): line numbers with their start,
// highlighted lines and the collapsed height. A small dialog below the
// "…" button of the block's toolbar; Escape or a click elsewhere closes it.
export function CodeBlockMenu({
  attrs,
  numbered,
  collapsed,
  collapsible,
  onChange,
}: {
  attrs: Partial<CodeBlockOptions>;
  // What the block shows now (its own setting or the personal default).
  numbered: boolean;
  collapsed: boolean;
  collapsible: boolean;
  onChange: (attrs: Partial<CodeBlockOptions>) => void;
}) {
  const t = useT();
  const id = useId();
  const button = useRef<HTMLButtonElement>(null),
    panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<{ top: number; left: number; up: boolean } | null>(null);
  const start = startLine(attrs.startLine);
  // Highlighted lines as shown (from the start number), stored from 1.
  const shown = formatLineRanges(parseLineRanges(attrs.highlightLines || ""), start - 1);
  const [lines, setLines] = useState(shown);
  const [first, setFirst] = useState(String(start));
  useEffect(() => setLines(shown), [shown]);
  useEffect(() => setFirst(String(start)), [start]);

  const position = () => {
    const rect = button.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(280, window.innerWidth - 24);
    // Above the button when there is no room below.
    const below = window.innerHeight - rect.bottom;
    const up = below < 340 && rect.top > below;
    setPlace({
      top: up ? rect.top - 4 : rect.bottom + 4,
      left: Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12)),
      up,
    });
  };
  const close = (focus = true) => {
    setOpen(false);
    if (focus) button.current?.focus({ preventScroll: true });
  };
  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLElement>("input, select, button")?.focus({ preventScroll: true });
    const outside = (e: PointerEvent) => {
      if (!panel.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) close(false);
    };
    const reposition = (e: Event) => {
      if (!panel.current?.contains(e.target as Node)) position();
    };
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", reposition, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", reposition, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const saveLines = () => {
    const next = normalizeLineRanges(lines, start);
    if (next !== (attrs.highlightLines || "")) onChange({ highlightLines: next });
    else setLines(shown);
  };
  const saveStart = () => {
    const next = first.trim() === "" ? 1 : startLine(first);
    if (next !== start) onChange({ startLine: next });
    else setFirst(String(start));
  };
  const enter = (save: () => void) => (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      save();
    }
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        className="code-block-more"
        aria-label={t("Codeblock-Optionen", "Code block options")}
        title={t("Codeblock-Optionen", "Code block options")}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? `${id}-panel` : undefined}
        onClick={() => {
          if (open) return close();
          position();
          setOpen(true);
        }}
      >
        <DotsThree size={16} weight="bold" aria-hidden="true" />
      </button>
      {open &&
        place &&
        createPortal(
          <div
            ref={panel}
            id={`${id}-panel`}
            role="dialog"
            aria-label={t("Codeblock-Optionen", "Code block options")}
            className={`code-block-options${place.up ? " up" : ""}`}
            style={{ top: place.top, left: place.left }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                close();
              }
            }}
          >
            <label className="code-option-check">
              <input type="checkbox" checked={numbered} onChange={(e) => onChange({ lineNumbers: e.target.checked })} />
              {t("Zeilennummern", "Line numbers")}
            </label>
            <label className="code-option-field">
              <span>{t("Erste Zeilennummer", "First line number")}</span>
              <input
                type="number"
                inputMode="numeric"
                min={0}
                max={1000000}
                value={first}
                onChange={(e) => setFirst(e.target.value)}
                onBlur={saveStart}
                onKeyDown={enter(saveStart)}
              />
            </label>
            <label className="code-option-field">
              <span>{t("Zeilen hervorheben", "Highlight lines")}</span>
              <input
                type="text"
                inputMode="numeric"
                placeholder={t("z. B. 3-5, 8", "e.g. 3-5, 8")}
                value={lines}
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => setLines(e.target.value)}
                onBlur={saveLines}
                onKeyDown={enter(saveLines)}
              />
            </label>
            <hr />
            <label className="code-option-check">
              <input type="checkbox" checked={collapsed} disabled={!collapsible} onChange={(e) => onChange({ collapsed: e.target.checked })} />
              {t("Eingeklappt", "Collapsed")}
            </label>
            <label className="code-option-field">
              <span>{t("Höhe eingeklappt", "Collapsed height")}</span>
              <select value={collapsedLines(attrs.collapsedLines)} onChange={(e) => onChange({ collapsedLines: Number(e.target.value) })}>
                {COLLAPSED_LINE_CHOICES.map((n) => (
                  <option key={n} value={n}>
                    {t(`${n} Zeilen`, `${n} lines`)}
                  </option>
                ))}
              </select>
            </label>
          </div>,
          document.body,
        )}
    </>
  );
}
