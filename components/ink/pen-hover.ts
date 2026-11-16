// The Apple Pencil over a drawing block (#315): its controls show where the
// hovering pen is, and taps with the pen never feed Scribble.
import { isHovering, stylusTouch } from "@/lib/stylus";

const CONTROL = "button, select, [role='radio'], [role='button']";
// Fields keep the pen for Scribble (a size, a hex colour) and their pickers.
const FIELD = "input, textarea, select, [contenteditable='true'], [contenteditable='']";

// Hover feedback for the pen on the controls inside `root`: the control
// under a hovering pen gets .is-pen-hover. iPadOS reports (hover: none), so
// :hover styles gated on (hover: hover) never show for the Pencil; mouse
// hover stays as it is, and a finger leaves nothing behind (only the pen
// sets the class, any press clears it).
export function trackPenHover(root: HTMLElement) {
  let current: Element | null = null;
  const set = (next: Element | null) => {
    if (next === current) return;
    current?.classList.remove("is-pen-hover");
    current = next;
    current?.classList.add("is-pen-hover");
  };
  const move = (event: PointerEvent) => {
    if (!isHovering(event)) return set(null);
    const control = (event.target as Element | null)?.closest?.(CONTROL);
    set(control && root.contains(control) ? control : null);
  };
  const clear = () => set(null);
  root.addEventListener("pointerover", move);
  root.addEventListener("pointermove", move);
  root.addEventListener("pointerdown", clear, true);
  root.addEventListener("pointerleave", clear);
  return () => {
    set(null);
    root.removeEventListener("pointerover", move);
    root.removeEventListener("pointermove", move);
    root.removeEventListener("pointerdown", clear, true);
    root.removeEventListener("pointerleave", clear);
  };
}

// Pen taps on buttons inside `root` without Scribble: WebKit starts Scribble
// (writing into the document's text, whose box reaches under the block) for
// a stylus touch it is not told to leave alone. The stylus touchstart is
// cancelled – which also cancels the click WebKit would send – so the
// button is clicked on the pen's pointerup instead, and a click WebKit
// sends anyway is not counted twice. Fields keep their pen (Scribble into
// a size field is wanted); the canvas cancels its own touches.
export function penTapsWithoutScribble(root: HTMLElement) {
  let pressed: HTMLElement | null = null;
  let cancelled = false;
  const touch = (event: TouchEvent) => {
    if (!event.cancelable || !stylusTouch(event)) return;
    // Only fields inside `root` count: a drawing block lies in the
    // document's editor, which is contenteditable as a whole.
    const field = (event.target as Element | null)?.closest?.(FIELD);
    if (field && root.contains(field)) return;
    event.preventDefault();
    cancelled = true;
  };
  const down = (event: PointerEvent) => {
    if (event.pointerType !== "pen") return;
    cancelled = false;
    pressed = (event.target as Element | null)?.closest?.<HTMLElement>("button") ?? null;
  };
  const up = (event: PointerEvent) => {
    if (event.pointerType !== "pen") return;
    const button = (event.target as Element | null)?.closest?.<HTMLElement>("button") ?? null;
    const tap = cancelled && !!button && button === pressed && root.contains(button) && !(button as HTMLButtonElement).disabled;
    pressed = null;
    cancelled = false;
    if (!tap) return;
    const swallow = (click: MouseEvent) => {
      if (!click.isTrusted) return;
      click.preventDefault();
      click.stopPropagation();
    };
    window.addEventListener("click", swallow, true);
    setTimeout(() => window.removeEventListener("click", swallow, true), 500);
    button!.click();
  };
  root.addEventListener("touchstart", touch, { passive: false });
  root.addEventListener("pointerdown", down, true);
  root.addEventListener("pointerup", up, true);
  return () => {
    root.removeEventListener("touchstart", touch);
    root.removeEventListener("pointerdown", down, true);
    root.removeEventListener("pointerup", up, true);
  };
}
