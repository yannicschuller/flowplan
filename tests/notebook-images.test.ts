// Pictures and stickers on notebook sheets (lib/ink/model.ts InkImage,
// lib/ink/image.ts, lib/ink/stickers.ts) and own paper templates
// (lib/notebook-paper.ts PaperImage): the stored form, the frame's
// geometry (resize, rotate, crop, order), how erasers, lasso and merges
// treat them, and the SVG and PDF exports.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { PDFDocument } from "pdf-lib";
import { cleanItem, emptyInk, inkFiles, INK_LIMITS, mapInkFiles, parseInk, serializeInk, withPage, type InkImage, type InkItem } from "../lib/ink/model";
import {
  cropImage,
  fullBox,
  hitImage,
  imageAt,
  imageBounds,
  imageCorners,
  placeImage,
  resizeImage,
  rotateImage,
  toBack,
  toFront,
  uncropImage,
} from "../lib/ink/image";
import { eraseItems, erasePartial, itemBounds, lassoItems, recolorItems, transformItems } from "../lib/ink/geometry";
import { mergePage } from "../lib/ink/merge";
import { itemAt, rotation, scaling, setItemsWidth, sharedWidthStep, transformSelected } from "../lib/ink/selection";
import { eraseWith } from "../lib/ink/eraser";
import { inkSvg } from "../lib/ink/svg";
import { drawInk, imageMatrix, inkPdfContext } from "../lib/ink/pdf-export";
import { notebookPdf, notebookPdfSheets } from "../lib/ink/notebook-pdf";
import { STICKERS, stampItems, stickerSvg, stickerTintable } from "../lib/ink/stickers";
import { cleanPaper, DEFAULT_PAPER, effectivePaper, paperImageTiles, paperLayout, paperSvg } from "../lib/notebook-paper";

const FILE = "0b7c6c5e-3f43-4c1e-9a55-1d1f4f0a2b3c";
const picture = (extra: Partial<InkImage> = {}): InkImage => ({ id: "img1", type: "image", file: FILE, x: 100, y: 100, w: 200, h: 100, ...extra });
const close = (a: number, b: number, eps = 0.05) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);

// A PNG of w × h pixels in one colour.
function png(w: number, h: number) {
  const crc = (buf: Buffer) => {
    let c = ~0;
    for (const b of buf) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    }
    return ~c >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "latin1");
    data.copy(out, 8);
    out.writeUInt32BE(crc(Buffer.concat([Buffer.from(type, "latin1"), data])), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rows = Buffer.concat(Array.from({ length: h }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 0x80)])));
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

test("pictures are stored strictly: a page file or a built-in sticker, crop and turn cleaned", () => {
  assert.deepEqual(cleanItem({ id: "a", type: "image", file: FILE.toUpperCase(), x: 1.234, y: 2, w: 50, h: 40 }), { id: "a", type: "image", x: 1.23, y: 2, w: 50, h: 40, file: FILE });
  // Neither file nor sticker, a bad file id or missing numbers: dropped.
  assert.equal(cleanItem({ id: "a", type: "image", x: 1, y: 2, w: 3, h: 4 }), null);
  assert.equal(cleanItem({ id: "a", type: "image", file: "../etc/passwd", x: 1, y: 2, w: 3, h: 4 }), null);
  assert.equal(cleanItem({ id: "a", type: "image", file: FILE, x: 1, y: 2, w: "3", h: 4 }), null);
  const full = cleanItem({ id: "b", type: "image", file: FILE, x: 0, y: 0, w: 10, h: 10, rotation: 370, crop: { x: -1, y: 0.2, w: 2, h: 0.5 }, opacity: 0.01, color: "#ff0000" }) as InkImage;
  assert.equal(full.rotation, 10);
  assert.deepEqual(full.crop, { x: 0, y: 0.2, w: 1, h: 0.5 });
  assert.equal(full.opacity, 0.05);
  // Only stickers keep a colour.
  assert.equal(full.color, undefined);
  const sticker = cleanItem({ id: "c", type: "image", sticker: "heart", file: undefined, x: 0, y: 0, w: 64, h: 64, color: "#FF0000", rotation: 0, crop: { x: 0, y: 0, w: 1, h: 1 }, opacity: 1 }) as InkImage;
  assert.deepEqual(sticker, { id: "c", type: "image", x: 0, y: 0, w: 64, h: 64, sticker: "heart", color: "#ff0000" });
  assert.equal(cleanItem({ id: "d", type: "image", sticker: "<script>", x: 0, y: 0, w: 1, h: 1 }), null);
  // At most INK_LIMITS.imagesPerPage pictures per page; the ink stays.
  const many = Array.from({ length: INK_LIMITS.imagesPerPage + 5 }, (_, i) => picture({ id: `p${i}` }));
  const doc = parseInk({ pages: { s: [...many, { id: "pen", type: "pen", color: "#000000", width: 1, points: [0, 0, 0.5] }] } });
  assert.equal(doc.pages.s.filter((i) => i.type === "image").length, INK_LIMITS.imagesPerPage);
  assert.ok(doc.pages.s.some((i) => i.id === "pen"));
  // Round trip.
  assert.deepEqual(parseInk(serializeInk(withPage(emptyInk(), "s", [full]))).pages.s, [full]);
});

