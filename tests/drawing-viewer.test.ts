// The drawing viewer for DXF and DWG (#384): which files it opens and with
// what type an upload is stored, the size limits, the units ($INSUNITS),
// the AutoCAD colours (BYLAYER, BYBLOCK), block transforms, the curves,
// snapping and measuring, the layer list, a DXF plan read end to end, and
// the DWG path through the same LibreDWG build the browser uses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { MB, MODEL_LIMITS, isDrawingFormat, looksLikeModel, modelFormatOf, modelFormatOfFile, modelFormatOfMime, modelTooLarge, modelUploadMime } from "../lib/model-formats";
import { uploadMime } from "../lib/upload-safety";
import {
  SnapIndex,
  apply,
  arcPoints,
  bulgePoints,
  ellipsePoints,
  fitView,
  insertTransform,
  matAngle,
  matScale,
  measure,
  multiply,
  polylinePoints,
  splinePoints,
  toScreen,
  toWorld,
  zoomAt,
  type Pt,
} from "../lib/drawing-geometry";
import { BYBLOCK, BYLAYER, DWG_READABLE, INK, aciColor, drawingUnit, dwgVersion, mtextAnchor, plainMText, plainText, resolveColor, textAnchor } from "../lib/drawing-model";
import { buildScene, initialVisibility, layerCounts, setAllLayers, shownBatches, shownBounds, shownTexts, toggleLayer, type DrawingScene } from "../lib/drawing-scene";
import { decodeDxf, isBinaryDxf, readDxf } from "../lib/drawing-dxf";
import { readDwgDatabase } from "../lib/drawing-dwg";
import { dxfPlan, fakeDwg } from "./helpers/drawing-fixtures";

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;
const nearPt = (a: Pt, b: Pt, eps = 1e-6) => near(a.x, b.x, eps) && near(a.y, b.y, eps);
// Every point of a scene's batches (drawing coordinates), per layer name.
function pointsOf(scene: DrawingScene, layer?: string) {
  const out: Pt[] = [];
  for (const b of scene.batches) {
    if (layer !== undefined && scene.layers[b.layer].name !== layer) continue;
    for (let i = 0; i < b.points.length; i += 2) out.push({ x: b.points[i] + scene.origin[0], y: b.points[i + 1] + scene.origin[1] });
  }
  return out;
}

test("drawings are recognised by their extension and type", () => {
  assert.equal(modelFormatOf("Grundriss.dxf"), "dxf");
  assert.equal(modelFormatOf("Grundriss.DWG"), "dwg");
  assert.equal(modelFormatOf("plan.dwg.bak"), null);
  assert.equal(isDrawingFormat("dxf"), true);
  assert.equal(isDrawingFormat("dwg"), true);
  assert.equal(isDrawingFormat("step"), false);
  assert.equal(isDrawingFormat(null), false);
  assert.equal(modelFormatOfMime("model/vnd.dxf"), "dxf");
  assert.equal(modelFormatOfMime("image/vnd.dxf"), "dxf");
  assert.equal(modelFormatOfMime("application/dxf"), "dxf");
  assert.equal(modelFormatOfMime("image/vnd.dwg"), "dwg");
  assert.equal(modelFormatOfMime("application/acad"), "dwg");
  assert.equal(modelFormatOfFile({ name: "x.bin", mime: "model/vnd.dwg" }), "dwg");
});

test("uploads: DXF by its SECTION header, DWG by its AC10xx version, else a download", () => {
  const dxf = Buffer.from(dxfPlan());
  assert.equal(uploadMime("", "Plan.dxf", dxf), "model/vnd.dxf");
  assert.equal(uploadMime("application/octet-stream", "plan.dxf", Buffer.from("  0\r\nSECTION\r\n  2\r\nHEADER\r\n")), "model/vnd.dxf");
  assert.equal(uploadMime("", "binary.dxf", Buffer.from("AutoCAD Binary DXF\r\n\u001a\u0000")), "model/vnd.dxf");
  assert.equal(uploadMime("", "plan.dwg", fakeDwg("AC1032")), "model/vnd.dwg");
  assert.equal(uploadMime("", "alt.dwg", fakeDwg("AC1009")), "model/vnd.dwg");
  assert.equal(uploadMime("", "uralt.dwg", fakeDwg("AC2.10")), "model/vnd.dwg");
  // Content that does not match the name: a plain download.
  assert.equal(uploadMime("text/html", "fake.dxf", Buffer.from("<html><script>alert(1)</script>")), "application/octet-stream");
  assert.equal(uploadMime("", "fake.dwg", Buffer.from("%PDF-1.7 not a drawing")), "application/octet-stream");
  assert.equal(modelUploadMime("leer.dwg", new Uint8Array()), "application/octet-stream");
  assert.equal(looksLikeModel("dxf", new TextEncoder().encode("hello world")), false);
});

