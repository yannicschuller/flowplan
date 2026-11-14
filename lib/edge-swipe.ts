// The swipe from the left edge on touch screens (#285): who owns the edge,
// and the width of the sidebar while it lies over the page.
//
// The swipe pulls the sidebar in over the page (components/drawer-swipe.ts)
// – on phones, and on tablets whose sidebar is collapsed. On iOS the very
// edge may belong to "back" instead:
//
//   - Safari (not the installed web app): always – its own back swipe, which
//     no page can turn off. The swipe that opens starts a little further in.
//   - the app (flowplan-app): the person chooses on this device
//     ("Wischen vom linken Rand", lib/edge-swipe-pref.ts). "Seitenleiste
//     öffnen" (the default) – the app turns its back swipe off and the very
//     edge opens the sidebar; "Zurück" – as before: the app's back swipe
//     while the page has a step back. An app from before the choice
//     (no FlowplanApp.edgeSwipe) keeps its back swipe, so the page keeps
//     clear of the edge as before.
//   - the installed web app and Android: nothing claims the edge in the page
//     (Android's back gesture is the system's, before the page sees a touch).
//
// Back stays available through the arrows at the top left and the app's
// back button (Android).
//
// Pure – no DOM, no React; tests/edge-swipe.test.ts.

export type EdgeSwipePref = "drawer" | "back";
export const EDGE_SWIPE_PREFS: readonly EdgeSwipePref[] = ["drawer", "back"];
export const DEFAULT_EDGE_SWIPE: EdgeSwipePref = "drawer";

export function parseEdgeSwipePref(value: unknown): EdgeSwipePref {
  return value === "back" ? "back" : DEFAULT_EDGE_SWIPE;
}

// Where a swipe that opens may start, in px from the left edge, and the part
// of the edge left to iOS's back swipe (it begins within about 20 points).
export const OPEN_EDGE = 64;
export const BACK_EDGE = 24;

export type EdgeEnv = {
  ios: boolean;
  // In the app's web view (window.FlowplanApp).
  inApp: boolean;
  // The app takes the person's choice (FlowplanApp.edgeSwipe exists).
  appTakesChoice: boolean;
  pref: EdgeSwipePref;
  // What the page reports to the app (FlowplanNavigation.canGoBack); the
  // app's back swipe is only on while there is a step back.
  canGoBack: boolean;
  // The installed web app (display-mode: standalone).
  standalone: boolean;
};

// Whether the very edge goes back instead of opening the sidebar.
export function backOwnsEdge(env: EdgeEnv): boolean {
  if (!env.ios) return false;
  if (env.inApp) {
    if (env.appTakesChoice && env.pref === "drawer") return false;
    return env.canGoBack;
  }
  return !env.standalone;
}

// From where (px) a swipe to the right opens the sidebar.
export function openFrom(env: EdgeEnv): number {
  return backOwnsEdge(env) ? BACK_EDGE : 0;
}

// Whether the swipe may pull the sidebar in at all: the phone layout, or a
// wider window whose sidebar is collapsed. A docked, visible sidebar is
// already there – the swipe does nothing then.
export function drawerSwipeApplies(layout: { phone: boolean; collapsed: boolean }): boolean {
  return layout.phone || layout.collapsed;
}

// ---------------------------------------------------------------------------
// The sidebar over the page has a width of its own, wider than the docked
// one by default (nested trees are easier to read), dragged at its right
// edge and kept per device apart from the docked width (lib/layout-cookie.ts
// SIDEBAR_WIDTH_KEY). null: the stylesheet's default – min(360px, 85vw) on
// phones, 400px on tablets (app/globals.css). The page always stays visible
// beside it (the stylesheet keeps 48px free).
export const OVERLAY_WIDTH_KEY = "flowplan-sidebar-overlay-width";
export const OVERLAY_MIN = 240;
export const OVERLAY_MAX = 600;

export const clampOverlay = (value: number) => Math.round(Math.min(OVERLAY_MAX, Math.max(OVERLAY_MIN, value)));

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function readOverlayWidth(store: Store | null | undefined): number | null {
  try {
    const value = Number(store?.getItem(OVERLAY_WIDTH_KEY));
    return Number.isFinite(value) && value > 0 ? clampOverlay(value) : null;
  } catch {
    return null;
  }
}

export function writeOverlayWidth(store: Store | null | undefined, width: number | null) {
  try {
    if (width === null) store?.removeItem(OVERLAY_WIDTH_KEY);
    else store?.setItem(OVERLAY_WIDTH_KEY, String(clampOverlay(width)));
  } catch {}
}
