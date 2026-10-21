// Small motion helpers shared by the views: FLIP glides for things that
// moved, a brief highlight after a jump, eased camera moves and the guards
// that keep all of it out of the way. Everything is off for people who ask
// their system to reduce motion; nothing here waits for an animation before
// accepting input. Pure parts (deltas, easing, camera interpolation) are
// unit-tested in tests/motion.test.ts.

export const EASE_OUT = "cubic-bezier(0.2, 0.8, 0.2, 1)";
/** Durations in ms: UI changes stay short, camera moves may take longer. */
export const DURATION = { fast: 150, base: 200, slow: 250, camera: 360 } as const;
/** Lists with more items than this jump instead of gliding. */
export const FLIP_LIMIT = 150;

type MediaWindow = { matchMedia?: (query: string) => { matches: boolean } };

/** True when the system asks for reduced motion (and on the server). */
export function prefersReducedMotion(
  win: MediaWindow | undefined = typeof window === "undefined" ? undefined : (window as MediaWindow),
): boolean {
  if (!win || typeof win.matchMedia !== "function") return true;
  try {
    return win.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return true;
  }
}

// ---- input guards ----
// Changes caused by typing (a filter field, a search) or arriving while a
// pointer is held (resizing a column, dragging) jump: animating them would
// make every keystroke or pointer move wobble.
const input = { typedAt: -Infinity, pointers: 0, installed: false };
function install() {
  if (input.installed || typeof document === "undefined") return;
  input.installed = true;
  const typed = (e: Event) => {
    const target = e.target as HTMLElement | null;
    if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) input.typedAt = Date.now();
  };
  document.addEventListener("input", typed, true);
  document.addEventListener("keydown", typed, true);
  document.addEventListener("pointerdown", () => (input.pointers += 1), true);
  const up = () => (input.pointers = Math.max(0, input.pointers - 1));
  document.addEventListener("pointerup", up, true);
  document.addEventListener("pointercancel", up, true);
  // A lost pointerup (released outside the window) must not block motion.
  window.addEventListener("blur", () => (input.pointers = 0));
}
/** Whether the last keystroke in a field was within `ms`. */
export function typedRecently(ms = 500, now = Date.now()): boolean {
  install();
  return now - input.typedAt < ms;
}
/** Whether a pointer (mouse button, finger, pen) is currently held down. */
export function pointerHeld(): boolean {
  install();
  return input.pointers > 0;
}
/** The common guard for layout animations. */
export function motionAllowed(): boolean {
  return !prefersReducedMotion() && !typedRecently() && !pointerHeld();
}

// ---- FLIP ----
export type Point = { x: number; y: number };

/**
 * How far each element has to be shifted back to appear where it was:
 * `before - after` for keys present in both, ignoring sub-pixel noise.
 */
export function flipDeltas(
  before: ReadonlyMap<string, Point>,
  after: ReadonlyMap<string, Point>,
  threshold = 1,
): Map<string, Point> {
  const deltas = new Map<string, Point>();
  for (const [key, to] of after) {
    const from = before.get(key);
    if (!from) continue;
    const x = from.x - to.x,
      y = from.y - to.y;
    if (Math.abs(x) >= threshold || Math.abs(y) >= threshold) deltas.set(key, { x, y });
  }
  return deltas;
}

/**
 * Whether the keys present in both lists keep their relative order (items
 * only added or removed, nothing moved past another).
 */
export function sameRelativeOrder(before: readonly string[], after: readonly string[]): boolean {
  const kept = new Set(after);
  const a = before.filter((k) => kept.has(k));
  const had = new Set(a);
  const b = after.filter((k) => had.has(k));
  return a.length === b.length && a.every((k, i) => k === b[i]);
}

/** The offset a running glide currently adds to an element. */
function glideOffset(el: Element): Point {
  if (typeof el.getAnimations !== "function" || !el.getAnimations().some((a) => a.id === "fp-glide"))
    return { x: 0, y: 0 };
  const transform = getComputedStyle(el).transform;
  if (!transform || transform === "none") return { x: 0, y: 0 };
  const m = new DOMMatrixReadOnly(transform);
  return { x: m.e, y: m.f };
}

