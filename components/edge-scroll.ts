// Scrolls the nearest scrollable ancestor while a pointer drag rests near its
// start or end edge (top/bottom, or left/right for "x"); `onScroll` lets the
// caller refresh the drop target.
const EDGE = 48,
  MAX_STEP = 14;
type Axis = "x" | "y";

function scrollParent(el: HTMLElement | null, axis: Axis) {
  for (let node = el?.parentElement; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    const overflow = axis === "y" ? style.overflowY : style.overflowX;
    const scrollable =
      axis === "y"
        ? node.scrollHeight > node.clientHeight
        : node.scrollWidth > node.clientWidth;
    if (/(auto|scroll)/.test(overflow) && scrollable) return node;
  }
  return null;
}

export function edgeScroller(
  onScroll: (x: number, y: number) => void,
  axis: Axis = "y",
) {
  let frame = 0,
    container: HTMLElement | null = null,
    x = 0,
    y = 0;
  const step = () => {
    frame = 0;
    if (!container) return;
    const rect = container.getBoundingClientRect(),
      start = axis === "y" ? y - rect.top : x - rect.left,
      end = axis === "y" ? rect.bottom - y : rect.right - x;
    const speed =
      start < EDGE
        ? -Math.ceil(((EDGE - Math.max(start, 0)) / EDGE) * MAX_STEP)
        : end < EDGE
          ? Math.ceil(((EDGE - Math.max(end, 0)) / EDGE) * MAX_STEP)
          : 0;
    if (!speed) return;
    const key = axis === "y" ? "scrollTop" : "scrollLeft";
    const before = container[key];
    container[key] += speed;
    if (container[key] === before) return;
    onScroll(x, y);
    frame = requestAnimationFrame(step);
  };
  return {
    start(handle: HTMLElement) {
      container = scrollParent(handle, axis);
    },
    move(nextX: number, nextY: number) {
      x = nextX;
      y = nextY;
      if (!frame && container) frame = requestAnimationFrame(step);
    },
    stop() {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      container = null;
    },
  };
}
