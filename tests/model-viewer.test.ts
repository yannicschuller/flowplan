// The 3D viewer (#384): which files it opens and with what type an upload
// is stored, its size limits, the measuring arithmetic and the standard
// views, the document block, and that the test fixtures are real files
// (the STEP box read by the same OpenCascade build the browser uses).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as Y from "yjs";
import {
  MB,
  MODEL_EXTENSIONS,
  MODEL_LIMITS,
  isCadFormat,
  isModelName,
  looksLikeModel,
  modelFormatOf,
  modelFormatOfFile,
  modelFormatOfMime,
  modelTooLarge,
  modelUnit,
  modelUploadMime,
} from "../lib/model-formats";
import { boxCenter, boxRadius, boxSize, fitDistance, formatBox, formatLength, measureDistance, roundLength, screenScale, viewDirection, zoomDistance, type Vec3 } from "../lib/model-geometry";
import { uploadMime } from "../lib/upload-safety";
import { stepBox, stlCube } from "./helpers/model-fixtures";

test("3D files are recognised by their extension, in any case", () => {
  const cases: [string, string | null][] = [
    ["Halter.stl", "stl"],
    ["teil.STL", "stl"],
    ["scan.obj", "obj"],
    ["szene.glb", "glb"],
    ["szene.gltf", "gltf"],
    ["druck.3mf", "3mf"],
    ["Gehäuse.step", "step"],
    ["Gehäuse.STP", "step"],
    ["alt.iges", "iges"],
    ["alt.igs", "iges"],
    ["  Abstand.stl  ", "stl"],
    ["notiz.txt", null],
    ["stl", null],
    ["model.stl.zip", null],
    ["", null],
  ];
  for (const [name, format] of cases) assert.equal(modelFormatOf(name), format, name);
  assert.equal(isModelName("a.3mf"), true);
  assert.equal(isModelName("a.pdf"), false);
  // DXF and DWG are drawings (2D, tests/drawing-viewer.test.ts).
  assert.deepEqual(MODEL_EXTENSIONS.sort(), [".3mf", ".dwg", ".dxf", ".glb", ".gltf", ".iges", ".igs", ".obj", ".step", ".stl", ".stp"]);
  assert.equal(isCadFormat("step"), true);
  assert.equal(isCadFormat("iges"), true);
  assert.equal(isCadFormat("stl"), false);
});

test("3D types: the stored model/* types, older aliases, type before name", () => {
  assert.equal(modelFormatOfMime("model/stl"), "stl");
  assert.equal(modelFormatOfMime("application/sla"), "stl");
  assert.equal(modelFormatOfMime("model/gltf-binary"), "glb");
  assert.equal(modelFormatOfMime("model/step; charset=x"), "step");
  assert.equal(modelFormatOfMime("application/octet-stream"), null);
  assert.equal(modelFormatOfFile({ name: "x.bin", mime: "model/3mf" }), "3mf");
  assert.equal(modelFormatOfFile({ name: "x.igs", mime: "application/octet-stream" }), "iges");
});

test("uploads named like 3D files get their type when the content fits", () => {
  const stl = stlCube();
  assert.equal(uploadMime("", "Würfel.stl", stl), "model/stl");
  assert.equal(uploadMime("application/octet-stream", "box.step", Buffer.from(stepBox())), "model/step");
  assert.equal(uploadMime("", "ascii.stl", Buffer.from("solid cube\nendsolid cube\n")), "model/stl");
  assert.equal(uploadMime("", "m.glb", Buffer.concat([Buffer.from("glTF"), Buffer.alloc(16)])), "model/gltf-binary");
  assert.equal(uploadMime("", "m.gltf", Buffer.from('{"asset":{"version":"2.0"}}')), "model/gltf+json");
  assert.equal(uploadMime("", "d.3mf", Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0])), "model/3mf");
  assert.equal(uploadMime("", "m.obj", Buffer.from("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n")), "model/obj");
  // Content that does not match the name: a plain download, never the claimed type.
  assert.equal(uploadMime("text/html", "fake.glb", Buffer.from("<html><script>alert(1)</script>")), "application/octet-stream");
  assert.equal(uploadMime("", "fake.step", Buffer.from("not a step file")), "application/octet-stream");
  assert.equal(uploadMime("", "fake.3mf", Buffer.from("plain")), "application/octet-stream");
  assert.equal(modelUploadMime("binary.obj", new Uint8Array([1, 0, 2, 3])), "application/octet-stream");
  // Other files keep the usual check.
  assert.equal(uploadMime("application/pdf", "a.pdf", Buffer.from("%PDF-1.7")), "application/pdf");
  assert.equal(uploadMime("image/png", "a.png", Buffer.from("no png")), "application/octet-stream");
  assert.equal(looksLikeModel("stl", new Uint8Array(10)), false);
});

