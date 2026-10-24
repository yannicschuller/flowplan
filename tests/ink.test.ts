// The ink engine (lib/ink): coordinates, the stored format, geometry
// (erasers, lasso, snapping), undo/redo, the Pencil setting and writing ink
// into a PDF.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument, degrees } from "pdf-lib";
import { samplePdf } from "./helpers/pdf";
import {
  applyMatrix,
  canvasSize,
  clientToPage,
  deviceToPage,
  pageToClient,
  pageToDevice,
  viewSize,
  viewToPdfMatrix,
} from "../lib/ink/coords";
import { INK_FORMAT, INK_LIMITS, emptyInk, hasInk, inkText, parseInk, serializeInk, withPage, type InkStroke, type InkText } from "../lib/ink/model";
import {
  copyItems,
  eraseItems,
  erasePartial,
  heldStill,
  hitItem,
  itemBounds,
  lassoItems,
  recolorItems,
  snapStroke,
  strokeOutline,
  strokePath,
  strokePoints,
  transformItems,
} from "../lib/ink/geometry";
import { emptyHistory, record, redo, undo } from "../lib/ink/history";
import { pencilResult } from "../lib/ink/presets";
import { flattenInk } from "../lib/ink/pdf-export";

const pen = (id: string, points: [number, number, number?][], extra: Partial<InkStroke> = {}): InkStroke => ({
  id,
  type: "pen",
  color: "#1f1f1f",
  width: 2,
  points: points.flatMap(([x, y, p = 0.5]) => [x, y, p]),
  ...extra,
});
const line = (id: string, x1: number, y1: number, x2: number, y2: number, steps = 20) =>
  pen(id, Array.from({ length: steps + 1 }, (_, i): [number, number] => [x1 + ((x2 - x1) * i) / steps, y1 + ((y2 - y1) * i) / steps]));

test("page units ↔ screen: independent of zoom", () => {
  const page = { width: 612, height: 792 };
  for (const zoom of [0.5, 1, 2.75]) {
    const rect = { left: 40, top: 100, width: 612 * zoom, height: 792 * zoom };
    const at = clientToPage(40 + 306 * zoom, 100 + 396 * zoom, rect, page);
    assert.deepEqual(at, { x: 306, y: 396 });
    const back = pageToClient(72, 144, rect, page);
    assert.deepEqual(clientToPage(back.x, back.y, rect, page), { x: 72, y: 144 });
  }
});

test("page units ↔ device pixels of a canvas at zoom and device pixel ratio", () => {
  const page = { width: 600, height: 800 };
  // 900 CSS px wide at ratio 2: 3 device px per point.
  assert.deepEqual(canvasSize(page, 900, 2), { width: 1800, height: 2400, scale: 3, ratio: 2 });
  assert.deepEqual(pageToDevice(100, 200, page, 900, 2), { x: 300, y: 600 });
  assert.deepEqual(deviceToPage(300, 600, page, 900, 2), { x: 100, y: 200 });
  // Ratios above 2 are drawn at 2 (as the PDF pages); 1 when unknown.
  assert.equal(canvasSize(page, 900, 3).ratio, 2);
  assert.equal(canvasSize(page, 300, 0).scale, 0.5);
  // The same point at another zoom: same page units.
  const a = deviceToPage(...(Object.values(pageToDevice(55.5, 70.25, page, 450, 1.5)) as [number, number]), page, 450, 1.5);
  assert.deepEqual(a, { x: 55.5, y: 70.25 });
});

test("the page as shown → PDF user space matches pdf.js for every rotation and a crop box", async () => {
  const pdf = await PDFDocument.create();
  for (const angle of [0, 90, 180, 270]) {
    const page = pdf.addPage([600, 800]);
    page.setCropBox(20, 30, 500, 700);
    page.setRotation(degrees(angle));
  }
  const bytes = await pdf.save();
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loaded = await pdfjs.getDocument({ data: bytes, verbosity: 0 }).promise;
  const box = { x: 20, y: 30, width: 500, height: 700 };
  for (const [i, angle] of [0, 90, 180, 270].entries()) {
    const viewport = (await loaded.getPage(i + 1)).getViewport({ scale: 1 });
    assert.deepEqual(viewSize(angle, box), { width: viewport.width, height: viewport.height }, `size at ${angle}°`);
    const m = viewToPdfMatrix(angle, box);
    for (const [x, y] of [
      [0, 0],
      [10, 20],
      [viewport.width, viewport.height],
      [123.4, 56.7],
    ]) {
      const [ux, uy] = viewport.convertToPdfPoint(x, y);
      const mine = applyMatrix(m, x, y);
      assert.ok(Math.abs(mine.x - ux) < 1e-6 && Math.abs(mine.y - uy) < 1e-6, `${angle}° (${x}, ${y}): ${JSON.stringify(mine)} ≠ ${ux}, ${uy}`);
    }
  }
  await loaded.loadingTask.destroy();
});

