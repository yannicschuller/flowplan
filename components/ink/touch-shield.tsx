"use client";
// The touch shield of a drawing block being edited (#311): on a tablet the
// hand rests beside the block while the pen draws, and those touches must
// not scroll the document, press buttons, move the caret or open menus.
// Four panels cover the window around the block – its toolbar and open
// menus included – and swallow every finger, palm and pen there. The
// block's own Done button and Escape end drawing; while that button is out
// of sight (scrolled away), a small "Done" pill at the top of the window (at
// the bottom when the block is up there) does. A mouse click on the shield
// ends drawing too, as a click outside does without it. The shield lies in
// <body>, outside the document's text: nothing on it is editable.
// Placed through CSS variables on the shield (as the outline popover does);
// modals stay above it.
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Check } from "@phosphor-icons/react";
import { useT } from "../i18n";
import { penTapsWithoutScribble } from "./pen-hover";

// Room around the block for its focus ring.
const RING = 6;
// Height the pill needs at the top or bottom of the window.
const PILL_ROOM = 64;
// Floating parts of the block that may stick out of it.
const PARTS = ".ink-toolbar, .ink-menu, .ink-ui";
// A touch this wide (CSS pixels) is a palm, not a fingertip.
const PALM = 40;
// A press this long (ms) on the pill is a resting hand, not a tap.
const LONG_PRESS = 700;

// The hint comes with the first shield of the session only.
let hinted = false;

