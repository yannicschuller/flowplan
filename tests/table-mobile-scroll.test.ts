// #98: on phones a swipe sideways over a database table showed nothing
// moving – the pinned first column covered the whole table – and a swipe
// to the right near the left edge opened the sidebar instead of scrolling
// the table back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pinnedColumnLeft, pinnedColumnWidth, tableWidth } from "../lib/pinned-column";
import { canScrollBack } from "../lib/sideways-scroll";

test("the pinned column is capped by --pinned-column-max and keeps its width elsewhere", () => {
  assert.equal(pinnedColumnWidth(500), "min(500px, var(--pinned-column-max, 500px))");
  assert.equal(pinnedColumnWidth(279.6), "min(280px, var(--pinned-column-max, 280px))");
  assert.equal(pinnedColumnWidth(-4), "min(0px, var(--pinned-column-max, 0px))");
});

test("the table width counts the capped pinned column, the others and the editable extras", () => {
  assert.equal(
    tableWidth([500, 180, 200], true),
    "calc(422px + var(--selection-column, 76px) + min(500px, var(--pinned-column-max, 500px)))",
  );
  assert.equal(
    tableWidth([280, 180], false),
    "calc(180px + min(280px, var(--pinned-column-max, 280px)))",
  );
  // Without visible properties only the extras remain.
  assert.equal(tableWidth([], true), "calc(42px + var(--selection-column, 76px))");
  assert.equal(tableWidth([], false), "calc(0px)");
});

test("the pinned column sticks after the selection column, which phones may drop", () => {
  assert.equal(pinnedColumnLeft(true), "var(--pinned-column-left, var(--selection-column, 76px))");
  assert.equal(pinnedColumnLeft(false), 0);
});

test("a swipe to the right belongs to a box that has scrolled sideways", () => {
  const table = { overflowX: "auto", scrollLeft: 240, scrollWidth: 1200, clientWidth: 340 };
  assert.equal(canScrollBack([table]), true);
  // At its start there is nothing to scroll back: the drawer may open.
  assert.equal(canScrollBack([{ ...table, scrollLeft: 0 }]), false);
  // Sub-pixel leftovers count as the start.
  assert.equal(canScrollBack([{ ...table, scrollLeft: 0.4 }]), false);
  // Boxes that do not scroll sideways, or have nothing more to show, do not count.
  assert.equal(canScrollBack([{ ...table, overflowX: "hidden" }]), false);
  assert.equal(canScrollBack([{ ...table, overflowX: "visible" }]), false);
  assert.equal(canScrollBack([{ ...table, scrollWidth: 340 }]), false);
  // Any ancestor that has scrolled will do.
  assert.equal(
    canScrollBack([{ overflowX: "visible", scrollLeft: 0, scrollWidth: 900, clientWidth: 300 }, { ...table, overflowX: "scroll" }]),
    true,
  );
  assert.equal(canScrollBack([]), false);
});
