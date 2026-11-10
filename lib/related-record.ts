// A related record opened from a relation cell (#192): a plain click shows
// it on top of the current view (components/related-record.tsx), so closing
// it returns to the table it was opened from. Ctrl/⌘-, Shift-, Alt- and
// middle clicks keep the link's own behaviour (a new tab or window, or the
// record in its own database), as does a click some other handler took.
export type RelationClick = {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented?: boolean;
};
// An unmodified click with the main button that nothing else took.
export const plainClick = (event: RelationClick) =>
  !event.defaultPrevented &&
  event.button === 0 &&
  !event.metaKey &&
  !event.ctrlKey &&
  !event.shiftKey &&
  !event.altKey;
// "native": leave it to the link; "here": a record of the same database
// opens in its own dialog; "overlay": a record of another database opens
// on top of the view.
export function relationClick(
  event: RelationClick,
  targetPage: string,
  currentPage: string,
): "native" | "here" | "overlay" {
  if (!plainClick(event)) return "native";
  return targetPage === currentPage ? "here" : "overlay";
}

// The overlay is a step of the tab's history without an address of its own:
// an entry with the same address, marked in its state. Back leaves that
// entry (the overlay closes); closing the overlay goes back to the entry
// before, so the address and the history are as before opening it.
export const RELATED_STATE = "flowplanRelated";
type HistoryLike = Pick<History, "state" | "pushState" | "replaceState">;
export function pushRelatedEntry(history: HistoryLike, token: string, replace = false) {
  const state = { [RELATED_STATE]: token };
  if (replace) history.replaceState(state, "");
  else history.pushState(state, "");
}
export const onRelatedEntry = (history: Pick<History, "state">, token: string) =>
  !!token && (history.state as Record<string, unknown> | null)?.[RELATED_STATE] === token;
