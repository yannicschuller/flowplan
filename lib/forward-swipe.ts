// The swipe from the right edge goes forward (#647): in the app for iPhone,
// iPad and Android, once the person has set "Wischen vom linken Rand" to
// "Zurück" (lib/edge-swipe-pref.ts) – the left edge then goes back, the
// right one forward again, as the forward arrow at the top left does
// (lib/history-nav.ts goForward). Only while there is a step forward;
// with "Seitenleiste öffnen" (the default) the right edge stays the page's.
//
// The page handles the swipe itself (components/forward-swipe.ts): a round
// chevron comes in with the finger from the right, like the app's own back
// swipe on iOS; past the threshold (or with a flick) it goes forward. On
// iOS nothing else claims the right edge in the app's web view. On Android
// the right edge is the system's back gesture: only an app that keeps a
// strip of it for the page while it asks (FlowplanApp.forwardState, app
// 1.1.11 and newer) gets the swipe there; with an older app the right edge
// stays the system's back and the page offers nothing.
//
// Places that use the right edge themselves are left alone (FORWARD_IGNORE
// in the component): dialogs and sheets, the side panel and "KI fragen",
// the comments, canvases and whiteboards, sliders, anything marked
// data-no-edge-swipe, a table or board that can still scroll to the right
// (canScrollForward, lib/sideways-scroll.ts) and a text selection (its
// handles).
//
// Pure – no DOM, no React; tests/forward-swipe.test.ts.
import type { EdgeSwipePref } from "./edge-swipe";

// Where the swipe may start: this many px from the right edge.
export const FORWARD_EDGE = 24;
// How far the finger travels before letting go goes forward, and the flick
// that does it earlier (px/ms, after FLICK_MIN px).
export const FORWARD_THRESHOLD = 72;
export const FLICK_SPEED = 0.7;
export const FLICK_MIN = 24;
// The chevron's size (px).
export const CHEVRON = 40;

export type ForwardEnv = {
  platform: "ios" | "android" | null;
  // The app takes the person's choice (FlowplanApp.edgeSwipe).
  appTakesChoice: boolean;
  // The app keeps the right edge for the page while it asks
  // (FlowplanApp.forwardState; needed on Android only).
  appForward: boolean;
  pref: EdgeSwipePref;
};

// Whether this device offers the swipe at all (the setting's note says so).
export function forwardSwipeSupported(env: Omit<ForwardEnv, "pref">): boolean {
  if (!env.appTakesChoice) return false;
  if (env.platform === "ios") return true;
  if (env.platform === "android") return env.appForward;
  return false;
}

// Whether the right edge goes forward now.
export function forwardSwipeOn(env: ForwardEnv & { canGoForward: boolean }): boolean {
  return env.pref === "back" && env.canGoForward && forwardSwipeSupported(env);
}

// Whether a touch at `x` (px from the left, in a window `width` wide) may
// start the swipe.
export function atRightEdge(x: number, width: number, edge = FORWARD_EDGE): boolean {
  return width > 0 && x >= width - edge && x <= width;
}

// Where the chevron stands for a finger `distance` px in from the edge:
// how far it has come in (rubber band past the threshold, as the app's back
// swipe) and whether letting go goes forward.
export function forwardTravel(distance: number): { travel: number; armed: boolean } {
  const d = Math.max(0, distance);
  const travel = d < FORWARD_THRESHOLD ? d : FORWARD_THRESHOLD + (d - FORWARD_THRESHOLD) * 0.25;
  return { travel: Math.min(travel, FORWARD_THRESHOLD + 24) * 0.9, armed: d >= FORWARD_THRESHOLD };
}

// Whether letting go at `distance` with `velocity` (px/ms towards the
// middle, positive) goes forward.
export function forwardCommits(distance: number, velocity: number): boolean {
  return distance >= FORWARD_THRESHOLD || (velocity > FLICK_SPEED && distance > FLICK_MIN);
}
