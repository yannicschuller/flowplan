import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LABEL_PRESETS,
  MAX_LABELS,
  PAPER_SIZE,
  clampSkip,
  itemLink,
  labelBox,
  labelSheetCss,
  labelSheets,
  labelsPerSheet,
  layoutProblem,
  presetLayout,
  slotPosition,
  type LabelLayout,
} from "../lib/qr-labels";
import { QR_MAX_BYTES, qrBytes, qrFits, qrModules } from "../lib/qr";
import { parsePageLocation } from "../lib/page-location";

// QR codes of pages and records and the label sheets of a database (#448).

const PAGE = "0b5c1d0e-3f4a-4c5b-8d6e-7f8091a2b3c4";
const ROW = "1c6d2e1f-4a5b-4d6c-9e7f-8091a2b3c4d5";

test("the code holds the address “Copy link” gives: origin, path, the page's hash", () => {
  assert.equal(itemLink("https://flow.example.org/", { pageId: PAGE }), `https://flow.example.org/#page=${PAGE}`);
  assert.equal(itemLink("https://flow.example.org/", { pageId: PAGE, rowId: ROW }), `https://flow.example.org/#page=${PAGE}&row=${ROW}`);
  // A hash or query of the current address never goes along.
  assert.equal(itemLink(`https://flow.example.org/#page=${ROW}&thread=x`, { pageId: PAGE }), `https://flow.example.org/#page=${PAGE}`);
  assert.equal(itemLink("https://flow.example.org/?join=abc", { pageId: PAGE }), `https://flow.example.org/#page=${PAGE}`);
  const url = itemLink("https://flow.example.org/", { pageId: PAGE, rowId: ROW });
  assert.deepEqual(parsePageLocation(new URL(url).hash), { pageId: PAGE, rowId: ROW });
  // Not an id: the safe fallback of pageLocationHash, never the text.
  assert.equal(itemLink("https://flow.example.org/", { pageId: "<script>" }), "https://flow.example.org/#inbox");
});

test("a record's address fits a code; one longer than 213 bytes is said so", () => {
  const url = itemLink("https://flowplan.some-company.example.com/", { pageId: PAGE, rowId: ROW });
  assert.ok(qrFits(url));
  assert.equal(qrBytes(url), 125);
  assert.equal(qrModules(url).length, 4 * 8 + 17, "version 8 for 125 bytes");
  assert.equal(QR_MAX_BYTES, 213);
  const longest = `https://${"a".repeat(QR_MAX_BYTES - 8)}`;
  assert.equal(qrBytes(longest), 213);
  assert.ok(qrFits(longest));
  assert.equal(qrModules(longest).length, 57, "version 10");
  assert.ok(!qrFits(`${longest}b`));
  assert.throws(() => qrModules(`${longest}b`));
  // Bytes, not characters: ü takes two.
  assert.equal(qrBytes("ü"), 2);
});

test("the presets fit their paper and match the makers' sheets", () => {
  for (const preset of LABEL_PRESETS) assert.equal(layoutProblem(preset.layout), null, preset.id);
  const a4x8 = presetLayout("a4-3x8")!;
  assert.equal(labelsPerSheet(a4x8), 24);
  assert.deepEqual(slotPosition(a4x8, 0), { x: 0, y: 0.5 });
  assert.deepEqual(slotPosition(a4x8, 2), { x: 140, y: 0.5 });
  assert.deepEqual(slotPosition(a4x8, 3), { x: 0, y: 37.5 });
  assert.deepEqual(slotPosition(a4x8, 23), { x: 140, y: 259.5 });
  const a4x7 = presetLayout("a4-3x7")!;
  assert.equal(labelsPerSheet(a4x7), 21);
  assert.deepEqual(slotPosition(a4x7, 20), { x: 140, y: 254.25 });
  // Avery L7163: 2 × 7 of 99.1 × 38.1 mm, 2.5 mm between the columns.
  const l7163 = presetLayout("a4-2x7")!;
  assert.equal(labelsPerSheet(l7163), 14);
  assert.deepEqual(slotPosition(l7163, 1), { x: 106.25, y: 15.15 });
  assert.deepEqual(slotPosition(l7163, 13), { x: 106.25, y: 243.75 });
  assert.ok(Math.abs(slotPosition(l7163, 1).x + l7163.width + l7163.marginLeft - PAPER_SIZE.a4.width) < 0.01, "centred");
  // Avery 5160: 3 × 10 of 2.625 × 1 in on Letter, ½ in from the top.
  const avery = presetLayout("letter-3x10")!;
  assert.equal(avery.paper, "letter");
  assert.equal(labelsPerSheet(avery), 30);
  assert.deepEqual(slotPosition(avery, 0), { x: 4.76, y: 12.7 });
  assert.deepEqual(slotPosition(avery, 1), { x: 74.61, y: 12.7 });
  assert.deepEqual(slotPosition(avery, 29), { x: 144.46, y: 241.3 });
  assert.equal(presetLayout("nope"), undefined);
});

