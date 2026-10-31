"use client";
// The sidebar's right edge on wide screens: drag it to make the sidebar
// wider or narrower, arrow keys move it in steps, a double click (or Home)
// goes back to the default. The width lands in --sidebar-width on the app
// shell (components/workspace-app.tsx, kept per device). The "KI fragen"
// panel on the right (components/ai-ask.tsx) uses the same handle on its
// left edge (`edge="start"`, --ask-width).
import { useRef } from "react";

export const SIDEBAR_WIDTH_KEY = "flowplan-sidebar-width";
export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 480;
export const clampSidebar = (value: number) =>
  Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, value)));

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
  // The width the panel has right now (the default when none is set).
  const current = () =>
    width ??
    handle.current?.parentElement?.getBoundingClientRect().width ??
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
        if (e.key === shrink) onWidth(clamp(current() - step));
        else if (e.key === grow) onWidth(clamp(current() + step));
        else if (e.key === "Home") onWidth(null);
        else return;
        e.preventDefault();
      }}
    />
  );
}
