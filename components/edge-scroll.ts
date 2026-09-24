// Scrolls the nearest scrollable ancestor while a pointer drag rests near its
// top or bottom edge; `onScroll` lets the caller refresh the drop target.
const EDGE = 48,
  MAX_STEP = 14;

function scrollParent(el: HTMLElement | null) {
  for (let node = el?.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (
      /(auto|scroll)/.test(overflowY) &&
      node.scrollHeight > node.clientHeight
    )
      return node;
  }
  return null;
}

export function edgeScroller(onScroll: (x: number, y: number) => void) {
  let frame = 0,
    container: HTMLElement | null = null,
    x = 0,
    y = 0;
  const step = () => {
    frame = 0;
    if (!container) return;
    const rect = container.getBoundingClientRect(),
      top = y - rect.top,
      bottom = rect.bottom - y;
    const speed =
      top < EDGE
        ? -Math.ceil(((EDGE - Math.max(top, 0)) / EDGE) * MAX_STEP)
        : bottom < EDGE
          ? Math.ceil(((EDGE - Math.max(bottom, 0)) / EDGE) * MAX_STEP)
          : 0;
    if (!speed) return;
    const before = container.scrollTop;
    container.scrollTop += speed;
    if (container.scrollTop === before) return;
    onScroll(x, y);
    frame = requestAnimationFrame(step);
  };
  return {
    start(handle: HTMLElement) {
      container = scrollParent(handle);
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
