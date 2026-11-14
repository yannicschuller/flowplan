// How a click opens a place of the app (#279): a plain click goes there in
// the frame it came from ("here"), ⌘/Ctrl-click and the middle button open
// a new tab ("tab"), ⌘/Ctrl+Shift-click the other frame ("side") – as in
// code editors. Links, the page tree and the search ask with requestOpen();
// components/frame-tabs.tsx answers while tabs are on (not on phones).
import { stepOf } from "./history-nav";

export type OpenMode = "here" | "tab" | "side";
export const OPEN_PLACE_EVENT = "flowplan:open-place";
export type OpenRequest = { place: string; mode: OpenMode; origin: Element | null };

type ClickLike = { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; button?: number };
export function openModeOf(e: ClickLike): OpenMode {
  if (e.button === 1) return e.shiftKey ? "side" : "tab";
  if (e.metaKey || e.ctrlKey) return e.shiftKey ? "side" : "tab";
  return "here";
}

// True when the tabs took the request; false where there are none – the
// caller then does what it did before.
export function requestOpen(hash: string, mode: OpenMode, origin: Element | null = null): boolean {
  if (typeof window === "undefined") return false;
  const place = stepOf(hash);
  if (!place) return false;
  return !window.dispatchEvent(new CustomEvent<OpenRequest>(OPEN_PLACE_EVENT, { detail: { place, mode, origin }, cancelable: true }));
}
