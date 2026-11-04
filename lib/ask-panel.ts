// The "KI fragen" panel's place on wide screens (components/ai-ask.tsx,
// components/workspace-app.tsx): its width, dragged at its left edge, and
// whether it docks beside the page or lies over it. Both are kept per
// device (localStorage); every read and write is guarded, so a browser
// without storage (private mode, blocked site data) gets the defaults.

// Width: 420 px unless dragged, never narrower than 320 px and never more
// than 45 % of the window (on windows below ~710 px the minimum wins).
export const ASK_WIDTH_KEY = "flowplan-ask-width";
export const ASK_DEFAULT = 420;
export const ASK_MIN = 320;
export const ASK_MAX_SHARE = 0.45;
export const askMax = (viewport: number) => Math.max(ASK_MIN, Math.round(viewport * ASK_MAX_SHARE));
// The width shown for a wanted one (null: the default) in a window this wide.
export const clampAsk = (value: number | null, viewport: number) =>
  Math.round(Math.min(askMax(viewport), Math.max(ASK_MIN, value ?? ASK_DEFAULT)));

// Below this window width the panel lies over the page (with a shadow, no
// backdrop) instead of squeezing it – unless it is pinned ("Anheften"),
// which docks it beside the page again. Phones (below 768 px) keep the
// bottom sheet. app/globals.css has the same widths.
export const ASK_PIN_KEY = "flowplan-ask-pinned";
export const ASK_OVERLAY_BELOW = 1100;
export const ASK_SHEET_BELOW = 768;
export const ASK_OVERLAY_MEDIA = `(min-width: ${ASK_SHEET_BELOW}px) and (max-width: ${ASK_OVERLAY_BELOW - 1}px)`;
export type AskMode = "sheet" | "overlay" | "docked";
export const askMode = (viewport: number, pinned: boolean): AskMode =>
  viewport < ASK_SHEET_BELOW ? "sheet" : viewport < ASK_OVERLAY_BELOW && !pinned ? "overlay" : "docked";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const storage = (): Store | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

// The dragged width, or null for the default (also for anything unreadable).
export function readAskWidth(store: Store | null = storage()): number | null {
  try {
    const stored = Number(store?.getItem(ASK_WIDTH_KEY));
    return Number.isFinite(stored) && stored > 0 ? Math.round(Math.max(ASK_MIN, stored)) : null;
  } catch {
    return null;
  }
}
export function writeAskWidth(width: number | null, store: Store | null = storage()) {
  try {
    if (width === null) store?.removeItem(ASK_WIDTH_KEY);
    else store?.setItem(ASK_WIDTH_KEY, String(Math.round(width)));
  } catch {}
}
export function readAskPinned(store: Store | null = storage()): boolean {
  try {
    return store?.getItem(ASK_PIN_KEY) === "1";
  } catch {
    return false;
  }
}
export function writeAskPinned(pinned: boolean, store: Store | null = storage()) {
  try {
    if (pinned) store?.setItem(ASK_PIN_KEY, "1");
    else store?.removeItem(ASK_PIN_KEY);
  } catch {}
}