test("picture files of a document can be listed and swapped (page copies)", () => {
  const doc = withPage(emptyInk(), "s", [picture(), picture({ id: "img2", file: undefined, sticker: "star" }), { id: "t", type: "text", color: "#1f1f1f", size: 12, x: 0, y: 0, text: "x" }]);
  assert.deepEqual(inkFiles(doc), [FILE]);
  const other = "1b7c6c5e-3f43-4c1e-9a55-1d1f4f0a2b3c";
  assert.equal((mapInkFiles(doc, () => other).pages.s[0] as InkImage).file, other);
  // No copy: the picture goes, stickers and ink stay.
  assert.deepEqual(mapInkFiles(doc, () => null).pages.s.map((i) => i.id), ["img2", "t"]);
});

test("the frame: corners keep the proportions, edges stretch, the opposite side stays – also turned", () => {
  const base = picture();
  const corner = resizeImage(base, "se", { x: 500, y: 150 });
  assert.equal(corner.x, 100);
  assert.equal(corner.y, 100);
  assert.equal(corner.w / corner.h, 2);
  assert.equal(corner.w, 400);
  const free = resizeImage(base, "se", { x: 500, y: 150 }, { free: true });
  assert.deepEqual([free.w, free.h], [400, 50]);
  const edge = resizeImage(base, "w", { x: 50, y: 999 });
  assert.deepEqual([edge.x, edge.w, edge.h], [50, 250, 100]);
  // Turned by 90°: dragging the bottom right corner keeps the top left corner on the page.
  const turned = picture({ rotation: 90 });
  const fixed = imageCorners(turned)[0];
  const grown = resizeImage(turned, "se", { x: 0, y: 400 });
  const after = imageCorners(grown)[0];
  close(after.x, fixed.x);
  close(after.y, fixed.y);
  assert.ok(grown.w > turned.w);
  // Never smaller than the minimum.
  assert.ok(resizeImage(base, "se", { x: 0, y: 0 }).w >= 8);
});

test("turning lands on right angles, Shift in 15° steps; hits and bounds follow the turn", () => {
  const base = picture();
  // The handle sits above the centre (200, 150): straight up is 0°.
  assert.equal(rotateImage(base, { x: 200, y: 0 }).rotation, undefined);
  assert.equal(rotateImage(base, { x: 400, y: 152 }).rotation, 90);
  assert.equal(rotateImage(base, { x: 275, y: 20 }, { steps: true }).rotation, 30);
  const turned = picture({ rotation: 90 });
  const box = imageBounds(turned);
  close(box.w, 100);
  close(box.h, 200);
  assert.ok(hitImage(turned, { x: 200, y: 60 }));
  assert.ok(!hitImage(turned, { x: 110, y: 150 }));
  assert.equal(imageAt([picture({ id: "under" }), picture({ id: "over", x: 150 })], { x: 200, y: 150 })?.id, "over");
});

