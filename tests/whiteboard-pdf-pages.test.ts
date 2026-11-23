// PDFs on whiteboards (#455, lib/whiteboard-pdf-pages.ts): page ranges as
// typed in the page picker, the pages an element shows and steps through,
// and the size a page is drawn at for the zoom (sharp, but within limits).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  currentPage,
  formatPageRanges,
  MAX_PIXELS,
  MAX_SIDE,
  parsePageRanges,
  pdfRenderWidth,
  shownPages,
  steppedPage,
  storedPages,
  zoomStep,
} from "../lib/whiteboard-pdf-pages";
import { boardExtras } from "../lib/whiteboard-embeds";

test("page ranges read like a print dialog's and write back short", () => {
  assert.deepEqual(parsePageRanges("1-3, 7", 10), [1, 2, 3, 7]);
  assert.deepEqual(parsePageRanges(" 7 ; 2–3,3 ", 10), [2, 3, 7]);
  assert.deepEqual(parsePageRanges("9-", 10), [9, 10]);
  assert.deepEqual(parsePageRanges("5-3", 10), [3, 4, 5]);
  assert.deepEqual(parsePageRanges("", 10), []);
  assert.equal(parsePageRanges("0", 10), null);
  assert.equal(parsePageRanges("11", 10), null);
  assert.equal(parsePageRanges("1-20", 10), null);
  assert.equal(parsePageRanges("abc", 10), null);
  assert.equal(formatPageRanges([7, 1, 2, 3, 3]), "1-3, 7");
  assert.equal(formatPageRanges([]), "");
  assert.deepEqual(parsePageRanges(formatPageRanges([1, 2, 5, 6, 9]), 9), [1, 2, 5, 6, 9]);
});

test("an element stores its pages only when they are not all of them", () => {
  assert.equal(storedPages([1, 2, 3], 3), undefined);
  assert.equal(storedPages([], 3), undefined);
  assert.deepEqual(storedPages([3, 1, 1, 9], 5), [1, 3]);
});

test("the page buttons step within the element's pages", () => {
  const item = { pages: [2, 5, 9], page: 5 };
  assert.deepEqual(shownPages(item, 10), [2, 5, 9]);
  assert.equal(currentPage(item, 10), 5);
  assert.equal(steppedPage(item, 10, 1), 9);
  assert.equal(steppedPage(item, 10, -1), 2);
  assert.equal(steppedPage({ pages: [2, 5, 9], page: 9 }, 10, 1), 9);
  // A stored page outside the element's pages shows its first page.
  assert.equal(currentPage({ pages: [2, 5], page: 7 }, 10), 2);
  // Without pages: every page of the document.
  assert.deepEqual(shownPages({ page: 2 }, 3), [1, 2, 3]);
  assert.equal(steppedPage({ page: 3 }, 3, 1), 3);
  // Pages beyond a shorter document (another file) are left out.
  assert.deepEqual(shownPages({ pages: [1, 8] }, 4), [1]);
});

test("pages and hidden annotations are stored properties of the board", () => {
  assert.deepEqual(boardExtras({ pages: [1, 3], hideInk: true }), { pages: [1, 3], hideInk: true });
  assert.deepEqual(boardExtras({ pages: [0, "x"] as unknown as number[], hideInk: "yes" as unknown as boolean }), {});
});

test("a page is drawn for its size on the screen: zoom and pixel ratio, in steps, within limits", () => {
  const box = { w: 360, h: 496 };
  const aspect = 595 / 842;
  const at100 = pdfRenderWidth({ box, pageAspect: aspect, zoom: 1, dpr: 1 });
  const at100x2 = pdfRenderWidth({ box, pageAspect: aspect, zoom: 1, dpr: 2 });
  const at300 = pdfRenderWidth({ box, pageAspect: aspect, zoom: 3, dpr: 2 });
  // Never less than shown (the old drawing was 360 px at any zoom).
  assert.ok(at100 >= 350);
  assert.ok(at100x2 >= 2 * 350);
  assert.ok(at300 >= 3 * 2 * 350 * 0.99 || at300 / aspect >= MAX_SIDE * 0.99 || at300 * (at300 / aspect) >= MAX_PIXELS * 0.98);
  // A little zoom draws nothing new; more draws sharper.
  assert.equal(pdfRenderWidth({ box, pageAspect: aspect, zoom: 1.04, dpr: 1 }), at100);
  assert.ok(pdfRenderWidth({ box, pageAspect: aspect, zoom: 1.3, dpr: 1 }) >= 1.3 * at100);
  assert.equal(zoomStep(1), 1);
  assert.equal(zoomStep(2), 2);
  assert.ok(Math.abs(zoomStep(1.3) - Math.SQRT2) < 1e-6);
  // Limits on the side and the area, at 4 × on a 3× screen.
  const huge = pdfRenderWidth({ box: { w: 2000, h: 2000 }, pageAspect: aspect, zoom: 4, dpr: 3 });
  assert.ok(huge / aspect <= MAX_SIDE + 1);
  assert.ok(huge * (huge / aspect) <= MAX_PIXELS);
  // Zoomed far out: still something to see.
  assert.ok(pdfRenderWidth({ box, pageAspect: aspect, zoom: 0.1, dpr: 1 }) >= 16);
});
