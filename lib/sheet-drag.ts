// The arithmetic of a sheet dragged down to dismiss it (components/
// sheet-drag.ts moves the sheet): how far it follows the finger, when letting
// go dismisses it and how long the sheet takes to settle. Distances in CSS
// pixels, velocities in px/ms (positive: downwards), times in ms.

// A finger has to move this far before the gesture is a drag (or a scroll).
export const DRAG_SLOP = 6;
// Letting go dismisses when the sheet has travelled this share of its height
// (at most DISMISS_MAX px: tall sheets do not need a long pull) …
export const DISMISS_SHARE = 0.3;
export const DISMISS_MAX = 160;
// … or when it is flung down at least this fast, past a few pixels.
export const FLING_VELOCITY = 0.5;
export const FLING_MIN = 12;
// Upwards the sheet resists: it moves by a diminishing share of the pull.
export const RUBBER_BAND = 0.55;

// Where the sheet stands for a finger `delta` px below where it started:
// downwards one to one, upwards rubber-banded towards at most `limit` px.
export function dragOffset(delta: number, limit = 80): number {
  if (!Number.isFinite(delta) || delta >= 0) return Math.max(0, delta || 0);
  const pull = -delta;
  // The iOS formula: (1 - 1 / (x·c/d + 1))·d approaches d, never reaches it.
  return -(1 - 1 / ((pull * RUBBER_BAND) / limit + 1)) * limit;
}

// The distance that dismisses a sheet of this height.
export function dismissDistance(height: number): number {
  return Math.min(DISMISS_MAX, Math.max(48, height * DISMISS_SHARE));
}

// Whether letting go at this offset and velocity dismisses the sheet. A fast
// flick up keeps it, even far down; a fast flick down dismisses from a short
// way already.
export function shouldDismiss({ offset, velocity, height }: { offset: number; velocity: number; height: number }): boolean {
  if (!(offset > 0)) return false;
  if (velocity <= -FLING_VELOCITY) return false;
  if (velocity >= FLING_VELOCITY && offset >= FLING_MIN) return true;
  // Where the sheet would come to rest when let go: a quick release counts
  // for more.
  return projectedOffset(offset, velocity) >= dismissDistance(height);
}

// UIScrollView's projection: v·d / (1 − d) further, with the fast
// deceleration rate (0.99 per ms) – a slow release adds little.
export function projectedOffset(offset: number, velocity: number, deceleration = 0.99): number {
  if (!(velocity > 0)) return offset;
  return offset + (velocity * deceleration) / (1 - deceleration);
}

// How long the sheet takes to leave (to `distance` px) or to spring back
// from `distance` px, given the release velocity: it keeps the finger's
// speed, between 120 and 320 ms. 0 with reduced motion.
export function settleDuration(distance: number, velocity: number, reducedMotion = false): number {
  if (reducedMotion) return 0;
  const remaining = Math.abs(distance);
  const speed = Math.abs(velocity);
  const natural = speed > 0.05 ? remaining / speed : 280;
  return Math.round(Math.min(320, Math.max(120, natural)));
}

// The finger's speed from its last positions (time, y): over the last
// 100 ms, so a pause before letting go reads as standing still.
export type Sample = { t: number; y: number };
export function releaseVelocity(samples: readonly Sample[], window = 100): number {
  if (samples.length < 2) return 0;
  const last = samples[samples.length - 1];
  let first = last;
  for (let i = samples.length - 2; i >= 0; i--) {
    if (last.t - samples[i].t > window) break;
    first = samples[i];
  }
  const dt = last.t - first.t;
  return dt > 0 ? (last.y - first.y) / dt : 0;
}

// How much of the backdrop remains while the sheet is `offset` px down:
// fades with the way to dismissal, never below 0.
export function backdropOpacity(offset: number, height: number): number {
  if (!(offset > 0) || !(height > 0)) return 1;
  return Math.max(0, 1 - offset / height);
}

// The back gesture's preview (Android's predictive back, lib/back-preview.ts):
// progress 0–1 of the swipe becomes a small move and shrink of what back
// closes, as Material's predictive back animations do.
export function backPreview(progress: number, kind: "sheet" | "dialog" | "page", edge: "left" | "right" = "left") {
  const p = Math.min(1, Math.max(0, Number.isFinite(progress) ? progress : 0));
  // Material eases the gesture's progress (the first part moves most).
  const eased = 1 - (1 - p) * (1 - p);
  const direction = edge === "right" ? -1 : 1;
  if (kind === "sheet") return { x: 0, y: Math.round(eased * 48), scale: 1 - eased * 0.05, opacity: 1 };
  if (kind === "dialog") return { x: Math.round(direction * eased * 16), y: 0, scale: 1 - eased * 0.1, opacity: 1 };
  return { x: Math.round(direction * eased * 32), y: 0, scale: 1 - eased * 0.06, opacity: 1 - eased * 0.15 };
}