test("size limits: 100 MB for DXF, 50 MB for DWG", () => {
  assert.equal(MODEL_LIMITS.dxf, 100 * MB);
  assert.equal(MODEL_LIMITS.dwg, 50 * MB);
  assert.equal(modelTooLarge("dxf", 100 * MB), null);
  assert.equal(modelTooLarge("dxf", 100 * MB + 1), 100);
  assert.equal(modelTooLarge("dwg", 50 * MB), null);
  assert.equal(modelTooLarge("dwg", 60 * MB), 50);
  assert.equal(modelTooLarge("dwg", NaN), null);
});

test("units: $INSUNITS to the unit's symbol and its millimetres", () => {
  assert.deepEqual(drawingUnit(4), { symbol: "mm", mm: 1 });
  assert.deepEqual(drawingUnit(1), { symbol: "in", mm: 25.4 });
  assert.deepEqual(drawingUnit(2), { symbol: "ft", mm: 304.8 });
  assert.deepEqual(drawingUnit(5), { symbol: "cm", mm: 10 });
  assert.deepEqual(drawingUnit(6), { symbol: "m", mm: 1000 });
  assert.equal(drawingUnit(13)?.symbol, "µm");
  assert.ok(near(drawingUnit(21)!.mm, 304.8006096));
  // Unitless, missing and unknown values: plain drawing units.
  assert.equal(drawingUnit(0), null);
  assert.equal(drawingUnit(undefined), null);
  assert.equal(drawingUnit(99), null);
});

test("AutoCAD colours: the index, true colours, BYLAYER, BYBLOCK and ink", () => {
  assert.equal(aciColor(1), 0xff0000);
  assert.equal(aciColor(2), 0xffff00);
  assert.equal(aciColor(3), 0x00ff00);
  assert.equal(aciColor(5), 0x0000ff);
  assert.equal(aciColor(8), 0x808080);
  assert.equal(aciColor(30), 0xff7f00);
  assert.equal(aciColor(250), 0x333333);
  assert.equal(aciColor(255), 0xffffff);
  assert.equal(aciColor(0), null);
  assert.equal(aciColor(256), null);
  const red = { aci: 1 };
  // Own colour, layer colour, block colour; 7 is ink (black or white by the paper).
  assert.equal(resolveColor({ aci: 3 }, red), 0x00ff00);
  assert.equal(resolveColor({ aci: BYLAYER }, red), 0xff0000);
  assert.equal(resolveColor({ aci: BYLAYER }, { aci: 7 }), INK);
  assert.equal(resolveColor({ aci: BYLAYER }, { aci: -1 }), 0xff0000);
  assert.equal(resolveColor({ aci: BYBLOCK }, red, 0x0000ff), 0x0000ff);
  assert.equal(resolveColor({ aci: BYBLOCK }, red), INK);
  assert.equal(resolveColor({ aci: 7 }, red), INK);
  assert.equal(resolveColor({ aci: 257, rgb: 0x123456 }, red), 0x123456);
  assert.equal(resolveColor({ aci: BYLAYER }, { aci: 257, rgb: 0xabcdef }), 0xabcdef);
});

test("DWG versions by the file's first bytes", () => {
  assert.deepEqual(dwgVersion(fakeDwg("AC1032")), { code: "AC1032", release: "2018" });
  assert.deepEqual(dwgVersion(fakeDwg("AC1015")), { code: "AC1015", release: "2000" });
  assert.deepEqual(dwgVersion(fakeDwg("AC1009")), { code: "AC1009", release: "R11/R12" });
  assert.deepEqual(dwgVersion(fakeDwg("AC1099")), { code: "AC1099", release: null });
  assert.equal(dwgVersion(Buffer.from("SECTION")), null);
  assert.equal(DWG_READABLE.has("AC1032"), true);
  assert.equal(DWG_READABLE.has("AC1003"), false);
});