test("records fill the sheets row by row; skipped places stay empty on the first sheet", () => {
  const layout = presetLayout("a4-3x8")!;
  const one = labelSheets(layout, 5);
  assert.equal(one.length, 1);
  assert.deepEqual(one[0].map((p) => [p.slot, p.record]), [[0, 0], [1, 1], [2, 2], [3, 3], [4, 4]]);
  const skipped = labelSheets(layout, 5, 22);
  assert.equal(skipped.length, 2);
  assert.deepEqual(skipped[0].map((p) => [p.slot, p.record]), [[22, 0], [23, 1]]);
  assert.deepEqual(skipped[1].map((p) => [p.slot, p.record]), [[0, 2], [1, 3], [2, 4]]);
  assert.deepEqual([skipped[1][0].x, skipped[1][0].y], [0, 0.5]);
  // 49 records: two full sheets and one label on a third.
  assert.deepEqual(labelSheets(layout, 49).map((s) => s.length), [24, 24, 1]);
  assert.deepEqual(labelSheets(layout, 0), []);
  // Skip stays within one sheet.
  assert.equal(clampSkip(layout, -3), 0);
  assert.equal(clampSkip(layout, 99), 23);
  assert.equal(clampSkip(layout, 2.7), 2);
  assert.equal(clampSkip(layout, NaN), 0);
});

test("at most MAX_LABELS labels in one print", () => {
  const layout = presetLayout("letter-3x10")!;
  assert.equal(MAX_LABELS, 1000);
  const sheets = labelSheets(layout, 5000);
  assert.equal(sheets.flat().length, MAX_LABELS);
  assert.equal(sheets.length, Math.ceil(MAX_LABELS / 30));
  assert.equal(sheets.flat().at(-1)!.record, MAX_LABELS - 1);
});

test("a custom layout is checked against its limits and its paper", () => {
  const custom: LabelLayout = { paper: "a4", columns: 4, rows: 10, width: 48.5, height: 25.4, marginTop: 21.5, marginLeft: 8, gapX: 0, gapY: 0 };
  assert.equal(layoutProblem(custom), null);
  assert.deepEqual(slotPosition(custom, 5), { x: 56.5, y: 46.9 });
  assert.deepEqual(layoutProblem({ ...custom, columns: 5 }), { kind: "width" });
  assert.deepEqual(layoutProblem({ ...custom, rows: 11 }), { kind: "height" });
  // Letter is narrower in height than A4: what fits A4 may not fit Letter.
  assert.deepEqual(layoutProblem({ ...custom, paper: "letter", rows: 10, marginTop: 30 }), { kind: "height" });
  assert.deepEqual(layoutProblem({ ...custom, columns: 2.5 }), { kind: "range", key: "columns" });
  assert.deepEqual(layoutProblem({ ...custom, width: 5 }), { kind: "range", key: "width" });
  assert.deepEqual(layoutProblem({ ...custom, gapX: NaN }), { kind: "range", key: "gapX" });
  assert.deepEqual(layoutProblem({ ...custom, marginTop: -1 }), { kind: "range", key: "marginTop" });
  // Half a millimetre of rounding is fine.
  assert.equal(layoutProblem({ ...custom, columns: 1, width: 202.4 }), null);
  assert.deepEqual(labelSheets(custom, 41, 39).map((s) => s.map((p) => p.slot)), [[39], Array.from({ length: 40 }, (_, i) => i)]);
});

test("code and text share a label: beside or below, the code never larger than the label", () => {
  const a4x8 = presetLayout("a4-3x8")!;
  const beside = labelBox(a4x8, "beside", 3);
  assert.ok(beside.code > 30 && beside.code <= a4x8.height - 2 * beside.pad);
  assert.equal(beside.codeX, beside.pad);
  assert.ok(beside.text.x >= beside.codeX + beside.code);
  assert.ok(beside.text.x + beside.text.width <= a4x8.width);
  const below = labelBox(a4x8, "below", 2);
  assert.ok(below.code + below.text.height + 2 * below.pad <= a4x8.height + 0.01);
  assert.ok(below.text.y >= below.codeY + below.code);
  assert.ok(Math.abs(below.codeX * 2 + below.code - a4x8.width) < 0.02, "centred");
  // Without text the code takes the label below.
  assert.equal(labelBox(a4x8, "below", 0).code, a4x8.height - 2 * labelBox(a4x8, "below", 0).pad);
  // A narrow label: the code is limited by the width.
  const narrow = labelBox({ width: 20, height: 60 }, "beside", 1);
  assert.ok(narrow.code <= (20 - 2 * narrow.pad) / 2 + 0.01);
});

test("the sheet's style sheet: numbers only, @page and page breaks only in print", () => {
  const layout = presetLayout("a4-2x7")!;
  const screen = labelSheetCss(layout, "beside", 2, false);
  assert.match(screen, /\.qrl-page\{width:calc\(210 \* var\(--u\)\);height:calc\(297 \* var\(--u\)\)\}/);
  assert.match(screen, /\.qrl-s13\{left:calc\(106\.25 \* var\(--u\)\);top:calc\(243\.75 \* var\(--u\)\)\}/);
  assert.doesNotMatch(screen, /\.qrl-s14\{/);
  assert.doesNotMatch(screen, /@page/);
  const print = labelSheetCss(presetLayout("letter-3x10")!, "below", 1, true);
  assert.match(print, /@page\{size:215\.9mm 279\.4mm;margin:0\}/);
  assert.match(print, /break-after:page/);
  assert.match(print, /text-align:center/);
  assert.doesNotMatch(print, /[<>]/);
});
