import { useSyncExternalStore } from "react";
import { DEFAULT_MOTION, motionAttribute, motionPrefOf, type MotionPref } from "./motion-pref";

// "Animationen" (#260, lib/motion-pref.ts) in the browser: the current
// choice, set from the bootstrap (components/workspace-app.tsx) and by the
// settings. It is mirrored as data-motion on <html>, which the stylesheet
// (app/globals.css, "Motion") and lib/motion.ts read; the server renders
// the same attribute on the app's root, so the first paint has it too.
const listeners = new Set<() => void>();
let current: MotionPref = DEFAULT_MOTION;
let known = false;
export function motionPref(): MotionPref {
  return current;
}
function applyToDocument(value: MotionPref) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const attribute = motionAttribute(value);
  if (attribute) root.dataset.motion = attribute;
  else delete root.dataset.motion;
}
export function setMotionPrefLocal(value: unknown) {
  const next = motionPrefOf(value);
  const changed = next !== current || !known;
  known = true;
  current = next;
  applyToDocument(next);
  if (changed) listeners.forEach((listener) => listener());
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
/** The choice; `fallback` (the bootstrap's) until the browser's copy is
 *  set, so the server's render and hydration agree. */
export function useMotionPref(fallback: MotionPref = DEFAULT_MOTION): MotionPref {
  return useSyncExternalStore(
    subscribe,
    () => (known ? current : fallback),
    () => fallback,
  );
}