test("text: control codes of TEXT, formatting of MTEXT, alignment", () => {
  assert.equal(plainText("%%c 12 %%p0,1 45%%d %%uunten%%u 100%%%"), "⌀ 12 ±0,1 45° unten 100%");
  assert.equal(plainText("\\U+00C4rger"), "Ärger");
  assert.deepEqual(plainMText("{\\fArial|b1;Fett}\\PZweite \\H2.5x;Zeile"), ["Fett", "Zweite Zeile"]);
  assert.deepEqual(plainMText("\\A1;1\\S1/2;\\~mm"), ["11/2\u00a0mm"]);
  assert.deepEqual(plainMText("C:\\\\Pfad \\{x\\}"), ["C:\\Pfad {x}"]);
  assert.deepEqual(textAnchor(0, 0), { h: 0, v: "baseline" });
  assert.deepEqual(textAnchor(1, 2), { h: 1, v: "middle" });
  assert.deepEqual(textAnchor(2, 3), { h: 2, v: "top" });
  assert.deepEqual(textAnchor(4, 0), { h: 1, v: "middle" });
  assert.deepEqual(mtextAnchor(1), { h: 0, v: "top" });
  assert.deepEqual(mtextAnchor(5), { h: 1, v: "middle" });
  assert.deepEqual(mtextAnchor(9), { h: 2, v: "bottom" });
});

test("block transforms: base point, scale, rotation, arrays and nesting", () => {
  // A block with base (1, 1) at (10, 20), scaled 2, turned 90°.
  const m = insertTransform({ x: 10, y: 20 }, 2, 2, Math.PI / 2, { x: 1, y: 1 });
  assert.ok(nearPt(apply(m, { x: 1, y: 1 }), { x: 10, y: 20 }));
  assert.ok(nearPt(apply(m, { x: 2, y: 1 }), { x: 10, y: 22 }));
  assert.ok(nearPt(apply(m, { x: 1, y: 2 }), { x: 8, y: 20 }));
  assert.ok(near(matScale(m), 2));
  assert.ok(near(matAngle(m), Math.PI / 2));
  // Mirrored in x (negative scale).
  assert.ok(nearPt(apply(insertTransform({ x: 0, y: 0 }, -1, 1, 0), { x: 3, y: 4 }), { x: -3, y: 4 }));
  // Array copies are offset in the rotated frame.
  const copy = insertTransform({ x: 0, y: 0 }, 1, 1, Math.PI / 2, { x: 0, y: 0 }, { x: 5, y: 0 });
  assert.ok(nearPt(apply(copy, { x: 0, y: 0 }), { x: 0, y: 5 }));
  // Nesting: the outer transform applies after the inner one.
  const outer = insertTransform({ x: 100, y: 0 }, 1, 1, 0),
    inner = insertTransform({ x: 0, y: 10 }, 3, 3, 0);
  assert.ok(nearPt(apply(multiply(outer, inner), { x: 1, y: 1 }), { x: 103, y: 13 }));
});

test("curves: bulges, arcs, ellipses and splines as points", () => {
  // A bulge of 1 is a half circle; tan(22.5°) a quarter circle (counter-clockwise).
  const half = bulgePoints({ x: 0, y: 0 }, { x: 10, y: 0 }, 1);
  assert.ok(nearPt(half[half.length - 1], { x: 10, y: 0 }));
  assert.ok(half.every((p) => near(Math.hypot(p.x - 5, p.y), 5, 1e-9)));
  assert.ok(Math.min(...half.map((p) => p.y)) < -4.99, "counter-clockwise from (0,0) to (10,0) goes below");
  const quarter = bulgePoints({ x: 10, y: 0 }, { x: 0, y: 10 }, Math.tan(Math.PI / 8));
  assert.ok(quarter.every((p) => near(Math.hypot(p.x, p.y), 10, 1e-9)));
  const cw = bulgePoints({ x: 10, y: 0 }, { x: 0, y: 10 }, -Math.tan(Math.PI / 8));
  assert.ok(cw.every((p) => near(Math.hypot(p.x - 10, p.y - 10), 10, 1e-9)), "clockwise: centre on the other side");
  // A closed square polyline returns to its start.
  const square = polylinePoints([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], true);
  assert.equal(square.length, 5);
  assert.deepEqual(square[4], { x: 0, y: 0 });
  // An arc from 350° to 10° goes through 0°, not the long way round.
  const arc = arcPoints({ x: 0, y: 0 }, 1, (350 * Math.PI) / 180, (10 * Math.PI) / 180);
  assert.ok(arc.every((p) => p.x > 0.98));
  // An ellipse with a 6-long major axis on x and ratio 0.5.
  const ellipse = ellipsePoints({ x: 0, y: 0 }, { x: 6, y: 0 }, 0.5, 0, Math.PI * 2);
  assert.ok(near(Math.max(...ellipse.map((p) => p.x)), 6));
  assert.ok(near(Math.max(...ellipse.map((p) => p.y)), 3, 1e-3));
  // A clamped cubic B-spline passes through its end control points.
  const spline = splinePoints(3, [{ x: 0, y: 0 }, { x: 1, y: 2 }, { x: 3, y: 2 }, { x: 4, y: 0 }], [0, 0, 0, 0, 1, 1, 1, 1]);
  assert.ok(nearPt(spline[0], { x: 0, y: 0 }));
  assert.ok(nearPt(spline[spline.length - 1], { x: 4, y: 0 }));
  assert.ok(nearPt(spline[Math.floor(spline.length / 2)], { x: 2, y: 1.5 }, 0.05));
  // Without control points: the fit points.
  assert.deepEqual(splinePoints(3, [], [], undefined, [{ x: 1, y: 1 }, { x: 2, y: 3 }]), [{ x: 1, y: 1 }, { x: 2, y: 3 }]);
});

