"use client";
// The sidebar's right edge on wide screens: drag it to make the sidebar
// wider or narrower, arrow keys move it in steps, a double click (or Home)
// goes back to the default. The width lands in --sidebar-width on the app
// shell (components/workspace-app.tsx, kept per device).
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
}: {
  width: number | null;
  onWidth: (width: number | null) => void;
  label: string;
  hint: string;
}) {
  const handle = useRef<HTMLDivElement>(null);
  // The width the sidebar has right now (the default when none is set).
  const current = () =>
    width ??
    handle.current?.parentElement?.getBoundingClientRect().width ??
    246;
  return (
    <div
      ref={handle}
      className="sidebar-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={SIDEBAR_MIN}
      aria-valuemax={SIDEBAR_MAX}
      aria-valuenow={Math.round(current())}
      title={hint}
      tabIndex={0}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const left =
          e.currentTarget.parentElement!.getBoundingClientRect().left;
        e.currentTarget.setPointerCapture(e.pointerId);
        document.documentElement.classList.add("sidebar-resizing");
        const move = (ev: PointerEvent) =>
          onWidth(clampSidebar(ev.clientX - left));
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
        if (e.key === "ArrowLeft") onWidth(clampSidebar(current() - step));
        else if (e.key === "ArrowRight")
          onWidth(clampSidebar(current() + step));
        else if (e.key === "Home") onWidth(null);
        else return;
        e.preventDefault();
      }}
    />
  );
}