test("size limits: 200 MB for meshes, 100 MB for STEP and IGES", () => {
  assert.equal(MODEL_LIMITS.mesh, 200 * MB);
  assert.equal(MODEL_LIMITS.cad, 100 * MB);
  assert.equal(modelTooLarge("stl", 200 * MB), null);
  assert.equal(modelTooLarge("stl", 200 * MB + 1), 200);
  assert.equal(modelTooLarge("glb", 150 * MB), null);
  assert.equal(modelTooLarge("step", 100 * MB), null);
  assert.equal(modelTooLarge("step", 101 * MB), 100);
  assert.equal(modelTooLarge("iges", 150 * MB), 100);
  // Without a known length (no Content-Length) nothing is refused up front.
  assert.equal(modelTooLarge("step", NaN), null);
});

test("units: CAD in millimetres, glTF in metres, 3MF as declared, STL/OBJ assumed", () => {
  assert.deepEqual(modelUnit("step"), { unit: "mm", assumed: false });
  assert.deepEqual(modelUnit("glb"), { unit: "m", assumed: false });
  assert.deepEqual(modelUnit("3mf"), { unit: "mm", assumed: false });
  assert.deepEqual(modelUnit("3mf", "inch"), { unit: "in", assumed: false });
  assert.deepEqual(modelUnit("3mf", "micron"), { unit: "µm", assumed: false });
  assert.deepEqual(modelUnit("stl"), { unit: "mm", assumed: true });
  assert.deepEqual(modelUnit("obj"), { unit: "mm", assumed: true });
});

test("measuring: the distance of two points, with a scale", () => {
  assert.equal(measureDistance([0, 0, 0], [3, 4, 0]), 5);
  assert.equal(measureDistance([1, 2, 3], [1, 2, 3]), 0);
  assert.equal(measureDistance([-10, -10, -10], [10, -10, -10]), 20);
  // A space diagonal of a 20 mm cube.
  assert.ok(Math.abs(measureDistance([-10, -10, -10], [10, 10, 10]) - 20 * Math.sqrt(3)) < 1e-9);
  // A model shown at a tenth of its size: scene distances times ten.
  assert.equal(measureDistance([0, 0, 0], [0, 0, 2.5], 10), 25);
  // glTF in metres shown in millimetres.
  assert.equal(measureDistance([0, 0, 0], [0.012, 0, 0], 1000), 12);
});

test("lengths are rounded to the size and written in the reader's notation", () => {
  assert.equal(roundLength(12.3456), 12.3);
  assert.equal(roundLength(1.23456), 1.23);
  assert.equal(roundLength(123.456), 123);
  assert.equal(roundLength(0.012345), 0.0123);
  assert.equal(roundLength(0), 0);
  assert.equal(formatLength(12.3456, "mm", "en"), "12.3 mm");
  assert.equal(formatLength(12.3456, "mm", "de-DE"), "12,3 mm");
  assert.equal(formatLength(20, "mm", "de-DE"), "20 mm");
  assert.equal(formatLength(1234.5, "mm", "en"), "1,235 mm");
  assert.equal(formatBox([30, 20, 10], "mm", "de-DE"), "30 × 20 × 10 mm");
  assert.equal(formatBox([0.5, 0.25, 1.75], "m", "en"), "0.5 × 0.25 × 1.75 m");
});

test("the bounding box: size, centre and radius", () => {
  const min: Vec3 = [-10, 0, 5],
    max: Vec3 = [20, 20, 15];
  assert.deepEqual(boxSize(min, max), [30, 20, 10]);
  assert.deepEqual(boxCenter(min, max), [5, 10, 10]);
  assert.ok(Math.abs(boxRadius(min, max) - Math.hypot(30, 20, 10) / 2) < 1e-9);
  assert.deepEqual(boxSize([1, 1, 1], [0, 0, 0]), [0, 0, 0]);
});

test("standard views: front, top, side and isometric for Z-up and Y-up models", () => {
  const close = (a: Vec3, b: Vec3) => a.every((v, i) => Math.abs(v - b[i]) < 1e-9);
  assert.deepEqual(viewDirection("front", "z"), { from: [0, -1, 0], up: [0, 0, 1] });
  assert.deepEqual(viewDirection("top", "z"), { from: [0, 0, 1], up: [0, 1, 0] });
  assert.deepEqual(viewDirection("right", "z"), { from: [1, 0, 0], up: [0, 0, 1] });
  const s = 1 / Math.sqrt(3);
  assert.ok(close(viewDirection("iso", "z").from, [s, -s, s]));
  assert.deepEqual(viewDirection("front", "y"), { from: [0, 0, 1], up: [0, 1, 0] });
  assert.deepEqual(viewDirection("top", "y"), { from: [0, 1, 0], up: [0, 0, -1] });
  assert.ok(close(viewDirection("iso", "y").from, [s, s, s]));
  // Every view's up is perpendicular to where it looks from (except iso).
  for (const up of ["y", "z"] as const)
    for (const view of ["front", "top", "right"] as const) {
      const d = viewDirection(view, up);
      assert.equal(d.from[0] * d.up[0] + d.from[1] * d.up[1] + d.from[2] * d.up[2], 0, `${view} ${up}`);
    }
});

