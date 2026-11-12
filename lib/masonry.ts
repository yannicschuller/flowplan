// Masonry for the start page's widgets and a dashboard's tiles (#218): a
// tall widget next to short ones no longer leaves a gap below the short
// ones – the next widget moves up into it. The grids keep their columns
// and the widths their sizes give (app/globals.css); this only says in
// which column each item starts and how far from the top
// (components/use-masonry.ts applies it).
//
// Items are placed in their configured order, each where it sits highest:
// one column wide in the shortest column, wider ones under the lowest
// point of the columns they cover. The first row therefore reads left to
// right as configured, and every column stacks upward. Heights within
// TIE_PX count as equal, so the leftmost column wins and the order stays
// readable.
export type MasonryItem = { span: number; height: number };
export type MasonryPlacement = { column: number; top: number; span: number };
export type MasonryLayout = { placements: MasonryPlacement[]; height: number };

const TIE_PX = 1;

export function placeMasonry(items: readonly MasonryItem[], columns: number, gap: number): MasonryLayout {
  const count = Math.max(1, Math.floor(columns) || 1);
  const space = Math.max(0, gap || 0);
  // Where the next item in each column may start.
  const bottoms = new Array<number>(count).fill(0);
  const placements = items.map(({ span: wanted, height }) => {
    const span = Math.min(count, Math.max(1, Math.floor(wanted) || 1));
    let column = 0,
      top = Infinity;
    for (let c = 0; c + span <= count; c++) {
      const y = Math.max(...bottoms.slice(c, c + span));
      if (y < top - TIE_PX) {
        top = y;
        column = c;
      }
    }
    const end = top + Math.max(0, height || 0) + space;
    for (let c = column; c < column + span; c++) bottoms[c] = end;
    return { column, top, span };
  });
  return { placements, height: items.length ? Math.max(0, Math.max(...bottoms) - space) : 0 };
}

// How many columns an item covers, from its computed grid-column-start and
// -end as the stylesheet gives them ("span 2" / "auto", "1" / "-1" for the
// whole row, "auto" / "auto" for one column), never more than the grid has.
export function masonrySpan(start: string, end: string, columns: number): number {
  const count = Math.max(1, Math.floor(columns) || 1);
  const span = /span\s+(\d+)/.exec(start) || /span\s+(\d+)/.exec(end);
  if (span) return Math.min(count, Math.max(1, Number(span[1])));
  const from = Number(start),
    to = Number(end);
  if (Number.isInteger(from) && Number.isInteger(to) && start.trim() !== "" && end.trim() !== "") {
    const a = from < 0 ? count + 2 + from : from,
      b = to < 0 ? count + 2 + to : to;
    return Math.min(count, Math.max(1, Math.abs(b - a)));
  }
  return 1;
}
