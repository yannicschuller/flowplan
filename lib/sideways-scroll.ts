// Whether a swipe to the right belongs to something that scrolls sideways:
// a table, board or timeline that has been scrolled to the right scrolls
// back with it, so the drawer's swipe from the left edge leaves it alone
// (components/drawer-swipe.ts, #98).

export type SidewaysBox = {
  overflowX: string;
  scrollLeft: number;
  scrollWidth: number;
  clientWidth: number;
};

/** One of the boxes (the touch's target and its ancestors) can scroll back to the left. */
export function canScrollBack(boxes: Iterable<SidewaysBox>): boolean {
  for (const box of boxes)
    if (
      (box.overflowX === "auto" || box.overflowX === "scroll") &&
      box.scrollWidth > box.clientWidth + 1 &&
      box.scrollLeft >= 1
    )
      return true;
  return false;
}

/** The target and its ancestors up to (not including) the body, as boxes. */
export function* sidewaysBoxes(target: Element | null): Generator<SidewaysBox> {
  for (let el = target; el && el !== document.body; el = el.parentElement) {
    if (el.scrollWidth <= el.clientWidth + 1) continue;
    yield {
      overflowX: getComputedStyle(el).overflowX,
      scrollLeft: el.scrollLeft,
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    };
  }
}