test("fitting: the whole model in the view, also on a narrow phone screen", () => {
  // Sphere of radius r in a 40° view: r / sin(20°) without margin.
  assert.ok(Math.abs(fitDistance(10, 40, 1.5, 1) - 10 / Math.sin((20 * Math.PI) / 180)) < 1e-9);
  // Portrait: the narrower horizontal angle decides, so the camera stands farther.
  assert.ok(fitDistance(10, 40, 0.5) > fitDistance(10, 40, 1.5));
  assert.ok(fitDistance(0, 40, 1) > 0);
  // Zoom steps stay within a hundredth and twenty times the fitted distance.
  assert.equal(zoomDistance(100, 1, 100), 80);
  assert.equal(zoomDistance(100, -1, 100), 125);
  assert.equal(zoomDistance(1.1, 1, 100), 1);
  assert.equal(zoomDistance(1900, -1, 100), 2000);
  // Labels keep their size on the screen: 26 px of a 520 px view.
  assert.ok(Math.abs(screenScale(26, 520, 90) - 0.1) < 1e-9);
});

test("a 3D file block survives cleaning and saving as a document", async () => {
  const { cleanHtml, htmlState, stateHtml } = await import("../lib/document-server");
  const id = "0f5c6a1e-2b3c-4d5e-8f90-123456789abc";
  const block = `<div data-model="/api/files/${id}" data-title="Halter.step" class="model-block"><a href="/api/files/${id}">Halter.step</a></div>`;
  const clean = cleanHtml(`<p>Vorher</p>${block}<p>Nachher</p>`);
  assert.match(clean, new RegExp(`data-model="/api/files/${id}"`));
  const doc = new Y.Doc();
  Y.applyUpdate(doc, htmlState(clean));
  const html = stateHtml(doc);
  assert.match(html, new RegExp(`<div data-model="/api/files/${id}" data-title="Halter.step" class="model-block"><a href="/api/files/${id}"[^>]*>Halter.step</a></div>`));
  // The address comes from the inner link (rewritten like any link) …
  const other = "1a2b3c4d-2b3c-4d5e-8f90-123456789abc";
  const moved = new Y.Doc();
  Y.applyUpdate(moved, htmlState(`<div data-model="/api/files/${id}" data-title="a.stl"><a href="/api/files/${other}">a.stl</a></div>`));
  assert.match(stateHtml(moved), new RegExp(`data-model="/api/files/${other}"`));
  // … and only Flowplan files become 3D blocks.
  const foreign = new Y.Doc();
  Y.applyUpdate(foreign, htmlState(`<div data-model="https://example.com/x.stl" data-title="x.stl"><a href="https://example.com/x.stl">x.stl</a></div>`));
  assert.doesNotMatch(stateHtml(foreign), /data-model=/);
});

test("the fixtures: a binary STL cube and a STEP box OpenCascade reads", async () => {
  const stl = stlCube(20);
  assert.equal(stl.length, 84 + 12 * 50);
  assert.equal(stl.readUInt32LE(80), 12);
  const step = stepBox(30, 20, 10);
  assert.ok(step.length < 8 * 1024, `${step.length} bytes`);
  const require = createRequire(import.meta.url);
  const occt = await (require("occt-import-js") as () => Promise<{ ReadFile: (f: string, c: Uint8Array, p: unknown) => { success: boolean; meshes: { attributes: { position: { array: number[] } }; index: { array: number[] } }[] } }>)();
  const result = occt.ReadFile("step", new TextEncoder().encode(step), { linearUnit: "millimeter" });
  assert.equal(result.success, true);
  assert.equal(result.meshes.length, 1);
  const position = result.meshes[0].attributes.position.array;
  const min: Vec3 = [Infinity, Infinity, Infinity],
    max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < position.length; i += 3)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], position[i + k]);
      max[k] = Math.max(max[k], position[i + k]);
    }
  assert.deepEqual(boxSize(min, max).map((v) => Math.round(v * 1000) / 1000), [30, 20, 10]);
  // Six faces of two triangles each.
  assert.equal(result.meshes[0].index.array.length / 3, 12);
});