/**
 * Position of an element relative to `root`, in the root's content
 * coordinates: scrolling inside the root (or of the root) and glides in
 * flight do not count as movement.
 */
export function layoutPosition(el: Element, root: Element, origin = root.getBoundingClientRect()): Point {
  const r = el.getBoundingClientRect(),
    g = glideOffset(el);
  let x = r.left - origin.left - g.x,
    y = r.top - origin.top - g.y;
  for (let p = el.parentElement; p; p = p.parentElement) {
    x += p.scrollLeft;
    y += p.scrollTop;
    if (p === root) break;
  }
  return { x, y };
}

/** Positions of `elements` relative to `root`, keyed by `key(el)`. */
export function measure(
  root: Element,
  elements: Iterable<Element>,
  key: (el: Element) => string | undefined,
): Map<string, Point> {
  const map = new Map<string, Point>(),
    origin = root.getBoundingClientRect();
  for (const el of elements) {
    const k = key(el);
    if (k && !map.has(k)) map.set(k, layoutPosition(el, root, origin));
  }
  return map;
}

/**
 * Lets an element glide from `delta` (where it was, relative to where it
 * is now) to its place. A glide still running is taken over from its
 * current offset so interrupted moves stay continuous.
 */
export function glide(
  el: HTMLElement | SVGElement,
  delta: Point,
  options: { duration?: number; easing?: string; fade?: boolean } = {},
): Animation | null {
  if (typeof el.animate !== "function") return null;
  const current = glideOffset(el);
  const x = delta.x + current.x,
    y = delta.y + current.y;
  for (const running of el.getAnimations()) if (running.id === "fp-glide") running.cancel();
  const animation = el.animate(
    [
      { transform: `translate(${x}px, ${y}px)`, ...(options.fade ? { opacity: 0.4 } : {}) },
      { transform: "none", ...(options.fade ? { opacity: 1 } : {}) },
    ],
    { duration: options.duration ?? DURATION.slow, easing: options.easing ?? EASE_OUT },
  );
  animation.id = "fp-glide";
  return animation;
}

/** Fades newly appeared elements in. */
export function appear(el: Element, duration: number = DURATION.base) {
  if (typeof el.animate !== "function") return;
  el.animate([{ opacity: 0, transform: "scale(0.98)" }, { opacity: 1, transform: "none" }], {
    duration,
    easing: EASE_OUT,
  });
}

/**
 * One FLIP step for a list: measures the current positions, lets everything
 * that moved since `previous` glide, and returns the new positions to keep
 * for next time. Skips (but still measures) when motion is not allowed or
 * the list is large.
 */
export function flipList(
  root: Element,
  elements: (HTMLElement | SVGElement)[],
  key: (el: Element) => string | undefined,
  previous: Map<string, Point> | null,
  options: { allow?: boolean; duration?: number; fadeIn?: boolean } = {},
): Map<string, Point> {
  const next = measure(root, elements, key);
  if (!previous || !previous.size || elements.length > FLIP_LIMIT || options.allow === false || !motionAllowed())
    return next;
  const deltas = flipDeltas(previous, next);
  for (const el of elements) {
    const k = key(el);
    if (!k) continue;
    const d = deltas.get(k);
    if (d) glide(el, d, { duration: options.duration });
    else if (options.fadeIn && !previous.has(k)) appear(el);
  }
  return next;
}

// ---- jump highlight ----
const flashes = new WeakMap<Element, () => void>();
/**
 * Briefly highlights an element after a jump to it. The highlight is an
 * overlay outside the element (not a class or decoration on it), so editor
 * content is never touched or stored, and it follows the element while the
 * page scrolls. With reduced motion it shows still and disappears.
 */
