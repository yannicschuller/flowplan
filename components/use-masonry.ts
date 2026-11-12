"use client";
// Masonry for a CSS grid (#218, lib/masonry.ts): the start page's widgets
// and a dashboard's tiles fill the gaps below short items. The grid keeps
// its columns and each item the width its size class gives; this hook puts
// every item into the grid's first row at its column and moves it down with
// a top margin, so the row is as high as the tallest column. DOM order – and
// with it the keyboard and screen-reader order – stays the configured order.
//
// Use: <div className="home-grid" ref={useMasonry()}>. Heights are measured
// before the browser paints (when the grid is attached, then by a
// ResizeObserver whose callbacks also run before paint), so nothing jumps
// when widgets load or the window changes width. With one column (phones)
// the grid is left alone. Nothing is animated.
import { useCallback } from "react";
import { masonrySpan, placeMasonry } from "@/lib/masonry";

function clear(el: HTMLElement) {
  el.style.removeProperty("grid-column");
  el.style.removeProperty("grid-row");
  el.style.removeProperty("margin-top");
}

// A callback ref for the grid; it cleans up when the grid goes away.
export function useMasonry() {
  return useCallback((grid: HTMLElement | null) => {
    if (!grid || typeof ResizeObserver === "undefined") return;
    let items: HTMLElement[] = [];
    const layout = () => {
      // Measured in the grid's own flow: its columns, the spans the
      // stylesheet gives (they change with the grid's width) and the
      // heights at those widths. Written back below before anything is
      // painted. Cleared first: an earlier placement in a column the grid
      // no longer has would count as an extra (implicit) column.
      items.forEach(clear);
      const style = getComputedStyle(grid);
      const columns = style.gridTemplateColumns.split(/\s+/).filter((v) => v && v !== "none").length;
      const shown = items.filter((el) => el.isConnected && getComputedStyle(el).display !== "none");
      if (columns < 2 || !shown.length) {
        delete grid.dataset.masonry;
        return;
      }
      const spans = shown.map((el) => {
        const own = getComputedStyle(el);
        return masonrySpan(own.gridColumnStart, own.gridColumnEnd, columns);
      });
      const { placements } = placeMasonry(
        shown.map((el, i) => ({ span: spans[i], height: el.offsetHeight })),
        columns,
        parseFloat(style.rowGap) || 0,
      );
      shown.forEach((el, i) => {
        const { column, top, span } = placements[i];
        el.style.gridColumn = `${column + 1} / span ${span}`;
        el.style.gridRow = "1";
        el.style.marginTop = `${Math.round(top * 100) / 100}px`;
      });
      grid.dataset.masonry = String(columns);
    };
    const sizes = new ResizeObserver(layout);
    const observe = () => {
      sizes.disconnect();
      items.forEach((el) => !el.isConnected && clear(el));
      items = [...grid.children].filter((el): el is HTMLElement => el instanceof HTMLElement);
      sizes.observe(grid);
      items.forEach((el) => sizes.observe(el));
      layout();
    };
    // Widgets added, removed or reordered.
    const children = new MutationObserver(observe);
    children.observe(grid, { childList: true });
    observe();
    return () => {
      children.disconnect();
      sizes.disconnect();
      items.forEach(clear);
      delete grid.dataset.masonry;
    };
  }, []);
}
