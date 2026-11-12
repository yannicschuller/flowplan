// The app's layout on this device – the sidebar's dragged width, the "KI
// fragen" panel's width and whether that panel is pinned – also in a
// cookie, so the server renders the page with them and the first paint
// already has the right widths (no jump from the stylesheet's default after
// hydration). Only these three numbers; localStorage keeps them as before
// and fills the cookie on the first load after the update.
// Runs in the browser and on the server.
import { ASK_MIN } from "./ask-panel";

export const LAYOUT_COOKIE = "flowplan-layout";

// The sidebar's width bounds (components/sidebar-resize.tsx); here so the
// server can use them too.
export const SIDEBAR_WIDTH_KEY = "flowplan-sidebar-width";
export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 480;
export const clampSidebar = (value: number) =>
  Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, value)));

export type StoredLayout = {
  /** Dragged sidebar width in px, null: the stylesheet's default. */
  sidebar: number | null;
  /** Dragged "KI fragen" width in px, null: the default. */
  ask: number | null;
  askPinned: boolean;
};

// "<sidebar>.<ask>.<pinned>", 0 for a default width: "280.0.1".
const format = /^(\d{1,4})\.(\d{1,4})\.([01])$/;

/** The layout from the cookie, or null when there is none (or it is not
 *  one of ours). */
export function parseLayout(value: string | undefined | null): StoredLayout | null {
  const match = value ? format.exec(value) : null;
  if (!match) return null;
  const sidebar = Number(match[1]),
    ask = Number(match[2]);
  return {
    sidebar: sidebar ? clampSidebar(sidebar) : null,
    ask: ask ? Math.max(ASK_MIN, ask) : null,
    askPinned: match[3] === "1",
  };
}

/** For document.cookie: a year, the whole app, first-party only. */
export function layoutCookie(layout: StoredLayout): string {
  const width = (v: number | null) => (v && v > 0 ? Math.min(9999, Math.round(v)) : 0);
  return `${LAYOUT_COOKIE}=${width(layout.sidebar)}.${width(layout.ask)}.${layout.askPinned ? 1 : 0}; path=/; max-age=31536000; samesite=lax`;
}
