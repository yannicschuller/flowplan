// The app's layout on this device – the sidebar's dragged width, the "KI
// fragen" panel's width, whether that panel is pinned and whether the
// person hid the sidebar (#331) – also in a cookie, so the server renders
// the page with them and the first paint already has the right widths and
// the sidebar hidden or shown (no jump or flash after hydration). Only these
// four numbers; localStorage keeps them as before and fills the cookie on
// the first load after the update. localStorage is the device's record: a
// page rendered with an older cookie (offline, the stored copy of "/") takes
// the device's layout once the app runs (#641).
// Runs in the browser and on the server.
import { ASK_MIN, readAskPinned, readAskWidth } from "./ask-panel";

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
  /** The person hid the sidebar on a wide screen (toggle button, shortcut,
   *  command palette) – not the app's own temporary collapses. */
  collapsed: boolean;
};

// "<sidebar>.<ask>.<pinned>.<collapsed>", 0 for a default width:
// "280.0.1.0". Cookies from before #331 have no fourth field: shown.
const format = /^(\d{1,4})\.(\d{1,4})\.([01])(?:\.([01]))?$/;

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
    collapsed: match[4] === "1",
  };
}

/** For document.cookie: a year, the whole app, first-party only. */
export function layoutCookie(layout: StoredLayout): string {
  return `${LAYOUT_COOKIE}=${layoutValue(layout)}; path=/; max-age=31536000; samesite=lax`;
}
// "<sidebar>.<ask>.<pinned>.<collapsed>", the cookie's value.
function layoutValue(layout: StoredLayout): string {
  const width = (v: number | null) => (v && v > 0 ? Math.min(9999, Math.round(v)) : 0);
  return `${width(layout.sidebar)}.${width(layout.ask)}.${layout.askPinned ? 1 : 0}.${layout.collapsed ? 1 : 0}`;
}

// The hidden sidebar in localStorage too, like the widths: the cookie is
// filled from it on the first load without one.
export const SIDEBAR_COLLAPSED_KEY = "flowplan-sidebar-collapsed";
type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const storage = (): Store | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};
export function readSidebarCollapsed(store: Store | null = storage()): boolean {
  try {
    return store?.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}
export function writeSidebarCollapsed(collapsed: boolean, store: Store | null = storage()) {
  try {
    if (collapsed) store?.setItem(SIDEBAR_COLLAPSED_KEY, "1");
    else store?.removeItem(SIDEBAR_COLLAPSED_KEY);
  } catch {}
}

// The whole layout in localStorage as well, in the cookie's format (#641):
// the device's own record of it, written with every change. The cookie only
// mirrors it for the server, and a page can be rendered with an older
// cookie (the offline copy of "/", below) – or WebKit may not have kept the
// latest cookie when the app was closed.
export const LAYOUT_KEY = "flowplan-layout";
export function writeStoredLayout(layout: StoredLayout, store: Store | null = storage()) {
  try {
    store?.setItem(LAYOUT_KEY, layoutValue(layout));
  } catch {}
}

/** The layout as this device keeps it right now: from localStorage, else
 *  the browser's cookie (`document.cookie`; storage blocked or cleared),
 *  else the single values localStorage had before #641. */
export function deviceLayout(cookies: string, store: Store | null = storage()): StoredLayout {
  try {
    const stored = parseLayout(store?.getItem(LAYOUT_KEY));
    if (stored) return stored;
  } catch {}
  const own = cookies
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${LAYOUT_COOKIE}=`));
  const fromCookie = parseLayout(own?.slice(LAYOUT_COOKIE.length + 1));
  if (fromCookie) return fromCookie;
  let sidebar: number | null = null;
  try {
    const stored = Number(store?.getItem(SIDEBAR_WIDTH_KEY));
    if (stored) sidebar = clampSidebar(stored);
  } catch {}
  return { sidebar, ask: readAskWidth(store), askPinned: readAskPinned(store), collapsed: readSidebarCollapsed(store) };
}

/** What the app switches to once it runs (#641): the device's layout when
 *  it differs from the one the page was rendered with, null when they agree
 *  – the usual case, so nothing changes after hydration (no flash). The page
 *  can be older than the device's choice: offline, the service worker
 *  serves the copy of "/" it stored before the sidebar was hidden, and that
 *  copy must not win over (and then overwrite) the choice. */
export function layoutUpdate(rendered: StoredLayout | null | undefined, device: StoredLayout): StoredLayout | null {
  if (
    rendered &&
    rendered.sidebar === device.sidebar &&
    rendered.ask === device.ask &&
    rendered.askPinned === device.askPinned &&
    rendered.collapsed === device.collapsed
  )
    return null;
  return device;
}
