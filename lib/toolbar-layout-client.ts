import { useSyncExternalStore } from "react";
import { defaultToolbarLayout, sameToolbarLayout, toolbarLayoutOf, type ToolbarLayout } from "./toolbar-layout";

// "Formatierungsleiste anpassen" (#292, lib/toolbar-layout.ts) in the
// browser: the current layout, set from the bootstrap
// (components/workspace-app.tsx) and by the settings; the editor reads it.
// Along with it the default it falls back to – own layout → the instance's
// default → the built-in one – and whether the layout is the person's own.
type State = { layout: ToolbarLayout; standard: ToolbarLayout; custom: boolean };
const listeners = new Set<() => void>();
const fallback: State = { layout: defaultToolbarLayout(), standard: defaultToolbarLayout(), custom: false };
let current: State = fallback;
const emit = () => listeners.forEach((listener) => listener());
export function toolbarLayout(): ToolbarLayout {
  return current.layout;
}
export function toolbarLayoutState(): State {
  return current;
}
// A layout the person chose: their own unless it is the default (then it
// is stored as none, as on the server).
export function setToolbarLayoutLocal(value: unknown) {
  const next = toolbarLayoutOf(value, current.standard);
  const custom = !sameToolbarLayout(next, current.standard);
  if (sameToolbarLayout(next, current.layout) && custom === current.custom) return;
  current = { ...current, layout: next, custom };
  emit();
}
// The settings save each change at once, one after the other, always the
// layout as it is by then. While one is on its way, a bootstrap loaded in
// between (after the previous save) is older than what is shown here and
// is ignored.
let pending = 0;
let queue: Promise<unknown> = Promise.resolve();
export function setToolbarLayoutFromServer(value: unknown, standard?: unknown, custom?: boolean) {
  if (pending) return;
  const nextStandard = toolbarLayoutOf(standard);
  const layout = toolbarLayoutOf(value, nextStandard);
  const nextCustom = custom ?? !sameToolbarLayout(layout, nextStandard);
  if (sameToolbarLayout(layout, current.layout) && sameToolbarLayout(nextStandard, current.standard) && nextCustom === current.custom) return;
  current = { layout, standard: nextStandard, custom: nextCustom };
  emit();
}
export function saveToolbarLayout(save: (layout: ToolbarLayout) => Promise<unknown>): Promise<unknown> {
  pending++;
  const done = queue.then(() => save(current.layout));
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
  return useSyncExternalStore(subscribe, toolbarLayout, () => fallback.layout);
}
export function useToolbarLayoutState(): State {
  return useSyncExternalStore(subscribe, toolbarLayoutState, () => fallback);
}
