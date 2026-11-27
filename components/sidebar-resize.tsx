"use client";
// The sidebar's right edge on wide screens: drag it to make the sidebar
// wider or narrower, arrow keys move it in steps, a double click (or Home)
// goes back to the default. The width lands in --sidebar-width on the app
// shell (components/workspace-app.tsx, kept per device). The "KI fragen"
// panel on the right (components/ai-ask.tsx) uses the same handle on its
// left edge (`edge="start"`, --ask-width).
import { useEffect, useRef, useState } from "react";

import { SIDEBAR_MIN, SIDEBAR_MAX } from "@/lib/layout-cookie";
export { SIDEBAR_WIDTH_KEY, SIDEBAR_MIN, SIDEBAR_MAX, clampSidebar } from "@/lib/layout-cookie";

export function SidebarResize({
  width,
  onWidth,
  label,
  hint,
  edge = "end",
  min = SIDEBAR_MIN,
  max = SIDEBAR_MAX,
  fallback = 246,
}: {
  width: number | null;
  onWidth: (width: number | null) => void;
  label: string;
  hint: string;
  // Where the handle sits on its panel: "end" (right edge, the panel grows
  // to the right) or "start" (left edge of a panel on the right).
  edge?: "start" | "end";
  min?: number;
  max?: number;
  fallback?: number;
}) {
  const handle = useRef<HTMLDivElement>(null);
  const clamp = (value: number) => Math.round(Math.min(max, Math.max(min, value)));
  // The panel's width as laid out, for aria-valuenow: from a ResizeObserver,
  // not read while rendering – that forced a layout of the whole page on
  // every render of the app shell, several times per page switch (#604).
  const [measured, setMeasured] = useState<number | null>(null);
  useEffect(() => {
    const panel = handle.current?.parentElement;
    if (width !== null || !panel || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const box = entry.borderBoxSize?.[0];
      setMeasured(Math.round(box ? box.inlineSize : entry.contentRect.width));
    });
    observer.observe(panel);
    return () => observer.disconnect();
  }, [width]);
  // The width the panel has right now (the default when none is set); a
  // key press reads it from the page.
  const current = (live = false) =>
    width ??
    (live ? handle.current?.parentElement?.getBoundingClientRect().width : measured) ??
    fallback;
  // Arrow keys move the edge the way they point.
  const grow = edge === "end" ? "ArrowRight" : "ArrowLeft";
  const shrink = edge === "end" ? "ArrowLeft" : "ArrowRight";
  return (
    <div
      ref={handle}
      className={`sidebar-resize${edge === "start" ? " sidebar-resize-start" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(current())}
      title={hint}
      tabIndex={0}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const box = e.currentTarget.parentElement!.getBoundingClientRect();
        e.currentTarget.setPointerCapture(e.pointerId);
        document.documentElement.classList.add("sidebar-resizing");
        const move = (ev: PointerEvent) =>
          onWidth(clamp(edge === "end" ? ev.clientX - box.left : box.right - ev.clientX));
        const up = (ev: PointerEvent) => {
          handle.current?.releasePointerCapture(ev.pointerId);
          document.documentElement.classList.remove("sidebar-resizing");
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
          window.removeEventListener("pointercancel", up);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
        window.addEventListener("pointercancel", up);
      }}
      onDoubleClick={() => onWidth(null)}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 48 : 16;
        if (e.key === shrink) onWidth(clamp(current(true) - step));
        else if (e.key === grow) onWidth(clamp(current(true) + step));
        else if (e.key === "Home") onWidth(null);
        else return;
        e.preventDefault();
      }}
    />
  );
}