export function flash(el: Element | null | undefined, duration = 1200) {
  if (!el || typeof document === "undefined" || !el.isConnected) return;
  flashes.get(el)?.();
  const overlay = document.createElement("div");
  const still = prefersReducedMotion();
  overlay.className = `jump-flash${still ? " still" : ""}`;
  overlay.setAttribute("aria-hidden", "true");
  overlay.style.animationDuration = `${duration}ms`;
  // Above a dialog when the target is in one, else below dialogs.
  if (el.closest(".modal-overlay, .modal")) overlay.style.zIndex = "52";
  let frame = 0;
  const place = () => {
    // Re-rendered away (the editor replaced its content): nothing to show.
    if (!el.isConnected) return done();
    const r = el.getBoundingClientRect();
    overlay.style.transform = `translate(${r.left - 4}px, ${r.top - 2}px)`;
    overlay.style.width = `${r.width + 8}px`;
    overlay.style.height = `${r.height + 4}px`;
    frame = requestAnimationFrame(place);
  };
  const done = () => {
    cancelAnimationFrame(frame);
    clearTimeout(timer);
    overlay.remove();
    flashes.delete(el);
  };
  const timer = setTimeout(done, duration + 100);
  if (!still) overlay.addEventListener("animationend", done);
  document.body.append(overlay);
  place();
  flashes.set(el, done);
}

/** Scrolls an element into view (smoothly when allowed), then flashes it. */
export function reveal(el: Element | null | undefined, block: ScrollLogicalPosition = "center", always = false) {
  if (!el) return;
  const box = el.getBoundingClientRect();
  const visible = box.top >= 0 && box.bottom <= window.innerHeight;
  if (visible && !always) return flash(el);
  const reduced = prefersReducedMotion();
  el.scrollIntoView({ block, behavior: reduced ? "auto" : "smooth" });
  if (reduced) return flash(el);
  // Flash once the scroll has settled, so the highlight is seen.
  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    document.removeEventListener("scrollend", start, true);
    flash(el);
  };
  document.addEventListener("scrollend", start, true);
  setTimeout(start, 500);
}

// ---- tweens ----
export const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

export type Camera = { x: number; y: number; zoom: number };
/**
 * A camera between two views of a canvas `size` (screen pixels) at progress
 * `t` (0…1): the centre moves in a straight line while the zoom changes
 * geometrically, so zooming in and out feel equally fast.
 */
export function interpolateCamera(
  from: Camera,
  to: Camera,
  t: number,
  size: { width: number; height: number },
): Camera {
  if (t <= 0) return from;
  if (t >= 1) return to;
  const zoom = Math.exp(Math.log(from.zoom) + (Math.log(to.zoom) - Math.log(from.zoom)) * t);
  const center = (c: Camera) => ({ x: c.x + size.width / 2 / c.zoom, y: c.y + size.height / 2 / c.zoom });
  const a = center(from),
    b = center(to);
  const cx = a.x + (b.x - a.x) * t,
    cy = a.y + (b.y - a.y) * t;
  return { zoom, x: cx - size.width / 2 / zoom, y: cy - size.height / 2 / zoom };
}

/**
 * Runs `onFrame` with eased progress 0…1 over `duration` ms on animation
 * frames; returns a function that stops it. With reduced motion (or without
 * animation frames) it jumps straight to the end.
 */
export function tween(
  duration: number,
  onFrame: (progress: number) => void,
  easing: (t: number) => number = easeInOutCubic,
): () => void {
  if (prefersReducedMotion() || typeof requestAnimationFrame !== "function" || duration <= 0) {
    onFrame(1);
    return () => {};
  }
  let frame = 0,
    start = -1;
  const step = (time: number) => {
    if (start < 0) start = time;
    const t = Math.min(1, (time - start) / duration);
    onFrame(easing(t));
    if (t < 1) frame = requestAnimationFrame(step);
  };
  frame = requestAnimationFrame(step);
  return () => cancelAnimationFrame(frame);
}

// ---- collaborators' carets ----
/**
 * Lets the carets of others (`.collaborator-cursor[data-peer]`, inline
 * widgets in the editor) glide to their new place and pop in when someone
 * arrives. `memory` keeps the last positions per editor. Called on an
 * animation frame after the decorations changed. Carets are inline spans,
 * which ignore transforms, so the glide runs on their relative offset
 * (painted only, the text around them does not move). Carets pushed along
 * by one's own typing do not glide.
 */