test("cropping moves the edges inside the whole picture; reset brings it back", () => {
  const base = picture();
  const cropped = cropImage(base, "w", { x: 150, y: 0 });
  assert.equal(cropped.x, 150);
  assert.equal(cropped.w, 150);
  assert.deepEqual(cropped.crop, { x: 0.25, y: 0, w: 0.75, h: 1 });
  // The whole picture stays where it was.
  assert.deepEqual(fullBox(cropped), { x: 100, y: 100, w: 200, h: 100 });
  // Not beyond the picture.
  const limited = cropImage(cropped, "w", { x: 0, y: 0 });
  assert.equal(limited.x, 100);
  assert.equal(limited.crop, undefined);
  const twice = cropImage(cropImage(base, "n", { x: 0, y: 125 }), "e", { x: 250, y: 0 });
  assert.deepEqual(twice.crop, { x: 0, y: 0.25, w: 0.75, h: 0.75 });
  assert.deepEqual(uncropImage(twice), { ...base });
});

test("order: front over the ink, back under everything; new pictures fit the sheet", () => {
  const ink: InkItem = { id: "pen", type: "pen", color: "#000000", width: 1, points: [0, 0, 0.5] };
  const items = [picture(), ink];
  assert.deepEqual(toFront(items, "img1").map((i) => i.id), ["pen", "img1"]);
  assert.deepEqual(toBack(toFront(items, "img1"), "img1").map((i) => i.id), ["img1", "pen"]);
  const sheet = { width: 595, height: 842 };
  const big = placeImage({ width: 3000, height: 2000 }, sheet);
  assert.ok(big.w <= sheet.width * 0.6 + 0.01 && big.h <= sheet.height * 0.5 + 0.01);
  close(big.w / big.h, 1.5, 0.01);
  const corner = placeImage({ width: 100, height: 100 }, sheet, { at: { x: 590, y: 5 } });
  assert.deepEqual([corner.x, corner.y], [495, 0]);
});

test("erasers leave pictures alone; the lasso takes them by their middle; moves and resizes carry them", () => {
  const img = picture();
  const stroke: InkItem = { id: "s", type: "pen", color: "#000000", width: 2, points: [150, 150, 0.5, 250, 150, 0.5] };
  const path = [{ x: 200, y: 150 }];
  assert.deepEqual(eraseItems([img, stroke], path, 4).map((i) => i.id), ["img1"]);
  assert.deepEqual(erasePartial([img, stroke], path, 4).map((i) => i.id).filter((id) => id === "img1"), ["img1"]);
  const around = [
    { x: 150, y: 120 },
    { x: 260, y: 120 },
    { x: 260, y: 180 },
    { x: 150, y: 180 },
  ];
  assert.ok(lassoItems([img], around).includes("img1"));
  const moved = transformItems([img], new Set(["img1"]), { scale: 2, ox: 100, oy: 100, dx: 10 })[0] as InkImage;
  assert.deepEqual([moved.x, moved.y, moved.w, moved.h], [110, 100, 400, 200]);
  assert.deepEqual(itemBounds(moved), { x: 110, y: 100, w: 400, h: 200 });
  // Recolouring: one-colour stickers follow, pictures and multi-colour stickers keep theirs.
  const heart = picture({ id: "h", file: undefined, sticker: "heart" });
  const star = picture({ id: "st", file: undefined, sticker: "star" });
  const recoloured = recolorItems([img, heart, star], new Set(["img1", "h", "st"]), "#2f9e44");
  assert.deepEqual(recoloured.map((i) => (i as InkImage).color), [undefined, "#2f9e44", undefined]);
  assert.ok(stickerTintable("heart") && !stickerTintable("star"));
});

