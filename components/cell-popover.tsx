"use client";
// A table cell whose editor needs more room than the cell has (#607): the
// cell keeps showing its value and the editor opens in a popover anchored
// to it – placed like the option picker's list (components/option-picker.tsx,
// listPlacement): in the window or the dialog, below the cell or above it
// near the bottom, kept inside the window's width, following the cell when
// the page or the table scrolls. Used for dates: day, "+ Uhrzeit", the
// time, "Datum entfernen" and the time zone (components/date-input.tsx),
// which clipped in a narrow column and spilled out of the row.
//
// Keys as in the other cell editors: Enter in a field saves and closes,
// Escape closes without saving, Tab past the last control (Shift+Tab before
// the first) saves and goes on from the cell. A click elsewhere saves and
// closes. The focus goes back to the row after Enter and Escape.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { listPlacement, type ListPlacement } from "./select";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const shownFocusable = (root: ParentNode) =>
  [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el.getClientRects().length > 0);

export function CellPopover({
  label,
  display,
  children,
  onClose,
}: {
  // The popover's name for screen readers (the property's name).
  label: string;
  // What the cell shows meanwhile (its value as in the table).
  display: ReactNode;
  // The editor; it saves when the focus leaves it (commit "blur").
  // `active()` is false once Escape dropped the edit: a save that still
  // comes (the editor's blur as it goes) is ignored.
  children: (active: () => boolean) => ReactNode;
  onClose: () => void;
}) {
  const anchor = useRef<HTMLSpanElement>(null),
    box = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<ListPlacement | null>(null);
  const blurTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const closed = useRef(false),
    discarded = useRef(false);
  const latestClose = useRef(onClose);
  latestClose.current = onClose;
  const close = () => {
    if (closed.current) return;
    closed.current = true;
    latestClose.current();
  };
  useLayoutEffect(() => {
    // Against the whole cell, not only its text.
    const at = () => {
      const cell = anchor.current?.closest<HTMLElement>("td") ?? anchor.current;
      if (cell) setPlace(listPlacement(cell));
    };
    at();
    const moved = (e: Event) => {
      if (!box.current?.contains(e.target as Node)) at();
    };
    window.addEventListener("resize", at);
    window.addEventListener("scroll", moved, true);
    // A press on the cell (also beside its text) keeps the focus in the
    // editor – the second click of a double-click lands there.
    const cell = anchor.current?.closest("td");
    const keep = (e: MouseEvent) => e.preventDefault();
    cell?.addEventListener("mousedown", keep);
    // A press elsewhere closes it – also when the focus had already left
    // (a button that went away, like "Datum entfernen"). The editor saves
    // on its blur first.
    const outside = (e: PointerEvent) => {
      const target = e.target as Node;
      if (box.current?.contains(target) || cell?.contains(target) || anchor.current?.contains(target)) return;
      // The list of the clock-change choice (a styled select) is the editor's too.
      if (target instanceof Element && target.closest(".fp-select-list")) return;
      const active = document.activeElement;
      if (active instanceof HTMLElement && box.current?.contains(active)) active.blur();
      close();
    };
    document.addEventListener("pointerdown", outside, true);
    return () => {
      window.removeEventListener("resize", at);
      window.removeEventListener("scroll", moved, true);
      cell?.removeEventListener("mousedown", keep);
      document.removeEventListener("pointerdown", outside, true);
    };
  }, []);
  // Positions through custom properties (strict CSP: no style attributes).
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || !place) return;
    el.style.setProperty("--cell-popover-top", `${place.top}px`);
    el.style.setProperty("--cell-popover-left", `${place.left}px`);
    el.style.setProperty("--cell-popover-width", `${place.width}px`);
    // Not past the window's right edge (a column at the right, a phone).
    const rect = el.getBoundingClientRect();
    const over = Math.min(rect.right - (window.innerWidth - 8), rect.left - 8);
    if (over > 0) el.style.setProperty("--cell-popover-left", `${place.left - over}px`);
  });
  // The editor's first field takes the focus once the popover is placed.
  const placed = !!place;
  useEffect(() => {
    if (placed) box.current?.querySelector<HTMLElement>("input, button, select")?.focus({ preventScroll: true });
  }, [placed]);
  useEffect(() => () => clearTimeout(blurTimer.current), []);
  const row = () => anchor.current?.closest<HTMLElement>("tr") ?? null;
  // Back to the row (it takes ↑/↓ and Enter, components/database-view.tsx).
  const toRow = () => {
    const r = row();
    if (r) requestAnimationFrame(() => r.isConnected && r.focus({ preventScroll: true }));
  };
  // The control before or after the cell in the page, for Tab.
  const besideCell = (back: boolean) => {
    const cell = anchor.current?.closest("td") ?? anchor.current;
    if (!cell) return null;
    const all = shownFocusable(document).filter((el) => !cell.contains(el) && !box.current?.contains(el));
    const after = all.filter((el) => cell.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
    return back ? all.filter((el) => !after.includes(el)).at(-1) ?? null : after[0] ?? null;
  };
  const keyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // The table's keys (↑/↓ between rows, Enter opens the record) and the
    // page's shortcuts stay out of the editor.
    e.stopPropagation();
    if (e.nativeEvent.isComposing) return;
    const target = e.target as HTMLElement;
    if (e.key === "Escape") {
      e.preventDefault();
      discarded.current = true;
      close();
      toRow();
    } else if (e.key === "Enter" && target instanceof HTMLInputElement) {
      e.preventDefault();
      // A date that cannot be read stays open with its message.
      if (box.current?.querySelector('[aria-invalid="true"]')) return;
      // Leaving the editor saves it (its blur); then it closes.
      const r = row();
      if (r) r.focus({ preventScroll: true });
      else target.blur();
      close();
    } else if (e.key === "Tab") {
      const inside = shownFocusable(box.current!);
      const edge = e.shiftKey ? inside[0] : inside.at(-1);
      if (target !== edge) return;
      e.preventDefault();
      const next = besideCell(e.shiftKey);
      if (next) next.focus({ preventScroll: false });
      else target.blur();
      close();
    }
  };
  // Leaving the popover (a click elsewhere): the editor saved on its blur;
  // it closes after a moment, unless the focus came back.
  const left = (to: Node | null) => {
    if (box.current?.contains(to)) return;
    clearTimeout(blurTimer.current);
    blurTimer.current = setTimeout(() => {
      if (box.current && !box.current.contains(document.activeElement)) close();
    }, 120);
  };
  return (
    // The cell's click does not open it again.
    <span ref={anchor} className="cell-popover-anchor" onClick={(e) => e.stopPropagation()}>
      {display}
      {place &&
        createPortal(
          // data-layer: Escape closes the popover, not a dialog around the
          // table (components/layer-host.ts).
          <div
            ref={box}
            role="dialog"
            aria-label={label}
            data-layer=""
            className={`fp-select-list cell-popover${place.up ? " up" : ""}${place.fixed ? " fixed" : ""}`}
            onKeyDown={keyDown}
            onBlur={(e) => left(e.relatedTarget as Node | null)}
            // A press on the popover's background keeps the focus in the
            // editor; clicks stay out of the cell and row below in React's tree.
            onMouseDown={(e) => {
              if (!(e.target as Element).closest("input, button, select, textarea, label")) e.preventDefault();
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {children(() => !discarded.current)}
          </div>,
          place.host,
        )}
    </span>
  );
}
