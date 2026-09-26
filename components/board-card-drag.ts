// Board cards follow the pointer as a tilted, lifted preview while the
// original stays behind as a faded placeholder. Cards in the target column
// glide apart to open a gap where the card will land. Nothing is reordered in
// the DOM during the drag and hit testing uses the positions measured when the
// drag started, so the layout cannot shift under the pointer and flicker.
// After the drop the preview settles into the gap; the caller then commits
// the move and calls `settle()` in the same frame as the re-render.

export type BoardDropHint = {
  id: string;
  groupKey: string;
  placement: "before" | "after";
};
export type BoardDrop = {
  groupKey: string;
  targetId?: string;
  placement: "before" | "after" | "end";
};
type Box = { top: number; bottom: number; left: number; right: number };
type Card = { id: string; el: HTMLElement; box: Box };
type Column = {
  key: string;
  el: HTMLElement;
  box: Box;
  cards: Card[];
  // Where the first card sits in an empty column.
  start: number;
  extras: HTMLElement[];
};

const EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";
const TILT = 3;

function box(el: Element): Box {
  const r = el.getBoundingClientRect();
  return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
}
function verticalScroller(el: HTMLElement) {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const style = getComputedStyle(p);
    if (/(auto|scroll)/.test(style.overflowY) && p.scrollHeight > p.clientHeight)
      return p;
  }
  return document.scrollingElement as HTMLElement | null;
}