test("snapping: the nearest end within the radius, else none; measuring", () => {
  const points = new Float64Array([0, 0, 100, 0, 100, 50, 0, 50, 50.5, 25]);
  const index = new SnapIndex(points);
  assert.deepEqual(index.nearest(1, -1, 3), { x: 0, y: 0 });
  assert.deepEqual(index.nearest(99, 49, 3), { x: 100, y: 50 });
  assert.deepEqual(index.nearest(50, 25, 3), { x: 50.5, y: 25 });
  assert.equal(index.nearest(25, 25, 3), null);
  // A huge radius (zoomed far out) still finds the nearest one.
  assert.deepEqual(index.nearest(-1000, -1000, 1e6), { x: 0, y: 0 });
  assert.equal(new SnapIndex(new Float64Array()).nearest(0, 0, 10), null);
  // Many points: the grid answers like a full search.
  const many = new Float64Array(20000);
  for (let i = 0; i < many.length; i++) many[i] = ((i * 7919) % 1000) / 10;
  const big = new SnapIndex(many);
  for (const [x, y] of [[12.3, 45.6], [99, 1], [50, 50]]) {
    let best: Pt | null = null,
      bestD = 2 * 2;
    for (let i = 0; i < many.length; i += 2) {
      const d = (many[i] - x) ** 2 + (many[i + 1] - y) ** 2;
      if (d <= bestD) {
        bestD = d;
        best = { x: many[i], y: many[i + 1] };
      }
    }
    const found = big.nearest(x, y, 2);
    assert.equal(found && Math.hypot(found.x - x, found.y - y), best && Math.hypot(best.x - x, best.y - y));
  }
  assert.deepEqual(measure({ x: 0, y: 0 }, { x: 30, y: 40 }), { distance: 50, dx: 30, dy: 40 });
  assert.deepEqual(measure({ x: 100, y: 50 }, { x: 0, y: 50 }), { distance: 100, dx: 100, dy: 0 });
});

test("the view: fit in the middle, zoom about the pointer, screen and world", () => {
  const view = fitView([0, 0, 100, 50], 1000, 600, 0);
  assert.equal(view.scale, 10);
  assert.deepEqual(toScreen(view, { x: 50, y: 25 }), { x: 500, y: 300 });
  // y up in the drawing, down on the screen.
  assert.deepEqual(toScreen(view, { x: 0, y: 50 }), { x: 0, y: 50 });
  assert.deepEqual(toWorld(view, { x: 1000, y: 550 }), { x: 100, y: 0 });
  // A tall viewport: the height decides.
  assert.equal(fitView([0, 0, 100, 50], 400, 1000, 0).scale, 4);
  const zoomed = zoomAt(view, 2, { x: 250, y: 100 });
  assert.equal(zoomed.scale, 20);
  assert.ok(nearPt(toWorld(zoomed, { x: 250, y: 100 }), toWorld(view, { x: 250, y: 100 })));
  // Nothing to show: a neutral view, not NaN.
  assert.deepEqual(fitView(null, 800, 600), { scale: 1, x: 400, y: 300 });
});

