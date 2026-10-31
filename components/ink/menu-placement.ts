"use client";
// Places a small menu of the ink and notebook toolbars (.ink-menu) under the
// button it belongs to – its parent element, the menu anchor – and keeps it
// inside the window and out of the safe areas. The toolbars wrap: the same
// button sits at the right end of one row or at the left of the next one
// depending on the width (sidebar shown or hidden, sheet overview open or
// closed, portrait or landscape), so the place is measured, not assumed.
import { useCallback } from "react";
import { safeInsets } from "../safe-area";

const GAP = 6;
const EDGE = 8;

export function placeMenu(menu: HTMLElement, align: "start" | "end" = "end") {
  const anchor = menu.parentElement;
  if (!anchor) return;
  const at = anchor.getBoundingClientRect();
  const safe = safeInsets();
  const vw = window.innerWidth,
    vh = window.innerHeight;
  menu.style.transform = "none";
  menu.style.margin = "0";
  menu.style.maxHeight = "";
  // Layout sizes: the opening animation (a scale) does not change them.
  const width = menu.offsetWidth;
  let height = menu.offsetHeight;
  const minLeft = safe.left + EDGE,
    maxLeft = vw - safe.right - EDGE - width;
  const wanted = align === "end" ? at.right - width : at.left;
  const left = Math.max(minLeft, Math.min(wanted, maxLeft));
  // Below the button; above it when there is more room there.
  const below = vh - safe.bottom - EDGE - (at.bottom + GAP),
    above = at.top - GAP - (safe.top + EDGE);
  let top: number;
  if (height <= below || below >= above) {
    top = at.bottom + GAP;
    if (height > below) height = Math.max(120, below);
  } else {
    if (height > above) height = above;
    top = at.top - GAP - height;
  }
  if (height < menu.offsetHeight) {
    menu.style.maxHeight = `${height}px`;
    menu.style.overflowY = "auto";
  }
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  // A transformed ancestor makes itself the frame of a fixed element: correct
  // by what actually landed where.
  const got = menu.getBoundingClientRect();
  const scale = menu.offsetWidth ? got.width / menu.offsetWidth : 1;
  const dx = got.left - left,
    dy = got.top - top;
  if (Math.abs(dx) > 0.5 && scale > 0.99) menu.style.left = `${left - dx}px`;
  if (Math.abs(dy) > 0.5 && scale > 0.99) menu.style.top = `${top - dy}px`;
}

// A ref callback for the menu element: placed when it opens and again when
// the window changes size or something around it scrolls.
export function useMenuPlacement(align: "start" | "end" = "end") {
  return useCallback(
    (menu: HTMLElement | null) => {
      if (!menu) return;
      let frame = 0;
      const place = (event?: Event) => {
        if (event?.target instanceof Node && menu.contains(event.target)) return;
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => placeMenu(menu, align));
      };
      placeMenu(menu, align);
      window.addEventListener("resize", place);
      window.addEventListener("scroll", place, true);
      return () => {
        cancelAnimationFrame(frame);
        window.removeEventListener("resize", place);
        window.removeEventListener("scroll", place, true);
      };
    },
    [align],
  );
}