test("stored ink: parsed strictly, serialized in page order, typed text for search", () => {
  const doc = parseInk({
    format: INK_FORMAT,
    version: 1,
    pages: {
      "10": [{ id: "t1", type: "text", color: "#E03131", size: 14, x: 10, y: 20, text: "Freigabe" }],
      "2": [
        { id: "a", type: "pen", color: "#1f1f1f", width: 2, points: [1.234, 2.345, 0.5, 3, 4, 0.71, 5] },
        { id: "bad", type: "pen", color: "red", width: 2, points: ["x", 1, 2, 5, 5, 0.5] },
        { id: "empty", type: "pen", width: 2, points: [] },
        { type: "laser", points: [] },
        { id: "h", type: "highlighter", color: "#ffd43b", width: 14, points: [0, 0, 0.5, 100, 0, 0.5] },
        { id: "e", type: "text", text: "   ", x: 0, y: 0, size: 12 },
      ],
      "../x": [{ id: "z", type: "pen", width: 1, points: [0, 0, 0.5] }],
      "3": "nope",
    },
  });
  assert.deepEqual(Object.keys(doc.pages).sort(), ["10", "2"]);
  const first = doc.pages["2"][0] as InkStroke;
  // Rounded to two decimals; the incomplete triple at the end is dropped.
  assert.deepEqual(first.points, [1.23, 2.35, 0.5, 3, 4, 0.71]);
  // An invalid colour falls back, the stroke stays.
  assert.equal((doc.pages["2"][1] as InkStroke).color, "#1f1f1f");
  assert.equal(doc.pages["2"].length, 3);
  assert.equal((doc.pages["10"][0] as InkText).color, "#e03131");
  const json = serializeInk(doc);
  assert.ok(json.indexOf('"2"') < json.indexOf('"10"'));
  assert.deepEqual(parseInk(json), doc);
  assert.equal(inkText(doc), "Freigabe");
  assert.ok(hasInk(doc));
  assert.ok(!hasInk(withPage(withPage(doc, "2", []), "10", [])));
  // Garbage in, empty ink out.
  assert.deepEqual(parseInk("{not json"), emptyInk());
  assert.deepEqual(parseInk(null), emptyInk());
  // Limits hold.
  const many = parseInk({ pages: { "1": Array.from({ length: INK_LIMITS.itemsPerPage + 10 }, (_, i) => ({ id: `p${i}`, type: "pen", width: 1, points: [i, i, 0.5] })) } });
  assert.equal(many.pages["1"].length, INK_LIMITS.itemsPerPage);
});

test("strokes: outline with pressure, plain line without; hits and bounds", () => {
  const even = line("a", 0, 0, 100, 0);
  assert.equal(strokePath(even).fill, false);
  const pressed = pen("b", [
    [0, 0, 0.2],
    [50, 0, 0.9],
    [100, 0, 0.4],
  ]);
  assert.equal(strokePath(pressed).fill, true);
  const outline = strokeOutline(strokePoints(pressed), 2);
  // Thicker where pressed harder.
  const at = (x: number) => Math.max(...outline.filter(([px]) => Math.abs(px - x) < 0.01).map(([, y]) => Math.abs(y)));
  assert.ok(at(50) > at(0));
  assert.ok(hitItem(even, { x: 50, y: 2 }, 2));
  assert.ok(!hitItem(even, { x: 50, y: 10 }, 2));
  const box = itemBounds(even);
  assert.ok(box.x < 0 && box.w > 100);
});

