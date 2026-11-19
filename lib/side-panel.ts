// The docked side panel (#392, components/side-panel.tsx): a record of a
// database view or a PDF beside the page – the page (a timeline, a notebook,
// a document) narrows to the room left, nothing is covered. One panel at a
// time; it takes the app shell's right column, which "KI fragen" and the
// comments also use (lib/side-dock.ts coordinates them). This module is
// free of React and the DOM: widths, places and the record order.

export type SidePanelKind = "record" | "pdf";

// Width per kind, dragged at the panel's left edge and kept per device.
// Never narrower than the minimum, never more than 60 % of the window
// (on windows where that is less, the minimum wins).
export const SIDE_PANEL_WIDTH: Record<SidePanelKind, { key: string; fallback: number; min: number }> = {
  record: { key: "flowplan-side-panel-record", fallback: 520, min: 360 },
  pdf: { key: "flowplan-side-panel-pdf", fallback: 560, min: 360 },
};
export const SIDE_PANEL_MAX_SHARE = 0.6;
export const sidePanelMax = (kind: SidePanelKind, viewport: number) =>
  Math.max(SIDE_PANEL_WIDTH[kind].min, Math.round(viewport * SIDE_PANEL_MAX_SHARE));
// The width shown for a wanted one (null: the default) in a window this wide.
export function clampSidePanel(kind: SidePanelKind, value: number | null, viewport: number) {
  const { fallback, min } = SIDE_PANEL_WIDTH[kind];
  const wanted = value !== null && Number.isFinite(value) ? value : fallback;
  return Math.round(Math.min(sidePanelMax(kind, viewport), Math.max(min, wanted)));
}

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const storage = (): Store | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};
// The dragged width, or null for the default (also for anything unreadable).
export function readSidePanelWidth(kind: SidePanelKind, store: Store | null = storage()): number | null {
  try {
    const value = Number(store?.getItem(SIDE_PANEL_WIDTH[kind].key));
    return Number.isFinite(value) && value >= 200 && value <= 4000 ? Math.round(value) : null;
  } catch {
    return null;
  }
}
export function writeSidePanelWidth(kind: SidePanelKind, width: number | null, store: Store | null = storage()) {
  try {
    if (width === null) store?.removeItem(SIDE_PANEL_WIDTH[kind].key);
    else store?.setItem(SIDE_PANEL_WIDTH[kind].key, String(Math.round(width)));
  } catch {}
}

// Phones (below 768 px): a bottom sheet over the lower part of the page.
// From there the panel docks beside the page. app/globals.css has the
// same widths.
export const SIDE_SHEET_BELOW = 768;
export const SIDE_SHEET_MEDIA = `(max-width: ${SIDE_SHEET_BELOW - 1}px)`;
// A record docks only where the view keeps a useful width beside it; on
// narrower windows it opens as a page of its own (the issue: a full page,
// not the overlay). Published pages decide the same way, by width.
export const RECORD_DOCK_MIN = 1000;
export const RECORD_DOCK_MEDIA = `(min-width: ${RECORD_DOCK_MIN}px)`;

// Whether "Seitenleiste" docks beside the view: timelines do unless the
// view says "darüber", tables, boards and lists when the view says
// "daneben"; other views keep the panel over them.
export type SidePanelPlace = "beside" | "over";
export const DOCKABLE_VIEWS = ["timeline", "table", "board", "list"] as const;
export function recordDocks(viewType: string, place: SidePanelPlace | undefined) {
  if (!(DOCKABLE_VIEWS as readonly string[]).includes(viewType)) return false;
  return (place ?? (viewType === "timeline" ? "beside" : "over")) === "beside";
}

// ↑/↓ while the panel shows a record: the previous or next record in the
// view's order (`ids` as shown, duplicates – a record in two groups – once,
// at its first place). null at either end or for an unknown record.
export function neighbourRecord(ids: readonly string[], current: string, step: 1 | -1): string | null {
  const order = [...new Set(ids)];
  const at = order.indexOf(current);
  if (at < 0) return null;
  return order[at + step] ?? null;
}
