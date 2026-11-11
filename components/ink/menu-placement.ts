"use client";
// Places a small menu of the ink and notebook toolbars (.ink-menu) under the
// button it belongs to – its parent element, the menu anchor – and keeps it
// inside the window and out of the safe areas. The toolbars wrap: the same
// button sits at the right end of one row or at the left of the next one
// depending on the width (sidebar shown or hidden, sheet overview open or
// closed, portrait or landscape), so the place is measured, not assumed.
import { createContext, useCallback, useContext } from "react";
import { safeInsets } from "../safe-area";

const GAP = 6;
const EDGE = 8;

export type AvoidRect = { left: number; top: number; right: number; bottom: number };
// What a menu should leave visible, in window coordinates – the text box a
// text style bar works on, the lasso's selection. Given by the bar around
// the menus (FloatingTextBar, InkSelectionBar).
export const MenuAvoid = createContext<(() => AvoidRect | null) | null>(null);

// How much of `b` the rectangle `a` covers, in square pixels.
function overlap(a: AvoidRect, b: AvoidRect) {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return w > 0 && h > 0 ? w * h : 0;
}

export function placeMenu(menu: HTMLElement, align: "start" | "end" = "end", avoid?: AvoidRect | null) {
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
  // Below the button; above it when there is more room there – or when
  // below would cover what the menu is about (the text being styled) and
  // above would cover less of it.
  const below = vh - safe.bottom - EDGE - (at.bottom + GAP),
    above = at.top - GAP - (safe.top + EDGE);
  let goBelow = height <= below || below >= above;
  if (avoid) {
    const box = (top: number, h: number) => ({ left, right: left + width, top, bottom: top + h });
    const hBelow = Math.min(height, Math.max(120, below)),
      hAbove = Math.min(height, above);
    const coverBelow = overlap(box(at.bottom + GAP, hBelow), avoid),
      coverAbove = hAbove >= Math.min(height, 120) ? overlap(box(at.top - GAP - hAbove, hAbove), avoid) : Infinity;
    if (coverBelow > 0 && coverAbove < coverBelow) goBelow = false;
    else if (coverAbove > 0 && coverBelow < coverAbove) goBelow = true;
  }
  let top: number;
  if (goBelow) {
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
  const avoid = useContext(MenuAvoid);
  return useCallback(
    (menu: HTMLElement | null) => {
      if (!menu) return;
      let frame = 0;
      const place = (event?: Event) => {
        if (event?.target instanceof Node && menu.contains(event.target)) return;
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => placeMenu(menu, align, avoid?.()));
      };
      placeMenu(menu, align, avoid?.());
      window.addEventListener("resize", place);
      window.addEventListener("scroll", place, true);
      return () => {
        cancelAnimationFrame(frame);
        window.removeEventListener("resize", place);
        window.removeEventListener("scroll", place, true);
      };
    },
    [align, avoid],
  );
}