test("a DXF plan: layers, colours, blocks, text, hatch, linetype, units", () => {
  const drawing = readDxf(dxfPlan());
  assert.equal(drawing.units, 4);
  assert.deepEqual(drawing.lineTypes.DASHED, [4, -2]);
  const scene = buildScene(drawing);
  // The room is the drawing's extent.
  assert.ok(scene.bounds);
  const [x0, y0, x1, y1] = scene.bounds!;
  assert.ok(near(x0 + scene.origin[0], 0) && near(y0 + scene.origin[1], 0) && near(x1 + scene.origin[0], 100) && near(y1 + scene.origin[1], 50), JSON.stringify(scene.bounds));
  const names = scene.layers.map((l) => l.name);
  assert.equal(names[0], "0");
  for (const name of ["Wände", "Möbel", "Achsen", "Bemaßung", "Aus", "Gefroren"]) assert.ok(names.includes(name), name);
  const layer = (name: string) => scene.layers[names.indexOf(name)];
  // Off and frozen layers are hidden at first; the others shown.
  assert.equal(layer("Aus").visible, false);
  assert.equal(layer("Gefroren").visible, false);
  assert.equal(layer("Wände").visible, true);
  assert.equal(layer("Wände").color, 0xff0000);
  assert.equal(layer("0").color, INK);
  // The room in its layer's red.
  const walls = scene.batches.filter((b) => scene.layers[b.layer].name === "Wände" && b.kind === "stroke");
  assert.ok(walls.some((b) => b.color === 0xff0000));
  // The solid hatch in grey (index 8), filled.
  assert.ok(scene.batches.some((b) => b.kind === "fill" && b.color === 0x808080));
  // The dashed axis: DASHED (4, −2) from its layer.
  const axis = scene.batches.find((b) => scene.layers[b.layer].name === "Achsen");
  assert.deepEqual(axis?.dash, [4, 2]);
  // Chair 1 on layer 0: BYBLOCK rectangle in ink at (10, 10)–(20, 16).
  const ink = pointsOf(scene, "0");
  assert.ok(ink.some((p) => nearPt(p, { x: 20, y: 16 })), "first chair's corner");
  // Chair 2 at (60, 20), ×2, 90°, blue on "Möbel": the rectangle's corner
  // (10, 6) goes to (60 − 12, 20 + 20); BYBLOCK takes the reference's blue.
  const furniture = scene.batches.filter((b) => scene.layers[b.layer].name === "Möbel");
  assert.ok(furniture.some((b) => b.color === 0x0000ff));
  assert.ok(pointsOf(scene, "Möbel").some((p) => nearPt(p, { x: 48, y: 40 })), "second chair's corner");
  // Its circle (centre (5, 3), r 2) on its own layer "Möbel" (BYLAYER: blue
  // index 5) at (60 − 6, 20 + 10) with radius 4.
  assert.ok(pointsOf(scene, "Möbel").some((p) => nearPt(p, { x: 54 + 4, y: 30 }, 1e-4)));
  // Texts: the TEXT with ⌀, the MTEXT in two lines.
  const texts = scene.texts.map((t) => t.lines.join("|"));
  assert.ok(texts.includes("Wohnzimmer ⌀ 12"));
  assert.ok(texts.includes("Erste Zeile|Zweite Zeile"));
  // The dimension's block is drawn (a line at y = 45 on "Bemaßung").
  assert.ok(pointsOf(scene, "Bemaßung").some((p) => nearPt(p, { x: 100, y: 45 })));
  // Snap points: the room's corners and the arc's ends.
  const snaps = new SnapIndex(scene.snaps);
  const at = (x: number, y: number) => snaps.nearest(x - scene.origin[0], y - scene.origin[1], 0.5);
  assert.ok(at(100, 50) && at(0, 0) && at(85, 40) && at(80, 45));
});

test("the layer list: toggling, all on or off, what is drawn and fitted", () => {
  const scene = buildScene(readDxf(dxfPlan()));
  const names = scene.layers.map((l) => l.name);
  let visible = initialVisibility(scene.layers);
  const walls = names.indexOf("Wände");
  const before = shownBatches(scene, visible).length;
  visible = toggleLayer(visible, walls);
  assert.equal(visible[walls], false);
  assert.ok(shownBatches(scene, visible).length < before);
  assert.ok(shownBatches(scene, visible).every((b) => b.layer !== walls));
  // Without the room and the dimension the fitted box is smaller than the room.
  const dimension = names.indexOf("Bemaßung");
  const box = shownBounds(scene, toggleLayer(visible, dimension))!;
  assert.ok(box[2] - box[0] < 100, JSON.stringify(box));
  visible = toggleLayer(visible, walls);
  assert.equal(visible[walls], true);
  // All off: nothing drawn, fit falls back to the whole drawing.
  const off = setAllLayers(visible, false);
  assert.equal(shownBatches(scene, off).length, 0);
  assert.equal(shownTexts(scene, off).length, 0);
  assert.deepEqual(shownBounds(scene, off), scene.bounds);
  // All on: also the layers that were off and frozen.
  const on = setAllLayers(visible, true);
  assert.ok(on.every(Boolean));
  assert.ok(shownBatches(scene, on).some((b) => names[b.layer] === "Gefroren"));
  const counts = layerCounts(scene);
  assert.ok(counts[walls] >= 2, "room and arc");
  assert.ok(counts[names.indexOf("Aus")] >= 1);
});

