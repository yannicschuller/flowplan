// PDFs on whiteboards (#455): which pages an element shows, the page
// buttons within them, and how sharp a page is drawn.
//
// - `pages` of an embed element limits it to some pages of the PDF (chosen
//   when it was added, components/whiteboard/pdf-pages-dialog.tsx); absent,
//   every page. `page` is the page shown.
// - A page is drawn for the size it has on the screen: its size on the board
//   × zoom × device pixel ratio, the zoom in steps (so a little zooming
//   draws nothing new and drawings can be kept per step), at most MAX_SIDE
//   pixels on a side and MAX_PIXELS in all (memory, and the canvas limits
//   of mobile browsers).
import type { WhiteboardItem } from "./whiteboard-model";

export const MAX_PDF_PAGES_LIST = 2000;

// "1-3, 7" → [1, 2, 3, 7] (sorted, no duplicates); null when a part is
// not a page or range of the document. En and em dashes count as "-",
// semicolons as commas; "" is no page.
export function parsePageRanges(input: string, count: number): number[] | null {
  const out = new Set<number>();
  const parts = input
    .replace(/[–—]/g, "-")
    .split(/[,;]/)
    .map((p) => p.trim())
    .filter(Boolean);
  for (const part of parts) {
    const match = /^(\d+)\s*(?:-\s*(\d*))?$/.exec(part);
    if (!match) return null;
    const from = Number(match[1]);
    // "5-" runs to the end.
    const to = match[2] === undefined ? from : match[2] === "" ? count : Number(match[2]);
    if (from < 1 || to < 1 || from > count || to > count) return null;
    for (let n = Math.min(from, to); n <= Math.max(from, to); n++) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

// [1, 2, 3, 7] → "1-3, 7".
export function formatPageRanges(pages: readonly number[]): string {
  const sorted = [...new Set(pages)].filter((n) => Number.isInteger(n) && n > 0).sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(j > i ? `${sorted[i]}-${sorted[j]}` : String(sorted[i]));
    i = j;
  }
  return parts.join(", ");
}

// What is stored for a choice: nothing for every page, else the pages.
export function storedPages(pages: readonly number[], count: number): number[] | undefined {
  const list = [...new Set(pages)].filter((n) => Number.isInteger(n) && n >= 1 && n <= count).sort((a, b) => a - b);
  return list.length === 0 || list.length >= count ? undefined : list.slice(0, MAX_PDF_PAGES_LIST);
}

// The pages an element may show (all when `count` is not known yet: the
// stored ones, or just its page).
export function shownPages(item: Pick<WhiteboardItem, "pages" | "page">, count: number): number[] {
  const own = Array.isArray(item.pages) ? item.pages.filter((n) => Number.isInteger(n) && n >= 1 && (!count || n <= count)) : [];
  if (own.length) return [...new Set(own)].sort((a, b) => a - b);
  if (count > 0) return Array.from({ length: count }, (_, i) => i + 1);
  return [Math.max(1, Math.round(item.page || 1))];
}

// The page shown: the stored one when it is among the element's pages,
// else the first of them.
export function currentPage(item: Pick<WhiteboardItem, "pages" | "page">, count: number): number {
  const pages = shownPages(item, count);
  const page = Math.max(1, Math.round(item.page || pages[0]));
  return pages.includes(page) ? page : pages[0];
}

// The page after "next" / "prev" (stays at the ends).
export function steppedPage(item: Pick<WhiteboardItem, "pages" | "page">, count: number, direction: 1 | -1): number {
  const pages = shownPages(item, count);
  const at = pages.indexOf(currentPage(item, count));
  return pages[Math.max(0, Math.min(pages.length - 1, at + direction))];
}

// ---- drawing sharp ----

export const MAX_SIDE = 4096;
export const MAX_PIXELS = 12_000_000;
// Steps of the zoom a page is drawn for: powers of √2 (100 %, 141 %, 200 %,
// 283 % …), a zoom up to 5 % above a step still uses it.
const STEP = Math.SQRT2;
export function zoomStep(zoom: number) {
  const z = Math.max(0.05, Number.isFinite(zoom) ? zoom : 1);
  return Math.round(STEP ** Math.ceil(Math.log(z) / Math.log(STEP) - 0.15) * 1e6) / 1e6;
}

// The width in device pixels a page is drawn at: it fills `box` (CSS
// pixels on the board, `contain`) at the zoom's step and `dpr`, within the
// limits. `pageAspect` is width / height.
export function pdfRenderWidth({
  box,
  pageAspect,
  zoom,
  dpr,
}: {
  box: { w: number; h: number };
  pageAspect: number;
  zoom: number;
  dpr: number;
}): number {
  const aspect = pageAspect > 0 && Number.isFinite(pageAspect) ? pageAspect : 1 / Math.SQRT2;
  // The page as laid out inside the box.
  const shown = Math.max(1, Math.min(box.w, box.h * aspect));
  const width = Math.ceil(shown * zoomStep(zoom) * Math.max(1, Number.isFinite(dpr) ? dpr : 1));
  // Limits: the longer side, then the area.
  const height = width / aspect;
  const limit = Math.min(1, MAX_SIDE / Math.max(width, height), Math.sqrt(MAX_PIXELS / (width * height)));
  return Math.max(16, Math.floor(width * limit));
}
