"use client";
// A property of an opened record, compact (#519): the value as text or
// chips – muted „Leer“ when there is none – on a button named „Stage:
// InProgress, ändern“. A click, Enter or Space opens the editor that used
// to stand open in the record: a panel below the value (a bottom sheet on
// phones, components/meeting-popover.tsx). Escape closes it and returns the
// focus to the value; a click elsewhere or Tab past its last control
// closes it as well (in the panel's own dialog: the sheet, its ✕). Plain fields save as they did, on leaving them.
// Links (a web address, a file) stay links beside the button.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { PencilSimple } from "@phosphor-icons/react";
import { useT } from "./i18n";
import { AnchoredPopover } from "./meeting-popover";

// The field to type in comes first; else any control.
const FIELD = 'input:not([disabled]):not([type="hidden"]):not([type="checkbox"]):not([type="file"]), textarea:not([disabled]), [contenteditable="true"]';
const FOCUSABLE =
  'input:not([disabled]):not([type="hidden"]), [contenteditable="true"], textarea:not([disabled]), select:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

export function RecordPropertyValue({
  name,
  text,
  display,
  links,
  wide = false,
  emptyText,
  editor,
}: {
  // What an empty value says (default „Leer“).
  emptyText?: string;
  // The property's name: the panel's title and the start of the button's.
  name: string;
  // The value as words for the button's name ("" when empty).
  text: string;
  // The value as shown (chips, text); null when empty.
  display: ReactNode;
  // Links that open (a web address, files): beside the button, which then
  // only shows a pencil.
  links?: ReactNode;
  // A wider panel (relations, files, formatted text).
  wide?: boolean;
  // The editor; `done` closes the panel and returns the focus.
  editor: (done: () => void) => ReactNode;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null),
    button = useRef<HTMLButtonElement>(null),
    body = useRef<HTMLDivElement | null>(null);
  // The editor's element as state too: on phones the panel becomes a sheet
  // after its first render, with a new element.
  const [bodyEl, setBodyEl] = useState<HTMLDivElement | null>(null);
  const bodyRef = useCallback((el: HTMLDivElement | null) => {
    body.current = el;
    setBodyEl(el);
  }, []);
  // Fields that save when they lose the focus save before the panel goes.
  const close = (refocus: boolean) => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && body.current?.contains(active)) active.blur();
    setOpen(false);
    if (refocus) requestAnimationFrame(() => button.current?.focus({ preventScroll: true }));
  };
  const closeRef = useRef(close);
  closeRef.current = close;
  // Opening: a field of the editor takes the focus at once, so typing
  // right after the click lands there (a search that focuses itself keeps
  // it) – once more after a frame, should the sheet's dialog have taken it.
  // A control that goes away (a removed file's ✕) leaves the focus in the
  // panel, so Escape still closes only the panel.
  useEffect(() => {
    if (!open || !bodyEl) return;
    const focus = () => {
      const el = bodyEl;
      if (!el || el.contains(document.activeElement)) return;
      (el.querySelector<HTMLElement>(FIELD) || el.querySelector<HTMLElement>(FOCUSABLE) || el).focus({ preventScroll: true });
    };
    focus();
    const frame = requestAnimationFrame(focus);
    const el = bodyEl;
    const observer = new MutationObserver(() => {
      const active = document.activeElement;
      // Gone to the page, or to the record's dialog (its focus trap catches
      // a removed or disabled control).
      if (!active || active === document.body || (active.getAttribute("role") === "dialog" && active.contains(el) && active !== el.closest('[role="dialog"]')))
        el.focus({ preventScroll: true });
    });
    observer.observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled"] });
    // Escape with the focus lost to the page or the record's dialog all the
    // same (a control disabled while it saves): the panel closes, not the
    // record. Heard on the window, before the dialogs on the document.
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || e.isComposing) return;
      const active = document.activeElement;
      const lost = !active || active === document.body || (active.getAttribute("role") === "dialog" && active.contains(el) && active !== el.closest('[role="dialog"]'));
      if (!lost) return;
      e.preventDefault();
      e.stopPropagation();
      closeRef.current(true);
    };
    window.addEventListener("keydown", key, true);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("keydown", key, true);
    };
  }, [open, bodyEl]);
  const empty = !text;
  const shown = text || emptyText || t("leer", "empty");
  const label = t(`${name}: ${shown}, ändern`, `${name}: ${shown}, change`);
  return (
    <span ref={wrap} className={`record-value-wrap${links && !empty ? " with-links" : ""}`}>
      {!empty && links}
      <button
        ref={button}
        type="button"
        className={`record-value${links && !empty ? " record-value-pencil" : ""}`}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? close(false) : setOpen(true))}
      >
        {links && !empty ? (
          <PencilSimple size={13} aria-hidden />
        ) : empty ? (
          <span className="record-value-empty">{emptyText || t("Leer", "Empty")}</span>
        ) : (
          display
        )}
      </button>
      {open && (
        <AnchoredPopover
          anchor={wrap.current}
          focusBack={button.current}
          label={t(`${name} ändern`, `Change ${name}`)}
          className={`record-value-popover${wide ? " wide" : ""}`}
          onClose={(reason) => close(reason === "escape")}
        >
          <div
            ref={bodyRef}
            className="record-value-editor"
            tabIndex={-1}
            // Tab past the last control (or Shift+Tab before the first):
            // the panel closes; lists of its fields count as inside.
            onBlur={(e) => {
              const to = e.relatedTarget;
              const panel = body.current?.closest('[role="dialog"]');
              if (!(to instanceof Element) || panel?.contains(to) || to.closest(".fp-select-list")) return;
              if (to === button.current) return;
              close(false);
            }}
          >
            {editor(() => close(true))}
          </div>
        </AnchoredPopover>
      )}
    </span>
  );
}