test("erasers: whole strokes, or only the part under the eraser", () => {
  const items = [line("a", 0, 0, 100, 0), line("b", 0, 50, 100, 50)];
  assert.deepEqual(
    eraseItems(items, [{ x: 50, y: 1 }], 3).map((i) => i.id),
    ["b"],
  );
  // Nothing hit: the same list (no undo step).
  assert.equal(eraseItems(items, [{ x: 50, y: 25 }], 3), items);
  const cut = erasePartial(items, [{ x: 50, y: 0 }], 5);
  const parts = cut.filter((i) => i.type === "pen" && i.points[1] === 0) as InkStroke[];
  assert.equal(parts.length, 2);
  assert.equal(parts[0].id, "a");
  assert.notEqual(parts[1].id, "a");
  const xs = (s: InkStroke) => strokePoints(s).map((p) => p.x);
  assert.ok(Math.max(...xs(parts[0])) < 50 - 5);
  assert.ok(Math.min(...xs(parts[1])) > 50 + 5);
  // A line of only two points is cut too.
  const sparse = erasePartial([pen("s", [[0, 0], [100, 0]])], [{ x: 50, y: 0 }], 5);
  assert.equal(sparse.length, 2);
  // Text under the partial eraser goes as a whole.
  const text: InkText = { id: "t", type: "text", color: "#1f1f1f", size: 12, x: 0, y: 100, text: "Hallo" };
  assert.equal(erasePartial([text], [{ x: 5, y: 105 }], 3).length, 0);
});

test("lasso, move, resize, recolour and copy", () => {
  const items = [line("in", 10, 10, 40, 10), line("out", 200, 200, 260, 200), line("half", 30, 30, 200, 30)];
  const square = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
    { x: 0, y: 100 },
  ];
  // Most of a stroke inside counts; "half" is mostly outside.
  assert.deepEqual(lassoItems(items, square), ["in"]);
  const moved = transformItems(items, new Set(["in"]), { dx: 5, dy: 7 });
  assert.deepEqual(strokePoints(moved[0] as InkStroke)[0], { x: 15, y: 17, p: 0.5 });
  assert.equal(moved[1], items[1]);
  const scaled = transformItems(items, new Set(["in"]), { scale: 2, ox: 10, oy: 10 });
  assert.deepEqual(strokePoints(scaled[0] as InkStroke).at(-1), { x: 70, y: 10, p: 0.5 });
  assert.equal((scaled[0] as InkStroke).width, 4);
  assert.equal((recolorItems(items, new Set(["out"]), "#e03131")[1] as InkStroke).color, "#e03131");
  const copies = copyItems([items[0]], 12, 12);
  assert.notEqual(copies[0].id, "in");
  assert.equal(strokePoints(copies[0] as InkStroke)[0].x, 22);
});

test("holding the pen still snaps a stroke to a line or shape", () => {
  // A shaky, almost straight line becomes two points.
  const shaky = pen(
    "l",
    Array.from({ length: 30 }, (_, i): [number, number, number] => [i * 5, (i % 2) * 1.5, 0.4 + (i % 3) * 0.1]),
  );
  const straight = snapStroke(shaky)!;
  assert.equal(strokePoints(straight).length, 2);
  assert.equal(straight.id, "l");
  // A rough rectangle becomes a closed rectangle.
  const rough: [number, number][] = [];
  for (let x = 0; x <= 100; x += 5) rough.push([x, Math.sin(x) * 1.2]);
  for (let y = 0; y <= 60; y += 5) rough.push([100 + Math.sin(y), y]);
  for (let x = 100; x >= 0; x -= 5) rough.push([x, 60 + Math.cos(x)]);
  for (let y = 60; y >= 0; y -= 5) rough.push([Math.cos(y), y]);
  const rect = snapStroke(pen("r", rough))!;
  assert.equal(strokePoints(rect).length, 5);
  // A scribble stays as drawn.
  assert.equal(snapStroke(pen("z", [[0, 0], [50, 40], [10, 80], [60, 5], [5, 30], [70, 70]])), null);
  // The hold: no movement beyond the tolerance for the last 500 ms.
  const t0 = 1000;
  const samples = [
    { x: 0, y: 0, t: t0 },
    { x: 50, y: 0, t: t0 + 100 },
    { x: 50.5, y: 0.2, t: t0 + 300 },
    { x: 50.4, y: 0.1, t: t0 + 700 },
  ];
  assert.ok(heldStill(samples, t0 + 650, 500, 2));
  assert.ok(!heldStill(samples, t0 + 400, 500, 2));
  assert.ok(!heldStill([...samples, { x: 80, y: 0, t: t0 + 750 }], t0 + 800, 500, 2));
});