test("the lasso's selection: a tap picks the picture, turns and scales carry it, no width, every eraser mode leaves it", () => {
  const img = picture();
  const stroke: InkItem = { id: "s", type: "pen", color: "#000000", width: 2, points: [120, 120, 0.5, 140, 120, 0.5] };
  // Ink drawn over the picture is picked first, the picture elsewhere.
  assert.equal(itemAt([img, stroke], { x: 130, y: 120 }, 3), "s");
  assert.equal(itemAt([img, stroke], { x: 250, y: 170 }, 3), "img1");
  // Turned by 90° around its centre: same box, turn added.
  const turned = transformSelected([img, stroke], new Set(["img1", "s"]), rotation(Math.PI / 2, { x: 200, y: 150 }))[0] as InkImage;
  assert.deepEqual([turned.x, turned.y, turned.w, turned.h, turned.rotation], [100, 100, 200, 100, 90]);
  // Scaled from the top left: the centre moves with it, sides doubled.
  const scaled = transformSelected([img], new Set(["img1"]), scaling(2, 2, { x: 100, y: 100 }))[0] as InkImage;
  assert.deepEqual([scaled.x, scaled.y, scaled.w, scaled.h, scaled.rotation], [100, 100, 400, 200, undefined]);
  // A turned picture stretched along x: its own sides follow (exact at 90°).
  const stretched = transformSelected([turned], new Set(["img1"]), scaling(2, 1, { x: 200, y: 150 }))[0] as InkImage;
  assert.deepEqual([stretched.w, stretched.h, stretched.rotation], [200, 200, 90]);
  // Width steps skip pictures.
  assert.equal(setItemsWidth([img], new Set(["img1"]), 2)[0], img);
  assert.equal(sharedWidthStep([img, stroke]), null);
  for (const mode of ["stroke", "partial", "highlighter"] as const) assert.ok(eraseWith([img], [{ x: 200, y: 150 }], mode, 20).includes(img), mode);
});

test("concurrent saves merge pictures like strokes: moved by one, drawn on by the other", () => {
  const base = [picture()];
  const ours = [picture({ x: 300 })];
  const theirs = [picture(), { id: "pen", type: "pen", color: "#000000", width: 1, points: [0, 0, 0.5] } as InkItem];
  const merged = mergePage(base, ours, theirs);
  assert.equal((merged.find((i) => i.id === "img1") as InkImage).x, 300);
  assert.ok(merged.some((i) => i.id === "pen"));
});

test("SVG: the picture cut to its part and turned, stickers as paths, highlighter above it multiplied", () => {
  const items: InkItem[] = [
    { id: "h1", type: "highlighter", color: "#ffd43b", width: 14, points: [0, 0, 0.5, 10, 0, 0.5] },
    picture({ crop: { x: 0.25, y: 0, w: 0.75, h: 1 }, rotation: 30, opacity: 0.5 }),
    { id: "h2", type: "highlighter", color: "#ffd43b", width: 14, points: [0, 0, 0.5, 10, 0, 0.5] },
    picture({ id: "s", file: undefined, sticker: "heart", color: "#2f9e44" }),
  ];
  const svg = inkSvg(items, { width: 595, height: 842 }, { imageHref: (file) => `/x/${file}?a&b` });
  assert.match(svg, /<image href="\/x\/0b7c6c5e-3f43-4c1e-9a55-1d1f4f0a2b3c\?a&amp;b" x="0" y="0" width="266\.67" height="100"/);
  assert.match(svg, /viewBox="66\.67 0 200 100"/);
  assert.match(svg, /<g transform="rotate\(30 200 150\)" opacity="0\.5">/);
  assert.match(svg, /fill="#2f9e44"/);
  // The first highlighter under everything, the second one multiplied above the picture.
  assert.equal((svg.match(/mix-blend-mode:multiply/g) || []).length, 2);
  assert.ok(svg.indexOf("<image") < svg.lastIndexOf('style="mix-blend-mode:multiply"'));
  // Without an address: a grey box, never a broken reference.
  assert.match(inkSvg([picture()], { width: 10, height: 10 }), /fill="#e9ecef"/);
});

