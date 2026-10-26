// "Back" for the apps (flowplan-app): the swipe from the left edge on iOS and
// the back button / gesture on Android. The workspace is one page with hash
// routes, so the web view's history is not what a person means by back: it
// holds every replaced filter, sign-in redirects and nothing of open dialogs.
// The app asks `window.FlowplanNavigation.back()` instead, which goes one
// step back the way the interface is built:
//
//   1. an open dialog, sheet or menu closes (the topmost one);
//   2. a part of a page closes: a comment thread, then an open record;
//   3. a section of the settings or the administration goes to its landing
//      page;
//   4. a page or a screen goes to the one opened before it (the app's own
//      list, not the browser history), and finally to the start page.
//
// back() is false on the start page with nothing open: the app may then
// leave (Android). The page tells the app whether there is a step back
// (`FlowplanApp.backState`), so the iOS gesture is only there when it does
// something. backProgress() previews the step while Android's predictive
// back gesture is under way (lib/back-preview.ts). Sheets dragged down to
// close (components/sheet-drag.ts) close through the dialog's own close, as
// Escape does, so what back reports follows them.
import { parsePageLocation, pageLocationHash } from "./page-location";
import { parseSettingsHash, settingsHash } from "./settings-sections";
import { createBackPreview, type BackEdge, type BackPhase, type BackTarget } from "./back-preview";

const TOP_SCREENS = ["home", "inbox", "tasks", "graph", "trash", "media", "settings", "admin"];
const MAX_STACK = 50;