test("DXF: mirrored entities, text encodings, binary DXF, nested blocks and the point budget", () => {
  // An arc and a circle with the extrusion (0, 0, −1): x mirrored.
  const mirrored = readDxf(
    dxfPlan({
      extraEntities: [
        [0, "CIRCLE"],
        [8, "0"],
        [10, 10],
        [20, 10],
        [30, 0],
        [40, 1],
        [210, 0],
        [220, 0],
        [230, -1],
      ],
    }),
  );
  const circle = mirrored.entities.find((e) => e.type === "circle" && e.layer === "0");
  assert.deepEqual(circle && circle.type === "circle" ? circle.c : null, { x: -10, y: 10 });
  // Windows-1252 text from an older AutoCAD.
  const latin = Buffer.from(dxfPlan().replace("Wohnzimmer %%c 12", "Küche"), "latin1");
  assert.ok(decodeDxf(latin).includes("Küche"));
  assert.ok(decodeDxf(Buffer.from(dxfPlan().replace("Wohnzimmer", "Küche"), "utf8")).includes("Küche"));
  assert.equal(isBinaryDxf(Buffer.from("AutoCAD Binary DXF\r\n\u001a\u0000")), true);
  assert.equal(isBinaryDxf(Buffer.from(dxfPlan())), false);
  assert.throws(() => readDxf("this is not a drawing"));
  // A block that inserts itself stops at the nesting limit.
  const drawing = readDxf(dxfPlan());
  drawing.blocks.Loop = { base: { x: 0, y: 0 }, entities: [{ type: "line", layer: "0", color: { aci: 7 }, a: { x: 0, y: 0 }, b: { x: 1, y: 0 } }, { type: "insert", layer: "0", color: { aci: 7 }, block: "Loop", at: { x: 1, y: 0 }, sx: 1, sy: 1, rotation: 0, columns: 1, rows: 1, columnSpacing: 0, rowSpacing: 0 }] };
  drawing.entities.push({ type: "insert", layer: "0", color: { aci: 7 }, block: "Loop", at: { x: 0, y: 1 }, sx: 1, sy: 1, rotation: 0, columns: 1, rows: 1, columnSpacing: 0, rowSpacing: 0 });
  const scene = buildScene(drawing);
  assert.ok(scene.entities < 1000);
  // A stray block reference miles away (as LibreDWG reads some broken
  // ones) does not shrink the fitted drawing to a dot.
  const stray = readDxf(dxfPlan());
  for (let i = 0; i < 300; i++) stray.entities.push({ type: "line", layer: "0", color: { aci: 256 }, a: { x: 10 + (i % 80), y: 10 }, b: { x: 10 + (i % 80), y: 40 } });
  stray.entities.push({ type: "insert", layer: "Möbel", color: { aci: 256 }, block: "Stuhl", at: { x: 0, y: 0 }, sx: 3000, sy: -1800, rotation: 5, columns: 1, rows: 1, columnSpacing: 0, rowSpacing: 0 });
  const strayScene = buildScene(stray);
  const strayBox = shownBounds(strayScene, initialVisibility(strayScene.layers))!;
  assert.ok(strayBox[2] - strayBox[0] < 300 && strayBox[3] - strayBox[1] < 300, JSON.stringify(strayBox));
  assert.ok(strayBox[2] - strayBox[0] >= 100, "the room stays whole");
  // Past the point budget the rest is left out, and said.
  const small = buildScene(readDxf(dxfPlan()), 200);
  assert.equal(small.truncated, true);
  assert.ok(small.batches.reduce((n, b) => n + b.points.length / 2, 0) <= 200);
});