export function followCarets(root: HTMLElement, memory: Map<string, Point>) {
  const origin = root.getBoundingClientRect(),
    reduced = prefersReducedMotion(),
    typing = typedRecently(300),
    seen = new Set<string>();
  for (const caret of root.querySelectorAll<HTMLElement>(".collaborator-cursor[data-peer]")) {
    const id = caret.dataset.peer!;
    if (seen.has(id)) continue;
    seen.add(id);
    const r = caret.getBoundingClientRect(),
      at = { x: r.left - origin.left, y: r.top - origin.top };
    const before = memory.get(id);
    memory.set(id, at);
    if (reduced || typeof caret.animate !== "function") continue;
    if (!before) {
      caret.animate([{ opacity: 0 }, { opacity: 1 }], { duration: DURATION.base, easing: EASE_OUT });
      continue;
    }
    const dx = before.x - at.x,
      dy = before.y - at.y;
    if (typing || (Math.abs(dx) < 1 && Math.abs(dy) < 1) || Math.hypot(dx, dy) > 600) continue;
    caret.animate(
      [
        { left: `${dx}px`, top: `${dy}px` },
        { left: "0px", top: "0px" },
      ],
      { duration: 140, easing: EASE_OUT },
    );
  }
  for (const id of [...memory.keys()]) if (!seen.has(id)) memory.delete(id);
}

// ---- ticking off a task ----
/**
 * Feedback when a task is ticked off (in documents and in "Meine
 * Aufgaben"): the box pops and a line is drawn through the text before the
 * real strike-through fades in (globals.css delays it). Both are overlays
 * or Web Animations, so the editor DOM is not touched. One listener for the
 * whole page; without motion nothing happens beyond the plain change.
 */
export function installTaskFeedback() {
  const doc = typeof document === "undefined" ? null : (document as Document & { fpTaskFeedback?: boolean });
  if (!doc || doc.fpTaskFeedback) return;
  doc.fpTaskFeedback = true;
  doc.addEventListener(
    "change",
    (e) => {
      const box = e.target as HTMLInputElement | null;
      if (!box || box.type !== "checkbox" || !box.checked || prefersReducedMotion()) return;
      const text =
        box.closest(".document-editor li[data-checked]")?.querySelector(":scope > div > :not(ul, ol)") ||
        box.closest(".my-tasks-group li")?.querySelector(".my-task-text");
      if (!text || typeof box.animate !== "function") return;
      box.animate([{ transform: "scale(0.75)" }, { transform: "scale(1.12)", offset: 0.6 }, { transform: "none" }], {
        duration: DURATION.slow,
        easing: EASE_OUT,
      });
      drawStrike(text);
    },
    true,
  );
}

/** Draws a line through each line of `text`, left to right. */
function drawStrike(text: Element) {
  const range = document.createRange();
  range.selectNodeContents(text);
  // Rectangles of one line come in pieces (inline marks): merge them.
  const lines: DOMRect[] = [];
  for (const r of range.getClientRects()) {
    if (r.width <= 2) continue;
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.top - r.top) < 4) {
      const left = Math.min(last.left, r.left),
        right = Math.max(last.right, r.right);
      lines[lines.length - 1] = new DOMRect(left, last.top, right - left, last.height);
    } else lines.push(DOMRect.fromRect(r));
  }
  const color = getComputedStyle(text).color;
  lines.slice(0, 6).forEach((r, i) => {
    const line = document.createElement("div");
    line.className = "strike-draw";
    line.setAttribute("aria-hidden", "true");
    Object.assign(line.style, {
      left: `${r.left}px`,
      top: `${r.top + r.height * 0.55}px`,
      width: `${r.width}px`,
      background: color,
    });
    document.body.append(line);
    const remove = () => setTimeout(() => line.remove(), 160);
    line
      .animate([{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], {
        duration: 180,
        delay: i * 90,
        easing: EASE_OUT,
        fill: "both",
      })
      .finished.then(remove, remove);
  });
}
