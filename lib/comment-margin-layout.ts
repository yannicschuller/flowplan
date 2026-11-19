// Where the cards of the text comment margin go (#387,
// components/comment-margin.tsx). Every card wants to stand at the height of
// its passage (`anchor`, in pixels from the top of the margin); cards that
// would overlap are pushed down, in the order of their passages, with `gap`
// between them. The active card (an expanded thread or the new comment)
// stands exactly at its passage: the cards above it move up to make room –
// never above `top` –, the ones below it are pushed down. Only where the
// room above is too small does the active card move down as well.
// Plain numbers in and out, so tests/comment-margin-layout.test.ts can check
// it without a browser.

export type MarginItem = { id: string; anchor: number; height: number };
export type MarginPlacement = { id: string; top: number };

export function layoutMarginCards(
  items: readonly MarginItem[],
  { gap = 8, active = null, top = Number.NEGATIVE_INFINITY }: { gap?: number; active?: string | null; top?: number } = {},
): MarginPlacement[] {
  // By passage; cards of the same height keep the order they came in.
  const sorted = items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => a.item.anchor - b.item.anchor || a.index - b.index)
    .map(({ item }) => item);
  const ys: number[] = sorted.map((item) => Math.max(item.anchor, top));
  const k = active === null ? -1 : sorted.findIndex((item) => item.id === active);
  const forward = (from: number, to: number) => {
    for (let i = from; i <= to; i++) {
      const floor = i === 0 ? top : ys[i - 1] + sorted[i - 1].height + gap;
      ys[i] = Math.max(ys[i], floor);
    }
  };
  if (k < 0) forward(0, sorted.length - 1);
  else {
    // Upwards from the active card: each card ends `gap` above the next.
    for (let i = k - 1; i >= 0; i--) ys[i] = Math.min(sorted[i].anchor, ys[i + 1] - gap - sorted[i].height);
    // Not enough room above: from the top down again, the active card too.
    if (sorted.length && ys[0] < top) forward(0, k);
    forward(k + 1, sorted.length - 1);
  }
  return sorted.map((item, i) => ({ id: item.id, top: ys[i] }));
}

// The lowest edge of the placed cards (0 without cards): how far the margin
// reaches below its top.
export function marginExtent(items: readonly MarginItem[], placements: readonly MarginPlacement[]) {
  const heights = new Map(items.map((item) => [item.id, item.height]));
  return placements.reduce((bottom, p) => Math.max(bottom, p.top + (heights.get(p.id) || 0)), 0);
}