export function InkTouchShield({ block: blockRef, onDone }: { block: RefObject<HTMLElement | null>; onDone: () => void }) {
  const t = useT();
  const shield = useRef<HTMLDivElement>(null);
  const [hint] = useState(() => !hinted);
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    hinted = true;
    setMounted(true);
  }, []);
  const press = useRef<{ at: number; palm: boolean } | null>(null);
  const done = useRef(onDone);
  done.current = onDone;

  // The hole follows the block: scrolling inside it, its height, the
  // toolbar wrapping, menus opening, the window turning.
  useLayoutEffect(() => {
    const root = shield.current,
      block = blockRef.current;
    if (!mounted || !root || !block) return;
    let frame = 0;
    const set = () => {
      const box = { top: Infinity, left: Infinity, right: -Infinity, bottom: -Infinity };
      for (const el of [block, ...block.querySelectorAll<HTMLElement>(PARTS)]) {
        const r = el.getBoundingClientRect();
        if (!r.width && !r.height) continue;
        box.top = Math.min(box.top, r.top);
        box.left = Math.min(box.left, r.left);
        box.right = Math.max(box.right, r.right);
        box.bottom = Math.max(box.bottom, r.bottom);
      }
      if (box.top === Infinity) return;
      const vw = document.documentElement.clientWidth,
        vh = window.innerHeight;
      const clamp = (v: number, max: number) => Math.round(Math.max(0, Math.min(max, v)));
      const top = clamp(box.top - RING, vh),
        bottom = clamp(box.bottom + RING, vh);
      root.style.setProperty("--hole-top", `${top}px`);
      root.style.setProperty("--hole-bottom", `${Math.max(top, bottom)}px`);
      root.style.setProperty("--hole-left", `${clamp(box.left - RING, vw)}px`);
      root.style.setProperty("--hole-right", `${clamp(box.right + RING, vw)}px`);
      // The pill goes where the shield has room for it; without room (a
      // block over the whole window) it sits over the block's top.
      const roomTop = top >= PILL_ROOM,
        roomBottom = vh - bottom >= PILL_ROOM;
      root.classList.toggle("is-pill-bottom", !roomTop && roomBottom);
    };
    const place = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(set);
    };
    set();
    const resize = new ResizeObserver(place);
    resize.observe(block);
    const changes = new MutationObserver(place);
    changes.observe(block, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style"] });
    document.addEventListener("scroll", place, { capture: true, passive: true });
    window.addEventListener("resize", place);
    window.visualViewport?.addEventListener("resize", place);
    window.visualViewport?.addEventListener("scroll", place);
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      changes.disconnect();
      document.removeEventListener("scroll", place, { capture: true });
      window.removeEventListener("resize", place);
      window.visualViewport?.removeEventListener("resize", place);
      window.visualViewport?.removeEventListener("scroll", place);
    };
  }, [mounted, blockRef]);

  // The pill's Done is the way out while the block's own Done is out of
  // sight (scrolled away, under the top bar); with that one on screen there
  // is only one Done. Escape works either way.
  useEffect(() => {
    const root = shield.current,
      button = blockRef.current?.querySelector(".ink-done");
    if (!mounted || !root) return;
    root.classList.toggle("is-done-hidden", !!button);
    if (!button || typeof IntersectionObserver !== "function") return;
    // What the top bar covers does not count as seen.
    const bar = document.querySelector(".topbar")?.getBoundingClientRect();
    const covered = bar && bar.top <= 0 ? Math.max(0, Math.round(bar.bottom)) : 0;
    const seen = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        root.classList.toggle("is-done-hidden", entry.isIntersecting && entry.intersectionRatio >= 0.9);
      },
      { threshold: [0, 0.9, 1], rootMargin: `-${covered}px 0px 0px 0px` },
    );
    seen.observe(button);
    return () => seen.disconnect();
  }, [mounted, blockRef]);

  // Swallowing: touches never start a scroll, a click, a focus change or
  // the long-press callout (touchstart cancelled, so not passive – which
  // React's own touch handlers are). Pens and fingers stay put; a mouse
  // ends drawing.
  useEffect(() => {
    const root = shield.current;
    if (!mounted || !root) return;
    const panels = [...root.querySelectorAll<HTMLElement>(".ink-shield-panel")];
    const cancel = (event: Event) => {
      if (event.cancelable) event.preventDefault();
      event.stopPropagation();
    };
    const pointer = (event: PointerEvent) => {
      cancel(event);
      if (event.pointerType === "mouse" && event.button === 0) done.current();
    };
    const types = ["touchstart", "touchmove", "touchend", "mousedown", "click", "dblclick", "contextmenu", "wheel", "gesturestart", "dragstart"];
    for (const panel of panels) {
      panel.addEventListener("pointerdown", pointer);
      for (const type of types) panel.addEventListener(type, cancel, { passive: false });
    }
    // A pen tap on the pill's Done feeds no Scribble either (#315).
    const pill = root.querySelector<HTMLElement>(".ink-shield-pill");
    const stopPen = pill ? penTapsWithoutScribble(pill) : null;
    return () => {
      stopPen?.();
      for (const panel of panels) {
        panel.removeEventListener("pointerdown", pointer);
        for (const type of types) panel.removeEventListener(type, cancel);
      }
    };
  }, [mounted]);

  if (!mounted) return null;
  return createPortal(
    <div ref={shield} className="ink-shield" aria-hidden="true" data-ink-shield="">
      <div className="ink-shield-panel is-top" />
      <div className="ink-shield-panel is-left" />
      <div className="ink-shield-panel is-right" />
      <div className="ink-shield-panel is-bottom" />
      <div className="ink-shield-pill">
        {hint && <span className="ink-shield-hint">{t("Berührungen außerhalb der Zeichnung werden ignoriert", "Touches outside the drawing are ignored")}</span>}
        <button
          type="button"
          className="ink-shield-done"
          tabIndex={-1}
          onPointerDown={(e) => {
            press.current = { at: e.timeStamp, palm: e.pointerType === "touch" && Math.max(e.width, e.height) > PALM };
          }}
          onClick={(e) => {
            // A deliberate tap, not a resting or brushing palm.
            const p = press.current;
            press.current = null;
            if (p && (p.palm || e.timeStamp - p.at > LONG_PRESS)) return;
            done.current();
          }}
        >
          <Check size={16} />
          <span>{t("Fertig", "Done")}</span>
        </button>
      </div>
    </div>,
    document.body,
  );
}