test("DWG: LibreDWG's database (as the browser's build converts it) becomes the same model", () => {
  const db = {
    header: { INSUNITS: 1, LTSCALE: 2 },
    tables: {
      LAYER: {
        entries: [
          { name: "0", colorIndex: 7, color: 0xffffff, off: false, frozen: false, lineType: "Continuous" },
          // LibreDWG fills `color` with white for indexed layer colours.
          { name: "Tür", colorIndex: 2, color: 0xffffff, off: false, frozen: false, lineType: "HIDDEN" },
          { name: "Alt", colorIndex: 4, off: true, frozen: false },
        ],
      },
      LTYPE: { entries: [{ name: "HIDDEN", pattern: [{ elementLength: 0.25 }, { elementLength: -0.125 }] }] },
      BLOCK_RECORD: {
        entries: [
          {
            name: "*Model_Space",
            entities: [
              { type: "LINE", layer: "Tür", colorIndex: 256, startPoint: { x: 0, y: 0, z: 0 }, endPoint: { x: 36, y: 0, z: 0 } },
              { type: "LWPOLYLINE", layer: "0", colorIndex: 1, flag: 512, vertices: [{ x: 0, y: 0, bulge: 0 }, { x: 10, y: 0, bulge: 0 }, { x: 10, y: 10, bulge: 0 }] },
              { type: "ARC", layer: "0", colorIndex: 3, center: { x: 5, y: 5 }, radius: 2, startAngle: 0, endAngle: Math.PI / 2, extrusionDirection: { x: 0, y: 0, z: -1 } },
              { type: "TEXT", layer: "0", colorIndex: 256, text: "%%c 4", startPoint: { x: 1, y: 2 }, textHeight: 0.5, rotation: Math.PI / 2, halign: 0, valign: 0 },
              { type: "MTEXT", layer: "0", colorIndex: 256, text: "A\\PB", insertionPoint: { x: 3, y: 3 }, textHeight: 1, attachmentPoint: 5, direction: { x: 0, y: 1, z: 0 } },
              {
                type: "INSERT",
                layer: "Tür",
                colorIndex: 5,
                name: "Fenster",
                insertionPoint: { x: 20, y: 0 },
                xScale: 2,
                yScale: 2,
                rotation: 0,
                columnCount: 2,
                rowCount: 1,
                columnSpacing: 5,
                rowSpacing: 0,
                attribs: [{ type: "ATTRIB", layer: "Tür", colorIndex: 256, flags: 0, text: { text: "F1", startPoint: { x: 20, y: 5 }, textHeight: 0.4, rotation: 0, halign: 0, valign: 0 } }],
              },
              { type: "HATCH", layer: "0", colorIndex: 8, solidFill: 1, boundaryPaths: [{ boundaryPathTypeFlag: 1, edges: [{ type: 1, start: { x: 0, y: 0 }, end: { x: 1, y: 0 } }, { type: 2, center: { x: 1, y: 1 }, radius: 1, startAngle: -Math.PI / 2, endAngle: Math.PI / 2, isCCW: true }, { type: 1, start: { x: 1, y: 2 }, end: { x: 0, y: 0 } }] }] },
              { type: "LINE", layer: "Alt", colorIndex: 256, startPoint: { x: 0, y: 0 }, endPoint: { x: 1, y: 1 } },
              { type: "3DSOLID", layer: "0" },
              { type: "LINE", layer: "0", isInPaperSpace: true, startPoint: { x: 0, y: 0 }, endPoint: { x: 999, y: 999 } },
            ],
          },
          { name: "*Paper_Space", entities: [{ type: "LINE", layer: "0", startPoint: { x: 0, y: 0 }, endPoint: { x: 500, y: 500 } }] },
          { name: "Fenster", basePoint: { x: 0, y: 0 }, entities: [{ type: "LINE", layer: "0", colorIndex: 0, startPoint: { x: 0, y: 0 }, endPoint: { x: 1, y: 0 } }] },
        ],
      },
    },
  };
  const drawing = readDwgDatabase(db);
  assert.equal(drawing.units, 1);
  assert.deepEqual(drawing.skipped, { "3DSOLID": 1 });
  const scene = buildScene(drawing);
  const names = scene.layers.map((l) => l.name);
  assert.equal(scene.layers[names.indexOf("Tür")].color, 0xffff00, "index 2, not the white `color`");
  assert.equal(scene.layers[names.indexOf("Alt")].visible, false);
  // HIDDEN from the layer, times $LTSCALE 2.
  const door = scene.batches.find((b) => names[b.layer] === "Tür" && b.color === 0xffff00);
  assert.deepEqual(door?.dash, [0.5, 0.25]);
  // The block twice (array of two columns), BYBLOCK in the reference's blue,
  // on the reference's layer (its entity is on layer 0).
  const windows = pointsOf(scene, "Tür").filter((p) => near(p.y, 0) && p.x >= 20);
  assert.ok(windows.some((p) => nearPt(p, { x: 22, y: 0 })) && windows.some((p) => nearPt(p, { x: 25, y: 0 })) && windows.some((p) => nearPt(p, { x: 27, y: 0 })));
  assert.ok(scene.batches.some((b) => names[b.layer] === "Tür" && b.color === 0x0000ff));
  // The closed polyline (DWG's flag 512) returns to its start.
  const red = scene.batches.find((b) => b.color === 0xff0000)!;
  assert.equal(red.points.length / 2, 4);
  // The mirrored arc: centre (−5, 5).
  assert.ok(pointsOf(scene, "0").some((p) => nearPt(p, { x: -5 + 2 * Math.cos(Math.PI - Math.PI / 2), y: 5 + 2 }, 1e-6)));
  // Texts: TEXT with ⌀ and its rotation, MTEXT along its direction, the attribute.
  const text = scene.texts.find((t) => t.lines[0] === "⌀ 4")!;
  assert.ok(near(text.rotation, Math.PI / 2));
  const mtext = scene.texts.find((t) => t.lines.join() === "A,B")!;
  assert.ok(near(mtext.rotation, Math.PI / 2));
  assert.deepEqual(mtext.anchor, { h: 1, v: "middle" });
  assert.ok(scene.texts.some((t) => t.lines[0] === "F1"));
  // The hatch with a line and a half circle, filled grey.
  assert.ok(scene.batches.some((b) => b.kind === "fill" && b.color === 0x808080));
  // Paper space is left out: the bounds stay within the model.
  assert.ok(scene.bounds![2] + scene.origin[0] < 100);
});

