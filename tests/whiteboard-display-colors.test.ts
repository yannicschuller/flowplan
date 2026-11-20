// The dark whiteboard canvas (#399, lib/whiteboard-display-colors.ts): how
// stored colours are shown on it – very dark ink light, light fills toned
// down, text readable (WCAG AA) on the shown fill, mid colours unchanged –
// and that the maps are idempotent and leave invalid input alone.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AA_CONTRAST,
  DARK_CANVAS,
  DARK_PALETTE,
  LIGHT_PALETTE,
  boardPalette,
  contrastRatio,
  darkFill,
  darkInk,
  darkLine,
  darkMarkup,
  darkText,
  formatColor,
  luminance,
  parseColor,
  readableOn,
} from "../lib/whiteboard-display-colors";
import { fillColors, stickyColors, strokeColors } from "../lib/whiteboard-model";

const lum = (c: string) => luminance(parseColor(c)!);
// Every colour of a coarse RGB grid, with and without alpha.
const grid: string[] = [];
for (let r = 0; r <= 255; r += 51) for (let g = 0; g <= 255; g += 51) for (let b = 0; b <= 255; b += 51) grid.push(formatColor({ r, g, b, a: 1 }));
grid.push(...grid.slice(0, 40).map((c) => `${c}80`));

test("colours are parsed in the usual notations", () => {
  assert.deepEqual(parseColor("#fff"), { r: 255, g: 255, b: 255, a: 1 });
  assert.deepEqual(parseColor("#000000"), { r: 0, g: 0, b: 0, a: 1 });
  assert.deepEqual(parseColor("#1F2937"), { r: 31, g: 41, b: 55, a: 1 });
  assert.equal(parseColor("#0008")!.a.toFixed(2), "0.53");
  assert.equal(parseColor("#11223380")!.a.toFixed(2), "0.50");
  assert.deepEqual(parseColor("rgb(10, 20, 30)"), { r: 10, g: 20, b: 30, a: 1 });
  assert.deepEqual(parseColor("rgba(10,20,30,0.5)"), { r: 10, g: 20, b: 30, a: 0.5 });
  assert.deepEqual(parseColor("rgb(100% 0% 0% / 50%)"), { r: 255, g: 0, b: 0, a: 0.5 });
  assert.deepEqual(parseColor("Black"), { r: 0, g: 0, b: 0, a: 1 });
  assert.deepEqual(parseColor("white"), { r: 255, g: 255, b: 255, a: 1 });
  assert.equal(parseColor("transparent")!.a, 0);
  for (const bad of ["", "#12", "#12345", "#ggg", "nope", "url(#x)", "var(--x)", "currentColor", "none", "rgb(1,2)", null, undefined, 7, {}])
    assert.equal(parseColor(bad), null, String(bad));
});

test("black and very dark ink turns light, keeping its hue; mid and light colours stay", () => {
  for (const dark of ["#000000", "#000", "black", "#1f2937", "#212529", "#343a40", "#495057", "navy", "#2b0000"]) {
    const shown = darkInk(dark);
    assert.ok(lum(shown) > 0.2, `${dark} → ${shown}`);
    assert.ok(contrastRatio(shown, DARK_CANVAS) >= AA_CONTRAST, `${dark} readable on the canvas`);
  }
  assert.notEqual(darkInk("#000000"), "#ffffff", "near-white, not glaring white");
  // The hue is kept: dark red stays reddish.
  const red = parseColor(darkInk("#5c0000"))!;
  assert.ok(red.r > red.g && red.r > red.b);
  for (const mid of ["#e03131", "#f08c00", "#2f9e44", "#1971c2", "#7048e8", "#c2255c", "#868e96", "#ffffff", "#fff6b6", "red"])
    assert.equal(darkInk(mid), mid, mid);
  // The board's stroke palette: only the default near-black changes.
  assert.deepEqual(strokeColors.filter((c) => darkInk(c) !== c), ["#1f2937"]);
});

test("light fills are toned down – darker, less saturated, the hue kept; mid and dark fills stay", () => {
  for (const light of [...stickyColors, ...fillColors.filter((c) => c !== "transparent"), "white", "#fff"]) {
    const shown = darkFill(light);
    assert.ok(lum(shown) < 0.1, `${light} → ${shown} is dark`);
    assert.ok(lum(shown) > lum(DARK_CANVAS), `${light} → ${shown} stands out from the canvas`);
    const before = parseColor(light)!,
      after = parseColor(shown)!;
    // HSL saturation.
    const sat = (c: typeof before) => {
      const max = Math.max(c.r, c.g, c.b) / 255,
        min = Math.min(c.r, c.g, c.b) / 255;
      return max === min ? 0 : (max - min) / (1 - Math.abs(max + min - 1));
    };
    assert.ok(sat(after) <= sat(before) + 0.02, `${light} less saturated`);
  }
  // Yellow notes stay yellowish (red and green above blue).
  const yellow = parseColor(darkFill("#fff6b6"))!;
  assert.ok(yellow.r > yellow.b && yellow.g > yellow.b);
  for (const keep of ["#e03131", "#f08c00", "#1971c2", "#000000", "#1f2937", "#495057", "transparent"]) assert.equal(darkFill(keep), keep, keep);
});

