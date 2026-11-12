"use client";
// A small panel anchored at a button of the meeting block (#229: attendees
// at "+", the calendar event at the calendar icon). It floats above the
// content instead of pushing it down, stays inside the window (above the
// button when there is no room below) and follows the button when the page
// scrolls. Escape closes it and returns the focus to the button; a click
// elsewhere closes it as well. On phones it is a bottom sheet.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Modal } from "./ui";
import { usePhone } from "./block-menu";
import { safeInsets } from "./safe-area";

export function AnchoredPopover({
  anchor,
  label,
  onClose,
  children,
  className = "",
}: {
  anchor: HTMLElement | null;
  label: string;
  onClose: (reason: "escape" | "away") => void;
  children: ReactNode;
  className?: string;
}) {
  const phone = usePhone();
  const panel = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useLayoutEffect(() => {
    if (phone) return;
    const position = () => {
      const el = panel.current;
      if (!el || !anchor?.isConnected) return;
      const box = anchor.getBoundingClientRect();
      const safe = safeInsets();
      const width = el.offsetWidth,
        height = el.offsetHeight;
      const left = Math.max(8 + safe.left, Math.min(box.left, window.innerWidth - width - 8 - safe.right));
      let top = box.bottom + 4;
      if (top + height > window.innerHeight - 8 - safe.bottom && box.top - height - 4 >= 8 + safe.top) top = box.top - height - 4;
      setPlace((current) => (current && Math.abs(current.left - left) < 1 && Math.abs(current.top - top) < 1 ? current : { left, top }));
    };
    position();
    // The content changes its height (a search narrows the list).
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(position);
    if (panel.current) observer?.observe(panel.current);
    window.addEventListener("scroll", position, true);
    window.addEventListener("resize", position);
    return () => {
      observer?.disconnect();
      window.removeEventListener("scroll", position, true);
      window.removeEventListener("resize", position);
    };
  }, [phone, anchor]);

  useEffect(() => {
    if (phone) return;
    const away = (e: Event) => {
      const target = e.target as Node;
      if (panel.current?.contains(target) || anchor?.contains(target)) return;
      close.current("away");
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [phone, anchor]);

  const escape = () => {
    close.current("escape");
    anchor?.focus({ preventScroll: true });
  };
  if (phone)
    return (
      <Modal open sheet title={label} className={`meeting-popover-sheet ${className}`} onClose={escape} onCloseAutoFocus={(e) => e.preventDefault()}>
        {children}
      </Modal>
    );
  return createPortal(
    <div
      ref={panel}
      role="dialog"
      aria-label={label}
      className={`dropdown meeting-popover ${className}`}
      style={{ position: "fixed", left: place?.left ?? -9999, top: place?.top ?? 0 }}
      onKeyDown={(e) => {
        if (e.key !== "Escape" || e.defaultPrevented) return;
        e.preventDefault();
        e.stopPropagation();
        escape();
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