// The place a fragment stands for in the list of places visited: a page
// (records and threads belong to it), the settings, the administration or a
// screen. null for what is no place (quick actions such as #search).
export function locationKey(fragment: string): string | null {
  const hash = fragment.replace(/^#/, "");
  if (!hash) return "home";
  if (hash.startsWith("page=")) {
    const target = parsePageLocation(hash);
    return target ? `page=${target.pageId}` : null;
  }
  const settings = parseSettingsHash(hash);
  if (settings) return settings.area;
  return TOP_SCREENS.includes(hash) ? hash : null;
}

// Remembers a place; the same place twice in a row counts once.
export function remember(stack: string[], fragment: string) {
  const key = locationKey(fragment);
  if (!key || stack[stack.length - 1] === key) return;
  stack.push(key);
  if (stack.length > MAX_STACK) stack.splice(0, stack.length - MAX_STACK);
}

export type BackStep = { hash: string; pop: boolean } | null;

// Where back goes from a fragment (without "#"), given the places visited
// (the current one last). pop: the current place leaves the list.
export function parentLocation(fragment: string, stack: readonly string[]): BackStep {
  const hash = fragment.replace(/^#/, "");
  if (hash.startsWith("page=")) {
    const target = parsePageLocation(hash);
    if (target?.threadId) return { hash: pageLocationHash({ pageId: target.pageId, rowId: target.rowId }).slice(1), pop: false };
    if (target?.rowId) return { hash: pageLocationHash({ pageId: target.pageId }).slice(1), pop: false };
  }
  const settings = parseSettingsHash(hash);
  if (settings?.section) return { hash: settingsHash({ area: settings.area }).slice(1), pop: false };
  const key = locationKey(hash);
  if (key === "home") return null;
  // The place before this one.
  let i = stack.length - 1;
  while (i >= 0 && stack[i] === key) i--;
  const previous = i >= 0 ? stack[i] : null;
  if (previous && previous !== key) return { hash: previous, pop: true };
  return { hash: "home", pop: true };
}

// ---------------------------------------------------------------------------
// In the page.

// Open layers that close with Escape: Radix dialogs and menus (components/
// ui.tsx Modal, dropdown menus) and other modal dialogs. The topmost one is
// the last in the document (portals go to the end of <body>).
const LAYERS = '[role="dialog"][data-state="open"], [role="menu"][data-state="open"], [role="alertdialog"][data-state="open"], [aria-modal="true"]';
function topLayer(): HTMLElement | null {
  const all = document.querySelectorAll<HTMLElement>(LAYERS);
  for (let i = all.length - 1; i >= 0; i--) {
    const el = all[i];
    if (el.isConnected && !el.closest("[hidden], [inert]")) return el;
  }
  return null;
}
const isOpen = (el: HTMLElement) => el.isConnected && el.getAttribute("data-state") !== "closed";

// Parts of the interface that close on back but are no dialog (the
// navigation drawer on phones): registered while open, the last one first.
const closers: (() => void)[] = [];
let changed: () => void = () => {};

export function addBackCloser(close: () => void) {
  closers.push(close);
  changed();
  return () => {
    const i = closers.lastIndexOf(close);
    if (i >= 0) closers.splice(i, 1);
    changed();
  };
}

// What back would close, for the preview of Android's predictive back
// (lib/back-preview.ts): the drawer, the top sheet or dialog, else the page.
function backTarget(stack: readonly string[]): BackTarget {
  if (closers.length) {
    const drawer = document.querySelector<HTMLElement>(".nav-open .sidebar");
    return drawer ? { kind: "drawer", el: drawer } : null;
  }
  const layer = topLayer();
  if (layer) {
    // A sheet (components/sheet-drag.ts) while it stands on the bottom edge.
    const sheet = layer.hasAttribute("data-sheet-drag") && Math.abs(layer.getBoundingClientRect().bottom - innerHeight) < 2;
    return { kind: sheet ? "sheet" : "dialog", el: layer };
  }
  if (!parentLocation(location.hash, stack)) return null;
  const page = document.querySelector<HTMLElement>(".main");
  return page ? { kind: "page", el: page } : null;
}

type Navigation = {
  back: () => boolean;
  canGoBack: () => boolean;
  // The back gesture's progress (Android 14+): "start", "progress" (0–1),
  // then "commit" (back() follows) or "cancel". True when something shows it.
  backProgress: (phase: BackPhase, progress?: number, edge?: BackEdge) => boolean;
};
type BackApp = { backState?: (canGoBack: boolean) => void };

// Installs window.FlowplanNavigation (once per page); returns the uninstall.
export function installAppBack(): () => void {
  if (typeof window === "undefined") return () => {};
  const stack: string[] = [];
  remember(stack, location.hash);
  const routeBack = () => {
    const step = parentLocation(location.hash, stack);
    if (!step) return false;
    if (step.pop) {
      const key = locationKey(location.hash);
      while (stack.length && stack[stack.length - 1] === key) stack.pop();
    }
    // In place: the web view's history does not grow with every step back.
    location.replace(`#${step.hash}`);
    return true;
  };
  const back = () => {
    const close = closers[closers.length - 1];
    if (close) {
      close();
      return true;
    }
    const layer = topLayer();
    if (layer) {
      layer.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true, cancelable: true }));
      // A layer that does not close on Escape is left by its route instead.
      setTimeout(() => {
        if (isOpen(layer) && topLayer() === layer) routeBack();
      }, 150);
      return true;
    }
    return routeBack();
  };
  const canGoBack = () => closers.length > 0 || !!topLayer() || parentLocation(location.hash, stack) !== null;
  // Tells the app (once per change) whether back would do something.
  let last: boolean | null = null,
    frame = 0;
  const report = () => {
    frame = 0;
    const app = (window as unknown as { FlowplanApp?: BackApp }).FlowplanApp;
    if (!app?.backState) return;
    const value = canGoBack();
    if (value === last) return;
    last = value;
    try {
      app.backState(value);
    } catch {}
  };
  changed = () => {
    if (!frame) frame = requestAnimationFrame(report);
  };
  const onHash = () => {
    remember(stack, location.hash);
    changed();
  };
  window.addEventListener("hashchange", onHash);
  // Dialogs and menus come and go as children of <body> (portals) and
  // change their data-state.
  // (Two observers: the whole tree only for those attributes, not for every
  // change of the editor.)
  const portals = new MutationObserver(changed),
    states = new MutationObserver(changed);
  portals.observe(document.body, { childList: true });
  states.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["data-state", "aria-modal"] });
  const preview = createBackPreview(() => backTarget(stack));
  const backProgress = (phase: BackPhase, progress?: number, edge?: BackEdge) => {
    try {
      return preview(phase, Number(progress) || 0, edge === "right" ? "right" : "left");
    } catch {
      return false;
    }
  };
  const navigation: Navigation = { back, canGoBack, backProgress };
  (window as unknown as { FlowplanNavigation?: Navigation }).FlowplanNavigation = navigation;
  changed();
  return () => {
    window.removeEventListener("hashchange", onHash);
    portals.disconnect();
    states.disconnect();
    if (frame) cancelAnimationFrame(frame);
    changed = () => {};
    const w = window as unknown as { FlowplanNavigation?: Navigation };
    if (w.FlowplanNavigation === navigation) delete w.FlowplanNavigation;
  };
}