test("PDF: pictures embedded once, cut and turned; stickers as vectors; EXIF orientation applied", async () => {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([600, 800]);
  let loads = 0;
  const context = inkPdfContext(pdf, {
    loadImage: async () => {
      loads++;
      return { bytes: png(4, 2), type: "png" };
    },
  });
  await drawInk(
    context,
    page,
    [picture({ crop: { x: 0.5, y: 0, w: 0.5, h: 1 }, rotation: 45 }), picture({ id: "img2", x: 300 }), picture({ id: "st", file: undefined, sticker: "warning" })],
    [1, 0, 0, -1, 0, 800],
  );
  const bytes = await pdf.save();
  assert.equal(loads, 1);
  const reread = await PDFDocument.load(bytes);
  assert.equal(reread.getPageCount(), 1);
  const text = Buffer.from(bytes).toString("latin1");
  assert.ok((text.match(/\/Subtype \/Image/g) || []).length === 1);
  // Orientation 6 (turned right): the stored top left lands at the top right of the box (y down).
  const [a, b, c, d, e, f] = imageMatrix({ x: 0, y: 0, w: 10, h: 20 }, 6);
  const at = (s: number, t: number) => [a * s + c * t + e, b * s + d * t + f];
  // The stored image's top left is (s, t) = (0, 1).
  assert.deepEqual(at(0, 1), [10, 0]);
  assert.deepEqual(imageMatrix({ x: 5, y: 6, w: 10, h: 20 }), [10, 0, 0, -20, 5, 26]);
});

test("built-in stickers: files in public/stickers match the definitions; stamps are ink", () => {
  assert.ok(STICKERS.length >= 12);
  assert.equal(new Set(STICKERS.map((s) => s.id)).size, STICKERS.length);
  for (const sticker of STICKERS) assert.equal(readFileSync(`public/stickers/${sticker.id}.svg`, "utf8"), stickerSvg(sticker), sticker.id);
  const [frame, text] = stampItems("10.11.2026", { x: 50, y: 50 });
  assert.equal(frame.type, "pen");
  assert.equal(text.type, "text");
  assert.ok(itemBounds(frame).w > itemBounds(text).w * 0.9);
});

test("own paper templates: kept by the paper, lines replaced, tiles, older paper unchanged", async () => {
  // A choice from the dialog (template only) and a stored copy.
  assert.deepEqual(cleanPaper({ image: { template: FILE, fit: "tile" } }), { image: { template: FILE, fit: "tile" } });
  assert.deepEqual(cleanPaper({ image: { file: FILE, width: 100, height: 50, kind: "pdf", fit: "nonsense", name: " Planer " } }), {
    image: { fit: "stretch", file: FILE, kind: "pdf", width: 100, height: 50, name: "Planer" },
  });
  assert.deepEqual(cleanPaper({ image: { file: FILE } }), {});
  assert.deepEqual(cleanPaper({ image: null }), { image: null });
  // A sheet's "no own template" wins over the notebook's.
  const notebook = { ...DEFAULT_PAPER, image: { file: FILE, width: 10, height: 10, fit: "stretch" as const, kind: "image" as const } };
  assert.equal(effectivePaper(notebook, { image: null }).image, undefined);
  assert.equal(effectivePaper(notebook, {}).image?.file, FILE);
  const layout = paperLayout(notebook);
  assert.equal(layout.shapes.length, 0);
  assert.match(paperSvg(layout, { imageHref: (f) => `/api/files/${f}` }), /<image href="\/api\/files\/0b7c6c5e/);
  assert.ok(!paperSvg(layout).includes("<image"));
  assert.equal(paperImageTiles({ fit: "tile", width: 100, height: 100 }, { width: 250, height: 150 }).length, 6);
  assert.equal(paperImageTiles({ fit: "stretch", width: 100, height: 100 }, { width: 250, height: 150 }).length, 1);
  // Without an own template nothing changes.
  assert.deepEqual(paperLayout(DEFAULT_PAPER).shapes.length > 0, true);
  // In the PDF: the picture under the ink.
  const sheets = notebookPdfSheets(notebook, [{ id: "s1", paper: {}, background: null, ink: withPage(emptyInk(), "s1", [picture()]) }]);
  const bytes = await notebookPdf(sheets, async () => null, { loadImage: async () => ({ bytes: png(2, 2), type: "png" }) });
  assert.equal((await PDFDocument.load(bytes)).getPageCount(), 1);
  // Paper picture and sheet picture are the same file: embedded once.
  assert.equal((Buffer.from(bytes).toString("latin1").match(/\/Subtype \/Image/g) || []).length, 1);
});