// The LibreDWG build the browser loads (app/libredwg), in Node.
async function libredwg() {
  const root = join(process.cwd(), "node_modules", "@mlightcad", "libredwg-web");
  const { LibreDwg } = (await import(pathToFileURL(join(root, "dist", "libredwg-web.js")).href)) as {
    LibreDwg: { create(path?: string): Promise<{ FS: { writeFile(n: string, d: Uint8Array): void; unlink(n: string): void }; dwg_read_file(n: string): { error: number; data: number }; convert(d: number): unknown; dwg_free(d: number): void }> };
  };
  return LibreDwg.create(join(root, "wasm"));
}

test("DWG: a file LibreDWG cannot read gives a critical error (the viewer then suggests DXF)", async () => {
  const lib = await libredwg();
  for (const version of ["AC1032", "AC1015", "AC1003"]) {
    lib.FS.writeFile("broken.dwg", fakeDwg(version));
    const result = lib.dwg_read_file("broken.dwg");
    lib.FS.unlink("broken.dwg");
    // From 128 on: nothing usable (the worker's CRITICAL mask).
    assert.ok(result.error & ~127, `${version}: ${result.error}`);
  }
});

// No DWG sample is committed: none was found whose licence allows it, and
// this LibreDWG build cannot write DWG files to make one. Point
// FLOWPLAN_DWG_SAMPLE at a DWG file (e.g. one exported from a CAD program)
// to read it with the same build and check it draws something.
const SAMPLE = process.env.FLOWPLAN_DWG_SAMPLE || "";
test("DWG: a real drawing read by LibreDWG (FLOWPLAN_DWG_SAMPLE)", { skip: !SAMPLE || !existsSync(SAMPLE) ? "set FLOWPLAN_DWG_SAMPLE to a DWG file to run this" : false }, async () => {
  const lib = await libredwg();
  const bytes = readFileSync(SAMPLE);
  assert.ok(dwgVersion(bytes), "a DWG header");
  lib.FS.writeFile("sample.dwg", bytes);
  const result = lib.dwg_read_file("sample.dwg");
  lib.FS.unlink("sample.dwg");
  assert.equal(result.error & ~127, 0, `LibreDWG error ${result.error}`);
  const scene = buildScene(readDwgDatabase(lib.convert(result.data) as Parameters<typeof readDwgDatabase>[0]));
  lib.dwg_free(result.data);
  assert.ok(scene.bounds, "something to draw");
  assert.ok(scene.batches.length > 0);
  assert.ok(scene.layers.length > 0);
});
