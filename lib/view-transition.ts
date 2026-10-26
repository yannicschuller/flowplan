// View transitions of the app shell (View Transitions API): opening a page,
// another screen, a record. The old view is captured, React draws the new
// one at once (flushSync) and the browser animates between them – the main
// pane fades and rises a little; a page title and icon from the page tree
// or a board card can fly to their place in the new view (shared elements,
// "morph"). Off when the browser cannot, when the system asks for reduced
// motion or the tab is hidden.
//
// Nothing waits for an animation: a tap or key during one ends it at once
// (the page below stays clickable, app/globals.css), and a change that
// comes while a transition is still running – or right after the last one,
// as when someone clicks through pages quickly – happens without one.
// A change still waiting for its old picture to be taken is applied first,
// so changes never overtake each other.
import { flushSync } from "react-dom";
import { prefersReducedMotion } from "./motion";

export type ViewKind = "page" | "record";
export type Morph = {
  /** The view-transition-name of the pair. */
  name: string;
  /** The element in the old view (named until the old view is captured). */
  from?: Element | null;
  /** Finds the element in the new view. */
  to?: () => Element | null | undefined;
  /** Called with the new element (e.g. to stop its own entry animation). */
  onTarget?: (element: HTMLElement) => void;
};

/** Changes closer together than this go without a transition. */
export const RAPID_MS = 350;

type Transition = { finished: Promise<void>; skipTransition: () => void };
type StartViewTransition = (update: () => void) => Transition;

const state = {
  active: null as Transition | null,
  pending: null as { run: () => void; done: boolean } | null,
  last: -Infinity,
  installed: false,
  off: 0,
};

function start(): StartViewTransition | null {
  if (typeof document === "undefined") return null;
  const doc = document as Document & { startViewTransition?: StartViewTransition };
  return typeof doc.startViewTransition === "function" ? doc.startViewTransition.bind(doc) : null;
}

/** Whether a transition would run now (support, motion settings, tab). */
export function viewTransitionsEnabled() {
  return !!start() && !prefersReducedMotion() && document.visibilityState === "visible";
}

/** Runs `fn` with changes applied at once (e.g. what the app shows when it
 *  starts: there is no view before it to come from). */
export function withoutViewTransition<T>(fn: () => T): T {
  state.off++;
  try {
    return fn();
  } finally {
    state.off--;
  }
}

/** Whether a transition is animating. */
export function viewTransitionRunning() {
  return !!state.active;
}

function install() {
  if (state.installed || typeof window === "undefined") return;
  state.installed = true;
  // A tap or a key ends a running transition: the new view is there at once.
  const skip = () => state.active?.skipTransition();
  window.addEventListener("pointerdown", skip, true);
  window.addEventListener("keydown", skip, true);
}

function settlePending() {
  const job = state.pending;
  if (!job || job.done) return;
  job.done = true;
  state.pending = null;
  flushSync(job.run);
}

/**
 * Applies `update` (React state changes) with a view transition when one
 * fits; otherwise at once. Returns `flush()`, which applies the update now
 * if it is still waiting (call it before anything that depends on it).
 */
export function transitionView(update: () => void, { kind, morph = [] }: { kind: ViewKind; morph?: Morph[] }) {
  install();
  settlePending();
  const now = performance.now();
  const rapid = now - state.last < RAPID_MS || !!state.active;
  state.last = now;
  const begin = start();
  if (!begin || rapid || state.off || !viewTransitionsEnabled()) {
    state.active?.skipTransition();
    update();
    return { flush: () => {}, transition: null };
  }
  const job = { run: update, done: false };
  state.pending = job;
  const named: HTMLElement[] = [];
  const name = (element: Element | null | undefined, value: string) => {
    if (!(element instanceof HTMLElement || element instanceof SVGElement)) return null;
    (element as HTMLElement).style.viewTransitionName = value;
    named.push(element as HTMLElement);
    return element as HTMLElement;
  };
  const unname = () => {
    for (const element of named.splice(0)) element.style.viewTransitionName = "";
  };
  for (const pair of morph) name(pair.from, pair.name);
  const root = document.documentElement;
  root.dataset.viewTransition = kind;
  let transition: Transition;
  try {
    transition = begin(() => {
      unname();
      if (!job.done) {
        job.done = true;
        if (state.pending === job) state.pending = null;
        flushSync(update);
      }
      for (const pair of morph) {
        const target = name(pair.to?.(), pair.name);
        if (target) pair.onTarget?.(target);
      }
    });
  } catch {
    unname();
    delete root.dataset.viewTransition;
    settlePending();
    return { flush: () => {}, transition: null };
  }
  state.active = transition;
  const done = () => {
    unname();
    if (state.active === transition) {
      state.active = null;
      delete root.dataset.viewTransition;
    }
  };
  transition.finished.then(done, done);
  return {
    flush: () => {
      if (state.pending === job) settlePending();
    },
    transition,
  };
}
