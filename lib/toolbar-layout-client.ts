import { useSyncExternalStore } from "react";
import { defaultToolbarLayout, sameToolbarLayout, toolbarLayoutOf, type ToolbarLayout } from "./toolbar-layout";

// "Formatierungsleiste anpassen" (#292, lib/toolbar-layout.ts) in the
// browser: the current layout, set from the bootstrap
// (components/workspace-app.tsx) and by the settings; the editor reads it.
const listeners = new Set<() => void>();
const fallback = defaultToolbarLayout();
let current: ToolbarLayout = fallback;
export function toolbarLayout(): ToolbarLayout {
  return current;
}
export function setToolbarLayoutLocal(value: unknown) {
  const next = toolbarLayoutOf(value);
  if (sameToolbarLayout(next, current)) return;
  current = next;
  listeners.forEach((listener) => listener());
}
// The settings save each change at once, one after the other, always the
// layout as it is by then. While one is on its way, a bootstrap loaded in
// between (after the previous save) is older than what is shown here and
// is ignored.
let pending = 0;
let queue: Promise<unknown> = Promise.resolve();
export function setToolbarLayoutFromServer(value: unknown) {
  if (!pending) setToolbarLayoutLocal(value);
}
export function saveToolbarLayout(save: (layout: ToolbarLayout) => Promise<unknown>): Promise<unknown> {
  pending++;
  const done = queue.then(() => save(current));
  queue = done.catch(() => undefined);
  return done.finally(() => {
    pending--;
  });
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function useToolbarLayout(): ToolbarLayout {
  return useSyncExternalStore(subscribe, toolbarLayout, () => fallback);
}
