// Android's predictive back (flowplan-app forwards the gesture's progress,
// FlowplanNavigation.backProgress in lib/app-back.ts): while the finger
// swipes from the edge, what back would close shows it – the top sheet
// sinks and shrinks a little, a dialog or the navigation drawer moves
// towards the edge, the page slides aside. Letting go goes back (the app
// then calls back()); cancelling springs everything into place again.
import { backPreview } from "./sheet-drag";

export type BackPhase = "start" | "progress" | "cancel" | "commit";
export type BackEdge = "left" | "right";
export type BackTarget = { kind: "sheet" | "dialog" | "drawer" | "page"; el: HTMLElement } | null;

const SETTLE = "transform 200ms cubic-bezier(0.2, 0, 0, 1), opacity 200ms cubic-bezier(0.2, 0, 0, 1)";

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

// One preview at a time; `find` names what back would close when the
// gesture starts.
export function createBackPreview(find: () => BackTarget) {
  let target: BackTarget = null,
    base = "",
    timer: ReturnType<typeof setTimeout> | null = null;

  const reset = (el: HTMLElement, animate: boolean) => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!animate || reducedMotion()) {
      el.style.transition = "";
      el.style.transform = "";
      el.style.opacity = "";
      el.style.transformOrigin = "";
      return;
    }
    el.style.transition = SETTLE;
    el.style.transform = base;
    el.style.opacity = "";
    timer = setTimeout(() => {
      timer = null;
      el.style.transition = "";
      el.style.transform = "";
      el.style.transformOrigin = "";
    }, 240);
  };

  const show = (progress: number, edge: BackEdge) => {
    if (!target) return;
    const { el, kind } = target;
    // Reduced motion: no movement, only the commit.
    if (reducedMotion()) return;
    const { x, y, scale, opacity } = backPreview(progress, kind === "drawer" ? "dialog" : kind, edge);
    el.style.transition = "none";
    // The drawer leaves towards its own edge (the start of the line).
    const dx = kind === "drawer" ? -Math.abs(x) * 2 : x;
    el.style.transform = `${base} translate3d(${dx}px, ${y}px, 0) scale(${scale})`.trim();
    if (kind === "page") el.style.opacity = String(opacity);
  };

  return (phase: BackPhase, progress = 0, edge: BackEdge = "left") => {
    if (phase === "start") {
      if (target) reset(target.el, false);
      target = find();
      if (!target) return false;
      // The element's own transform (a centred dialog's) stays underneath.
      const own = getComputedStyle(target.el).transform;
      base = own && own !== "none" ? own : "";
      target.el.style.transformOrigin = target.kind === "sheet" ? "50% 100%" : target.kind === "page" ? `${edge === "right" ? "0%" : "100%"} 50%` : "";
      show(progress, edge);
      return true;
    }
    if (!target) return false;
    if (phase === "progress") {
      show(progress, edge);
      return true;
    }
    const { el, kind } = target;
    target = null;
    // Cancelled: everything springs back. Committed: back() follows at once –
    // a sheet or dialog leaves with the preview's look, the drawer closes by
    // its own transition from where it is, the page comes back into place.
    reset(el, phase === "cancel" || kind === "page");
    return true;
  };
}