test("text on every sticky note and fill colour reaches 4.5:1 against the shown fill", () => {
  for (const fill of [...stickyColors, ...fillColors, "#e03131", "#f08c00", "#2f9e44", "#1971c2", "#000000", "#ffffff"]) {
    const shown = darkFill(fill);
    for (const text of ["#1f2937", "#000000", "#ffffff", ...strokeColors]) {
      const color = darkText(text, shown);
      assert.ok(contrastRatio(color, shown) >= AA_CONTRAST - 1e-9, `${text} on ${fill} (${shown}) → ${color}: ${contrastRatio(color, shown).toFixed(2)}`);
    }
  }
  // The default text on a yellow note reads light.
  assert.ok(lum(darkText("#1f2937", darkFill("#fff6b6"))) > 0.4);
  // Dark text on a mid fill that already reads well stays as it is.
  assert.equal(darkText("#1f2937", "#f08c00"), "#1f2937");
  // Text without a fill stands on the canvas.
  assert.ok(contrastRatio(darkText("#1f2937"), DARK_CANVAS) >= AA_CONTRAST);
  assert.ok(contrastRatio(darkText("#e03131", "transparent"), DARK_CANVAS) >= AA_CONTRAST);
});

test("readableOn nudges the lightness as little as needed and falls back to black or white", () => {
  assert.equal(readableOn("#ffffff", "#000000"), "#ffffff");
  const nudged = readableOn("#e03131", "#16151b");
  assert.ok(contrastRatio(nudged, "#16151b") >= AA_CONTRAST);
  assert.ok(contrastRatio(nudged, "#16151b") < 5.5, "not more than needed");
  const red = parseColor(nudged)!;
  assert.ok(red.r > red.g, "still red");
  // Asking for more than any shade can give: black or white.
  assert.match(readableOn("#808080", "#808080", 30), /^#(ffffff|000000)$/);
  assert.equal(readableOn("nope", "#000"), "nope");
});

test("the maps are idempotent: a shown colour shows as itself", () => {
  for (const c of [...grid, ...stickyColors, ...strokeColors, ...fillColors, "black", "white", "navy"]) {
    assert.equal(darkInk(darkInk(c)), darkInk(c), `ink ${c}`);
    assert.equal(darkFill(darkFill(c)), darkFill(c), `fill ${c}`);
    assert.equal(darkLine(darkLine(c)), darkLine(c), `line ${c}`);
    // What a line becomes is not dark enough to be remapped as ink.
    if (darkLine(c) !== c) assert.equal(darkInk(darkLine(c)), darkLine(c), `line as ink ${c}`);
  }
  const markup = '<rect fill="#ffffff" stroke="#1f2937"/><path stroke="#dee2e6"/><text fill="#495057">x</text>';
  assert.equal(darkMarkup(darkMarkup(markup)), darkMarkup(markup));
});

test("alpha is kept", () => {
  const ink = parseColor(darkInk("#00000080"))!;
  assert.equal(ink.a.toFixed(2), "0.50");
  assert.ok(ink.r > 150);
  const fill = parseColor(darkFill("rgba(255, 255, 255, 0.5)"))!;
  assert.equal(fill.a.toFixed(2), "0.50");
  assert.ok(fill.r < 100);
  assert.equal(darkInk("#0000"), "#0000", "fully transparent stays");
  assert.equal(darkFill("transparent"), "transparent");
});

test("invalid input is returned unchanged", () => {
  for (const bad of ["", "nope", "url(#wb-grid)", "var(--text)", "currentColor", "none", "#12", "linear-gradient(red, blue)"]) {
    assert.equal(darkInk(bad), bad);
    assert.equal(darkFill(bad), bad);
    assert.equal(darkLine(bad), bad);
    assert.equal(darkText(bad, "#000"), bad);
  }
  assert.equal(darkText("#1f2937", "nope"), darkText("#1f2937", "nope"), "an unknown background does not throw");
});

test("drawn markup is mapped by role; kept colours and other attributes stay", () => {
  const out = darkMarkup(
    '<rect width="10" fill="#ffffff" stroke="#1f2937" stroke-width="2"/><circle fill="#c8d2e0"/><path stroke="#dee2e6"/><text x="1" fill="#495057">Lane</text><g fill="url(#p)"/>',
    ["#c8d2e0"],
  );
  assert.match(out, /<rect width="10" fill="(#[0-9a-f]{6})" stroke="(#[0-9a-f]{6})" stroke-width="2"\/>/);
  const [, fill, stroke] = /<rect width="10" fill="(#[0-9a-f]{6})" stroke="(#[0-9a-f]{6})"/.exec(out)!;
  assert.equal(fill, darkFill("#ffffff"));
  assert.equal(stroke, darkInk("#1f2937"));
  assert.match(out, /<circle fill="#c8d2e0"\/>/, "kept");
  assert.match(out, new RegExp(`<path stroke="${darkLine("#dee2e6")}"/>`), "light rules toned like lines");
  const text = /<text x="1" fill="(#[0-9a-f]{6})">Lane<\/text>/.exec(out)![1];
  assert.ok(contrastRatio(text, DARK_CANVAS) >= AA_CONTRAST, "text readable");
  assert.match(out, /<g fill="url\(#p\)"\/>/);
});

test("the light palette shows everything as stored; the dark one maps", () => {
  assert.equal(boardPalette(false), LIGHT_PALETTE);
  assert.equal(boardPalette(true), DARK_PALETTE);
  for (const c of ["#000000", "#fff6b6", "#e03131"]) {
    assert.equal(LIGHT_PALETTE.ink(c), c);
    assert.equal(LIGHT_PALETTE.fill(c), c);
    assert.equal(LIGHT_PALETTE.text(c, "#ffffff"), c);
    assert.equal(DARK_PALETTE.ink(c), darkInk(c));
    assert.equal(DARK_PALETTE.fill(c), darkFill(c));
  }
  assert.equal(DARK_PALETTE.text("#1f2937", darkFill("#fff6b6")), darkText("#1f2937", darkFill("#fff6b6")));
  assert.equal(LIGHT_PALETTE.markup('<rect fill="#fff"/>'), '<rect fill="#fff"/>');
});
