// The logic behind the tool panels: eraser kinds (lib/ink/eraser.ts),
// favourite pens (lib/ink/favorites.ts) and small paper previews
// (lib/notebook-paper-thumb.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { InkItem, InkStroke, InkText } from "../lib/ink/model";
import { ERASER_SIZE, clampEraserSize, cleanEraserSetting, eraseHighlighter, eraseWith } from "../lib/ink/eraser";
import {
  DEFAULT_FAVORITES,
  MAX_FAVORITES,
  addFavorite,
  cleanFavorite,
  cleanFavorites,
  favoriteIndex,
  loadFavorites,
  moveFavorite,
  removeFavorite,
  sameFavorite,
  saveFavorites,
  type InkFavorite,
} from "../lib/ink/favorites";
import { paperLayout } from "../lib/notebook-paper";
import { thumbLayout } from "../lib/notebook-paper-thumb";

const stroke = (id: string, type: "pen" | "highlighter", pts: [number, number][], width = type === "pen" ? 1.6 : 14): InkStroke => ({
  id,
  type,
  color: type === "pen" ? "#1f1f1f" : "#ffd43b",
  width,
  points: pts.flatMap(([x, y]) => [x, y, 0.5]),
});
const text: InkText = { id: "t", type: "text", color: "#1f1f1f", size: 14, x: 40, y: 0, text: "Hallo" };

test("eraser: whole strokes, parts (split in two) and highlighter only", () => {
  const pen = stroke("p", "pen", [[0, 0], [100, 0]]);
  const marker = stroke("h", "highlighter", [[0, 0], [100, 0]]);
  const items: InkItem[] = [pen, marker, text];
  const at = [{ x: 50, y: 0 }];

  // Whole strokes: everything touched goes (text too).
  assert.deepEqual(eraseWith(items, at, "stroke", 3).map((i) => i.id), []);
  // Parts: the pen line is cut in two, the left piece keeps its id.
  const cut = eraseWith([pen], at, "partial", 5) as InkStroke[];
  assert.equal(cut.length, 2);
  assert.equal(cut[0].id, "p");
  assert.notEqual(cut[1].id, "p");
  const xs = (s: InkStroke) => s.points.filter((_, i) => i % 3 === 0);
  assert.ok(Math.max(...xs(cut[0])) < 50 - 5);
  assert.ok(Math.min(...xs(cut[1])) > 50 + 5);
  // Highlighter only: the pen ink and the text under it stay, in order.
  assert.deepEqual(eraseWith(items, at, "highlighter", 3).map((i) => i.id), ["p", "t"]);
  assert.deepEqual(eraseHighlighter(items, at, 3).map((i) => i.id), ["p", "t"]);
  // Nothing hit: the same array (no undo step, no save).
  for (const mode of ["stroke", "partial", "highlighter"] as const) assert.equal(eraseWith(items, [{ x: 50, y: 80 }], mode, 3), items);
  // A highlighter-only pass over pen ink alone changes nothing.
  const penOnly: InkItem[] = [pen];
  assert.equal(eraseWith(penOnly, at, "highlighter", 3), penOnly);
});

test("eraser: a bigger size takes a wider gap out of the stroke", () => {
  const pen = stroke("p", "pen", [[0, 0], [200, 0]], 0.8);
  const gap = (radius: number) => {
    const [a, b] = eraseWith([pen], [{ x: 100, y: 0 }], "partial", radius) as InkStroke[];
    return Math.min(...b.points.filter((_, i) => i % 3 === 0)) - Math.max(...a.points.filter((_, i) => i % 3 === 0));
  };
  assert.ok(gap(20) > gap(5) + 20);
});

test("eraser setting: cleaned and clamped", () => {
  assert.deepEqual(cleanEraserSetting(null), { mode: "stroke", size: ERASER_SIZE.default });
  assert.deepEqual(cleanEraserSetting({ mode: "highlighter", size: 400 }), { mode: "highlighter", size: ERASER_SIZE.max });
  assert.deepEqual(cleanEraserSetting({ mode: "laser", size: "x" }), { mode: "stroke", size: ERASER_SIZE.default });
  assert.equal(clampEraserSize(1), ERASER_SIZE.min);
  assert.equal(clampEraserSize(12.6), 13);
  assert.equal(clampEraserSize(NaN), ERASER_SIZE.default);
});