export function startBoardCardDrag(options: {
  board: HTMLElement;
  wrap: HTMLElement;
  rowId: string;
  groupKey: string;
  x: number;
  y: number;
  onHint: (hint: BoardDropHint | null) => void;
}) {
  const { board, wrap, rowId, onHint } = options;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const scroller = verticalScroller(board);
  const scroll0 = { x: board.scrollLeft, y: scroller?.scrollTop ?? 0 };
  // Pointer and boxes are compared in the coordinates of the drag start.
  const shift = () => ({
    x: board.scrollLeft - scroll0.x,
    y: (scroller?.scrollTop ?? 0) - scroll0.y,
  });

  const columns: Column[] = [
    ...board.querySelectorAll<HTMLElement>(
      ":scope > .board-column[data-group-key]:not(.collapsed)",
    ),
  ].map((el) => {
    const cards = [
      ...el.querySelectorAll<HTMLElement>(
        ":scope > .record-card-wrap[data-row-id]",
      ),
    ].map((card) => ({ id: card.dataset.rowId!, el: card, box: box(card) }));
    const header = el.querySelector(":scope > header");
    return {
      key: el.dataset.groupKey!,
      el,
      box: box(el),
      cards,
      start: header ? box(header).bottom : box(el).top,
      extras: [...el.querySelectorAll<HTMLElement>(":scope > .new-record")],
    };
  });
  const source = columns.find((c) => c.key === options.groupKey);
  const sourceIndex = source?.cards.findIndex((c) => c.id === rowId) ?? -1;
  if (!source || sourceIndex < 0) return null;
  const sourceBox = source.cards[sourceIndex].box;
  const height = sourceBox.bottom - sourceBox.top;
  // The spacing between two cards (their margin sits outside the wrap).
  const next = source.cards[sourceIndex + 1] || source.cards[sourceIndex - 1];
  const spacing = next
    ? Math.max(
        0,
        next.box.top > sourceBox.top
          ? next.box.top - sourceBox.bottom
          : sourceBox.top - next.box.bottom,
      )
    : 10;
  const gap = height + spacing;

  // The lifted preview: a copy of the card, fixed to the viewport.
  const grab = { x: options.x - sourceBox.left, y: options.y - sourceBox.top };
  const preview = document.createElement("div");
  preview.className = "board-drag-preview";
  preview.setAttribute("aria-hidden", "true");
  preview.style.width = `${sourceBox.right - sourceBox.left}px`;
  const face = (wrap.querySelector(".record-card") || wrap).cloneNode(
    true,
  ) as HTMLElement;
  face.removeAttribute("id");
  face.querySelectorAll("[id]").forEach((n) => n.removeAttribute("id"));
  preview.appendChild(face);
  document.body.appendChild(preview);
  let pointer = { x: options.x, y: options.y };
  const place = (x: number, y: number) => {
    preview.style.transform = `translate3d(${x - grab.x}px, ${y - grab.y}px, 0)`;
  };
  place(options.x, options.y);
  if (!reduced)
    face.animate(
      [
        { transform: "none", boxShadow: "0 1px 2px #1d1a140d" },
        {
          transform: `rotate(${TILT}deg) scale(1.02)`,
          boxShadow: "0 18px 40px #1d1a1433, 0 2px 6px #1d1a141a",
        },
      ],
      { duration: 160, easing: EASE, fill: "forwards" },
    );
  else face.style.transform = `rotate(${TILT}deg)`;

  wrap.dataset.drag = "source";
  board.dataset.cardDragging = "true";
  const touched = new Set<HTMLElement>([wrap]);
  const offsets = new Map<HTMLElement, number>();
  const offset = (el: HTMLElement, y: number) => {
    if ((offsets.get(el) || 0) === y) return;
    offsets.set(el, y);
    touched.add(el);
    el.style.transition = reduced ? "" : `translate 0.22s ${EASE}`;
    el.style.translate = y ? `0 ${y}px` : "";
  };
  const grow = (column: Column, px: number) => {
    column.el.style.setProperty("--drop-gap", `${px}px`);
    touched.add(column.el);
  };

  let target: { column: Column; index: number } | null = null;
  // Index among the other cards of the column the card would take.
  function hit(x: number, y: number) {
    const s = shift();
    const px = x + s.x,
      py = y + s.y;
    const column =
      columns.find((c) => px >= c.box.left && px <= c.box.right) ||
      columns.reduce<Column | undefined>((best, c) => {
        const d = Math.min(Math.abs(px - c.box.left), Math.abs(px - c.box.right));
        const b = best
          ? Math.min(
              Math.abs(px - best.box.left),
              Math.abs(px - best.box.right),
            )
          : Infinity;
        return d < b ? c : best;
      }, undefined);
    if (!column) return null;
    const others = column.cards.filter((c) => c.id !== rowId);
    let index = others.findIndex((c) => py < (c.box.top + c.box.bottom) / 2);
    if (index < 0) index = others.length;
    return { column, index };
  }
  function show() {
    for (const column of columns) {
      const others = column.cards.filter((c) => c.id !== rowId);
      const here = target?.column === column ? target.index : -1;
      if (column === source) {
        // Same column: the placeholder travels to its new slot and the cards
        // in between make room for it.
        const t = here < 0 ? sourceIndex : here;
        let ghost = 0;
        others.forEach((card, i) => {
          const before = i < sourceIndex,
            dy = before && i >= t ? gap : !before && i < t ? -gap : 0;
          offset(card.el, dy);
          // The placeholder moves the other way by the size of each card.
          const size = card.box.bottom - card.box.top + spacing;
          if (dy) ghost += dy > 0 ? -size : size;
        });
        offset(wrap, ghost);
        continue;
      }
      others.forEach((card, i) =>
        offset(card.el, here >= 0 && i >= here ? gap : 0),
      );
      for (const extra of column.extras) offset(extra, here >= 0 ? gap : 0);
      grow(column, here >= 0 ? gap : 0);
    }
    // A move to the same place is no move.
    const t = target;
    if (!t || (t.column === source && t.index === sourceIndex)) onHint(null);
    else {
      const others = t.column.cards.filter((c) => c.id !== rowId);
      const at = others[t.index];
      onHint(
        at
          ? { id: at.id, groupKey: t.column.key, placement: "before" }
          : others.length
            ? { id: others.at(-1)!.id, groupKey: t.column.key, placement: "after" }
            : null,
      );
    }
  }
  // The viewport top of the slot the card would land in.
  function landing() {
    if (!target) return null;
    const { column, index } = target;
    const others = column.cards.filter((c) => c.id !== rowId);
    let top: number;
    if (column === source) {
      top = sourceBox.top + (offsets.get(wrap) || 0);
    } else if (others[index]) top = others[index].box.top;
    else if (others.length) top = others.at(-1)!.box.bottom + spacing;
    else top = column.start;
    const s = shift();
    return {
      left: (others[0]?.box.left ?? column.box.left) - s.x,
      top: top - s.y,
    };
  }
  let frame = 0;
  let landed: { left: number; top: number } | null = null;
  let done = false;

  function fly(to: { left: number; top: number }, then?: () => void) {
    const from = preview.style.transform;
    const end = `translate3d(${to.left}px, ${to.top}px, 0)`;
    preview.style.transform = end;
    face.getAnimations().forEach((a) => a.cancel());
    if (reduced) {
      face.style.transform = "";
      then?.();
      return;
    }
    preview.animate([{ transform: from }, { transform: end }], {
      duration: 220,
      easing: EASE,
    });
    const settleFace = face.animate(
      [
        {
          transform: `rotate(${TILT}deg) scale(1.02)`,
          boxShadow: "0 18px 40px #1d1a1433, 0 2px 6px #1d1a141a",
        },
        { transform: "none", boxShadow: "0 1px 2px #1d1a140d" },
      ],
      { duration: 220, easing: EASE, fill: "forwards" },
    );
    if (then) settleFace.onfinish = then;
  }
  function clear() {
    cancelAnimationFrame(frame);
    for (const el of touched) {
      el.style.transition = "";
      el.style.translate = "";
      el.style.removeProperty("--drop-gap");
      if (el.dataset.drag) delete el.dataset.drag;
    }
    delete board.dataset.cardDragging;
    preview.remove();
  }

  return {
    move(x: number, y: number) {
      if (done) return;
      pointer = { x, y };
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        place(pointer.x, pointer.y);
        const next = hit(pointer.x, pointer.y);
        if (
          next?.column !== target?.column ||
          next?.index !== target?.index
        ) {
          target = next;
          show();
        }
      });
    },
    // Ends the gesture. Returns the move to commit, or null when the card
    // returns to its place.
    drop(): BoardDrop | null {
      done = true;
      cancelAnimationFrame(frame);
      place(pointer.x, pointer.y);
      target = hit(pointer.x, pointer.y);
      show();
      const t = target;
      if (!t || (t.column === source && t.index === sourceIndex)) {
        this.cancel();
        return null;
      }
      landed = landing();
      if (landed) fly(landed);
      const others = t.column.cards.filter((c) => c.id !== rowId);
      const at = others[t.index];
      return at
        ? { groupKey: t.column.key, targetId: at.id, placement: "before" }
        : others.length
          ? {
              groupKey: t.column.key,
              targetId: others.at(-1)!.id,
              placement: "after",
            }
          : { groupKey: t.column.key, placement: "end" };
    },
    // The card goes back to where it came from.
    cancel() {
      done = true;
      target = null;
      show();
      const s = shift();
      fly({ left: sourceBox.left - s.x, top: sourceBox.top - s.y }, clear);
      if (reduced) clear();
    },
    // Called in the layout effect of the re-render with the committed move:
    // returns where each card is on screen right now (for the slide), then
    // removes all drag styling in the same frame.
    settle() {
      const seen = new Map<string, { left: number; top: number }>();
      for (const column of columns)
        for (const card of column.cards)
          if (card.el.isConnected && card.el !== wrap) {
            const r = card.el.getBoundingClientRect();
            seen.set(card.id, { left: r.left, top: r.top });
          }
      if (landed) seen.set(rowId, landed);
      clear();
      return seen;
    },
  };
}
export type BoardCardDrag = NonNullable<ReturnType<typeof startBoardCardDrag>>;
