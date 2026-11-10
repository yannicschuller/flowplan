// The ink clipboard of this tab, shared by every ink editor on it: copy or
// cut on one notebook sheet or drawing block, paste on another. Items keep
// their page coordinates (and ids – a paste gives them new ones).
import type { InkItem } from "./model";

let items: InkItem[] | null = null;
const listeners = new Set<() => void>();

export const inkClipboard = () => items;
export function setInkClipboard(next: InkItem[] | null) {
  items = next?.length ? next : null;
  for (const listener of listeners) listener();
}
export function subscribeInkClipboard(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
