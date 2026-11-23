import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { COVER_DRAWING, COVER_DRAWING_NAME, coverSvg, crc32, inkFromPng, isCoverDrawing, pngWithInk } from "../lib/cover-drawing";
import { emptyInk, parseInk, type InkDoc } from "../lib/ink/model";
import { stripLocation } from "../lib/upload-safety";

// "Draw your own cover" (design review): the drawing becomes a PNG of the
// whole canvas, with its ink inside so it can be changed again.

function chunk(type: string, data: Buffer) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "latin1"), data])));
  return Buffer.concat([head, data, crc]);
}
// A real 1 × 1 PNG.
function tinyPng() {
  const ihdr = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]);
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", deflateSync(Buffer.from([0, 255, 255, 255]))),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}
const drawing = (): InkDoc =>
  parseInk({
    ...emptyInk(),
    pages: {
      cover: [
        { type: "pen", id: "a1", color: "#e03131", width: 4, points: [10, 10, 0.5, 200, 120, 0.5, 400, 60, 0.5] },
        { type: "text", id: "b2", x: 600, y: 100, text: "Grüße <&> \"Plan\"", color: "#1f1f1f", size: 32 },
      ],
    },
  });

test("crc32 matches the PNG reference value", () => {
  assert.equal(crc32(new TextEncoder().encode("IEND")), 0xae426082);
});

test("the ink goes into the PNG and comes back the same", () => {
  const ink = drawing();
  assert.equal(ink.pages.cover.length, 2);
  const png = pngWithInk(tinyPng(), ink);
  // Still a PNG that ends with IEND, the ink chunk before it.
  assert.deepEqual([...png.subarray(png.length - 12 + 4, png.length - 4)].map((b) => String.fromCharCode(b)).join(""), "IEND");
  assert.deepEqual(inkFromPng(png), ink);
  // Saving again replaces the chunk instead of adding a second one.
  const again = pngWithInk(png, parseInk({ ...ink, pages: { cover: ink.pages.cover.slice(0, 1) } }));
  assert.equal(inkFromPng(again)?.pages.cover.length, 1);
  assert.equal(Buffer.from(again).toString("latin1").split("iTXt").length, 2);
});

test("the upload keeps the ink (only eXIf is dropped)", () => {
  const png = pngWithInk(tinyPng(), drawing());
  const stored = stripLocation(Buffer.from(png), "image/png");
  assert.deepEqual(inkFromPng(new Uint8Array(stored)), drawing());
});

test("other PNGs, damaged chunks and other files have no ink", () => {
  assert.equal(inkFromPng(tinyPng()), null);
  assert.equal(inkFromPng(new TextEncoder().encode("not a png")), null);
  const png = pngWithInk(tinyPng(), drawing());
  const broken = new Uint8Array(png);
  const at = Buffer.from(broken).indexOf("Grüße");
  broken[at] ^= 1;
  assert.equal(inkFromPng(broken), null);
  assert.deepEqual(pngWithInk(new TextEncoder().encode("GIF89a"), drawing()), new TextEncoder().encode("GIF89a"));
});

test("the SVG covers the whole canvas on white, text escaped", () => {
  const svg = coverSvg(drawing().pages.cover);
  assert.match(svg, new RegExp(`viewBox="0 0 ${COVER_DRAWING.width} ${COVER_DRAWING.height}" width="${COVER_DRAWING.width * 2}" height="${COVER_DRAWING.height * 2}"`));
  assert.match(svg, /<rect x="0" y="0" width="1200" height="400" fill="#ffffff"\/>/);
  assert.doesNotMatch(svg, /<&>/);
  assert.match(svg, /&lt;&amp;&gt;/);
  assert.match(coverSvg([], { background: "red;x" }), /fill="#ffffff"/);
});

test("drawn covers are known by their file name", () => {
  assert.equal(isCoverDrawing(COVER_DRAWING_NAME), true);
  assert.equal(isCoverDrawing("cover-drawing (2).png"), true);
  assert.equal(isCoverDrawing("Holiday.png"), false);
  assert.equal(isCoverDrawing(undefined), false);
});