test("favourites: cleaned, compared, added, moved and removed", () => {
  const red: InkFavorite = { type: "pen", color: "#C2410C", width: 2.4 };
  const caveat: InkFavorite = { type: "text", color: "#1c5fd6", width: 18, font: "caveat" };
  assert.deepEqual(cleanFavorite(red), { type: "pen", color: "#c2410c", width: 2.4 });
  assert.equal(cleanFavorite({ type: "laser", color: "#000000", width: 1 }), null);
  assert.equal(cleanFavorite({ type: "pen", color: "red", width: 1 }), null);
  // Widths are clamped to the tool's range; a face only for text.
  assert.equal(cleanFavorite({ type: "pen", color: "#000000", width: 99 })!.width, 12);
  assert.equal(cleanFavorite({ type: "pen", color: "#000000", width: 2, font: "caveat" })!.font, undefined);
  assert.equal(cleanFavorite({ type: "text", color: "#000000", width: 18, font: "comic" })!.font, undefined);
  // Duplicates and anything beyond the limit drop out.
  const many = Array.from({ length: 12 }, (_, i) => ({ type: "pen", color: "#000000", width: 1 + i / 2 }));
  assert.equal(cleanFavorites([...many, many[0]]).length, MAX_FAVORITES);
  assert.deepEqual(cleanFavorites("nope"), []);

  assert.ok(sameFavorite(red, { type: "pen", color: "#c2410c", width: 2.41 }));
  assert.ok(!sameFavorite(red, { type: "highlighter", color: "#c2410c", width: 2.4 }));
  assert.ok(!sameFavorite(caveat, { ...caveat, font: "patrick" }));
  assert.ok(!sameFavorite(caveat, { ...caveat, font: undefined }));

  let list = DEFAULT_FAVORITES.slice();
  list = addFavorite(list, red);
  list = addFavorite(list, caveat);
  assert.equal(list.length, 5);
  assert.equal(addFavorite(list, red), list, "already there");
  assert.equal(favoriteIndex(list, { type: "text", color: "#1c5fd6", width: 18, font: "caveat" }), 4);
  assert.equal(favoriteIndex(list, null), -1);
  const full = cleanFavorites(many);
  assert.equal(addFavorite(full, red), full, "full");

  const moved = moveFavorite(list, 4, 0);
  assert.equal(moved[0].type, "text");
  assert.equal(moved.length, 5);
  assert.equal(moveFavorite(list, 1, 1), list);
  assert.equal(moveFavorite(list, 9, 0), list);
  assert.equal(moveFavorite(list, 0, 99)[4], list[0]);
  assert.deepEqual(removeFavorite(list, 0), list.slice(1));
  assert.equal(removeFavorite(list, 7), list);
});

test("favourites: the three pens of earlier versions become the first favourites once", () => {
  const store = new Map<string, string>();
  const g = globalThis as unknown as { localStorage?: unknown };
  const before = g.localStorage;
  g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
  try {
    // Nothing stored: the defaults.
    assert.deepEqual(loadFavorites(), DEFAULT_FAVORITES);
    // The old three pens.
    store.set("flowplan-ink-presets", JSON.stringify([{ type: "pen", color: "#e03131", width: 2 }, { type: "pen", color: "#1c5fd6", width: 1.6 }, { type: "highlighter", color: "#8ce99a", width: 22 }]));
    assert.deepEqual(loadFavorites().map((f) => f.color), ["#e03131", "#1c5fd6", "#8ce99a"]);
    // Once saved, the new list counts – also when it is empty.
    saveFavorites([]);
    assert.deepEqual(loadFavorites(), []);
    // The old key stays as it was for older versions.
    assert.ok(store.get("flowplan-ink-presets")!.includes("#e03131"));
  } finally {
    g.localStorage = before;
  }
});

test("paper thumbnails: lines keep a minimum width on the screen, crop shows the top left", () => {
  const layout = paperLayout({ template: "lined-college", size: "a4", orientation: "portrait", color: "light" });
  const { layout: small, viewBox } = thumbLayout(layout, { px: 50, minStroke: 1 });
  // 595 pt across 50 px: one pixel is about 11.9 pt.
  const rule = small.shapes.find((s) => s.type === "line")!;
  assert.ok(rule.type === "line" && rule.width > 11 && rule.width < 13);
  assert.equal(viewBox, `0 0 ${layout.width} ${layout.height}`);
  // Half the sheet: half as many points per pixel, half the view.
  const crop = thumbLayout(layout, { px: 50, minStroke: 1, crop: 0.5 });
  const cropRule = crop.layout.shapes.find((s) => s.type === "line")!;
  assert.ok(cropRule.type === "line" && cropRule.width > 5.5 && cropRule.width < 6.5);
  assert.equal(crop.viewBox, `0 0 ${Math.round(layout.width * 50) / 100} ${Math.round(layout.height * 50) / 100}`);
  // Large enough already: unchanged widths; the layout itself is untouched.
  const big = thumbLayout(layout, { px: 5000, minStroke: 0.5 });
  assert.equal((big.layout.shapes[0] as { width: number }).width, (layout.shapes[0] as { width: number }).width);
  assert.equal((layout.shapes[0] as { width: number }).width, 0.5);
  const dots = thumbLayout(paperLayout({ template: "dotted", size: "a4", orientation: "portrait", color: "dark" }), { px: 50, minStroke: 1 });
  assert.ok(dots.layout.shapes.every((s) => s.type === "dot" && s.r > 8));
});