test("undo and redo keep whole states", () => {
  let h = emptyHistory<number>();
  h = record(h, 1);
  h = record(h, 2);
  const back = undo(h, 3)!;
  assert.equal(back.state, 2);
  const again = redo(back.history, 2)!;
  assert.equal(again.state, 3);
  assert.equal(undo(emptyHistory<number>(), 1), null);
  // A new change drops what could be redone.
  assert.deepEqual(record(back.history, 2).future, []);
  // The stack is bounded.
  let long = emptyHistory<number>();
  for (let i = 0; i < 300; i++) long = record(long, i, 200);
  assert.equal(long.past.length, 200);
});

test("Apple Pencil double-tap follows the setting", () => {
  assert.equal(pencilResult("system", { preferred: "switchEraser" }), "eraser");
  assert.equal(pencilResult("system", { preferred: "switchPrevious" }), "previous");
  assert.equal(pencilResult("system", { preferred: "ignore" }), null);
  assert.equal(pencilResult("system", { preferred: "showColorPalette" }), "pen");
  assert.equal(pencilResult("eraser", { preferred: "ignore" }), "eraser");
  assert.equal(pencilResult("previous", { preferred: "switchEraser" }), "previous");
  assert.equal(pencilResult("off", { preferred: "switchEraser" }), null);
});

test("download with annotations: the original pages with the ink as vectors on top", async () => {
  const original = samplePdf(["Seite eins", "Seite zwei", "Seite drei"]);
  const doc = withPage(
    withPage(emptyInk(), "2", [
      { id: "h", type: "highlighter", color: "#ffd43b", width: 14, points: [72, 80, 0.5, 200, 80, 0.5] },
      pen("p", [
        [100, 100, 0.2],
        [150, 160, 0.9],
        [220, 130, 0.5],
      ]),
      line("l", 50, 700, 300, 700),
      { id: "t", type: "text", color: "#e03131", size: 14, x: 72, y: 300, text: "Geprüft ✓ – OK\nZeile 2" },
    ]),
    "9",
    [line("beyond", 0, 0, 10, 10)],
  );
  const bytes = await flattenInk(original, doc);
  // The original bytes are untouched.
  assert.equal(Buffer.from(original).toString("latin1").includes("FlowplanInk"), false);
  const out = await PDFDocument.load(bytes);
  assert.equal(out.getPageCount(), 3);
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const [before, after] = await Promise.all(
    [original, bytes].map((data) => pdfjs.getDocument({ data: new Uint8Array(data), verbosity: 0, disableFontFace: true }).promise),
  );
  assert.equal(after.numPages, 3);
  const ops = async (d: typeof before, n: number) => (await (await d.getPage(n)).getOperatorList()).fnArray;
  // Page 1 and 3 have nothing more; page 2 has paths and text on top.
  assert.equal((await ops(after, 1)).length, (await ops(before, 1)).length);
  assert.equal((await ops(after, 3)).length, (await ops(before, 3)).length);
  const extra = await ops(after, 2);
  assert.ok(extra.length > (await ops(before, 2)).length + 5);
  const { OPS } = pdfjs;
  assert.ok(extra.includes(OPS.constructPath), "vector paths");
  assert.ok(extra.includes(OPS.setGState), "highlighter transparency");
  assert.ok(extra.includes(OPS.showText), "text");
  assert.ok(!extra.includes(OPS.paintImageXObject), "no raster image");
  // The typed text is in the page's text, original text still there.
  const text = (await (await after.getPage(2)).getTextContent()).items.map((i) => ("str" in i ? i.str : "")).join(" ");
  assert.match(text, /Seite zwei/);
  assert.match(text, /Gepr.ft \? . OK/);
  assert.match(text, /Zeile 2/);
  await before.loadingTask.destroy();
  await after.loadingTask.destroy();
});
