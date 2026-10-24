"use client";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { CaretDown } from "@phosphor-icons/react";
import { safeInsets } from "./safe-area";

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// A toolbar chip with a small panel anchored below it (filters, sorting,
// grouping …). The panel is a dialog: it takes the focus when it opens,
// Escape closes it and hands the focus back to the chip, a click elsewhere
// closes it as well. It stays inside the window.
export function ChipPopover({
  icon,
  label,
  name,
  active = false,
  panelLabel,
  children,
  className = "",
  panelClassName = "",
  open: controlledOpen,
  onOpenChange,
}: {
  icon: ReactNode;
  // The text on the chip and, when it differs, the accessible name
  // (`name` keeps the action's word in front of a summary).
  label: string;
  name?: string;
  active?: boolean;
  panelLabel: string;
  children: ReactNode;
  className?: string;
  panelClassName?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [ownOpen, setOwnOpen] = useState(false);
  const open = controlledOpen ?? ownOpen;
  const setOpen = (next: boolean) => {
    setOwnOpen(next);
    onOpenChange?.(next);
  };
  const chip = useRef<HTMLButtonElement>(null),
    panel = useRef<HTMLDivElement>(null),
    wrap = useRef<HTMLDivElement>(null);
  const [shift, setShift] = useState(0);
  const id = useId();
  // Opening: the focus moves into the panel.
  useEffect(() => {
    if (!open) return;
    const el = panel.current;
    if (!el) return;
    const first = el.querySelector<HTMLElement>(FOCUSABLE);
    (first || el).focus({ preventScroll: true });
  }, [open]);
  // A click outside closes the panel (lists of a select inside it count as
  // inside: they are rendered into the dialog).
  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => {
      const target = e.target as Node;
      if (wrap.current?.contains(target)) return;
      setOwnOpen(false);
      onOpenChange?.(false);
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [open, onOpenChange]);
  // Stays within the window: shifted left when it would leave at the right.
  // Measured from the anchor and the panel's layout width, which the opening
  // animation (a scale) does not disturb.
  useLayoutEffect(() => {
    if (!open) {
      setShift(0);
      return;
    }
    const place = () => {
      const el = panel.current,
        anchor = wrap.current;
      if (!el || !anchor) return;
      const left = anchor.getBoundingClientRect().left;
      const width = el.offsetWidth;
      // Within the window and clear of the notch in landscape.
      const safe = safeInsets();
      const room = window.innerWidth - 8 - safe.right;
      let next = Math.min(0, room - (left + width));
      if (left + next < 8 + safe.left) next = 8 + safe.left - left;
      setShift((current) => (Math.abs(current - next) > 1 ? next : current));
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);
  return (
    <div ref={wrap} className={`chip-popover-anchor ${className}`}>
      <button
        ref={chip}
        type="button"
        className={`toolbar-chip${active ? " active" : ""}${open ? " open" : ""}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? id : undefined}
        aria-label={name && name !== label ? name : undefined}
        onClick={() => setOpen(!open)}
      >
        {icon}
        <span className="toolbar-chip-text">{label}</span>
        <CaretDown size={11} className="toolbar-chip-caret" aria-hidden="true" />
      </button>
      {open && (
        <div
          ref={panel}
          id={id}
          role="dialog"
          aria-label={panelLabel}
          tabIndex={-1}
          className={`chip-popover ${panelClassName}`}
          style={shift ? { left: shift } : undefined}
          onKeyDown={(e) => {
            // A select that only closed its own list keeps the panel open.
            if (e.key !== "Escape" || e.defaultPrevented) return;
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
            chip.current?.focus();
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}
