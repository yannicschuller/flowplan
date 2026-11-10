// The look of typed text boxes (lib/ink/text-style.ts): the stored fields
// (bold, italic, underline, align, lineHeight) and what older versions see,
// a style applied to a selection (one change, mixed values), and the same
// layout in the SVG and the PDF export.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument, PDFName } from "pdf-lib";
import { samplePdf } from "./helpers/pdf";
import { cleanItem, emptyInk, parseInk, serializeInk, withPage, type InkItem, type InkStroke, type InkText } from "../lib/ink/model";
import { applyTextLook, baselineY, sharedTextLook, textAnchorX, textLook, textWidth, withTextLook } from "../lib/ink/text-style";
import { textBox } from "../lib/ink/geometry";
import { inkSvgElements } from "../lib/ink/svg";
import { inkPdfFont } from "../lib/ink/fonts";
import { flattenInk } from "../lib/ink/pdf-export";
import { transformItem, translation, setItemsWidth } from "../lib/ink/selection";

const text = (id: string, extra: Partial<InkText> = {}): InkText => ({ id, type: "text", color: "#1f1f1f", size: 20, x: 100, y: 100, text: "Hallo\nWelt!", ...extra });
const pen: InkStroke = { id: "p", type: "pen", color: "#1f1f1f", width: 2, points: [0, 0, 0.5, 10, 10, 0.5] };

test("the look is stored, junk dropped, defaults left out", () => {
  const item = cleanItem({ ...text("a"), font: "serif", bold: true, italic: true, underline: true, align: "center", lineHeight: 1.5, rotation: 30 }) as InkText;
  assert.deepEqual(item, { ...text("a"), font: "serif", bold: true, italic: true, underline: true, align: "center", lineHeight: 1.5, rotation: 30 });
  // Field order as stored (merges compare items as JSON).
  assert.deepEqual(Object.keys(item), ["id", "type", "color", "size", "x", "y", "text", "font", "bold", "italic", "underline", "align", "lineHeight", "rotation"]);
  const junk = cleanItem({ ...text("b"), bold: "yes", italic: 1, underline: false, align: "justify", lineHeight: 1.25 }) as InkText;
  assert.deepEqual(junk, text("b"));
  assert.equal((cleanItem({ ...text("c"), align: "left", lineHeight: 99 }) as InkText).lineHeight, 3);
  assert.equal((cleanItem({ ...text("c"), lineHeight: 0.1 }) as InkText).lineHeight, 0.8);
  // Through the stored JSON and back.
  const doc = withPage(emptyInk(), "1", [item]);
  assert.deepEqual(parseInk(serializeInk(doc)), doc);
});

test("older versions read styled text as plain text and keep the words", () => {
  const styled = { ...text("a"), bold: true, align: "right", lineHeight: 2 };
  // What a version without these fields keeps when it saves.
  const old = Object.fromEntries(Object.entries(styled).filter(([k]) => ["id", "type", "color", "size", "x", "y", "text", "font", "rotation", "rec"].includes(k)));
  const back = cleanItem(old) as InkText;
  assert.equal(back.text, "Hallo\nWelt!");
  assert.deepEqual(textLook(back), { font: undefined, size: 20, color: "#1f1f1f", bold: false, italic: false, underline: false, align: "left", lineHeight: 1.25 });
});

test("a look applies to the chosen text boxes only, unchanged lists stay the same", () => {
  const items: InkItem[] = [text("a"), text("b", { bold: true }), pen, text("c")];
  const ids = new Set(["a", "b", "p"]);
  const bold = applyTextLook(items, ids, { bold: true });
  assert.notEqual(bold, items);
  assert.equal((bold[0] as InkText).bold, true);
  assert.equal(bold[1], items[1], "already bold: the same item");
  assert.equal(bold[2], pen, "strokes untouched");
  assert.equal(bold[3], items[3], "not chosen");
  // Nothing to change: the same list (no undo step).
  assert.equal(applyTextLook(bold, ids, { bold: true }), bold);
  // Off again: the field goes, the stored form stays canonical.
  const plain = applyTextLook(bold, ids, { bold: false, align: "left", lineHeight: 1.25, font: undefined });
  assert.deepEqual(plain[0], text("a"));
  const all = applyTextLook(items, new Set(["a", "b", "c"]), { font: "caveat", size: 32, color: "#E03131", italic: true, underline: true, align: "right", lineHeight: 1.5 });
  for (const item of [all[0], all[1], all[3]] as InkText[]) {
    assert.deepEqual(item, cleanItem(item), "stored form");
    assert.deepEqual(textLook(item), { font: "caveat", size: 32, color: "#e03131", bold: item.id === "b", italic: true, underline: true, align: "right", lineHeight: 1.5 });
  }
  // The box keeps its place and turn; the size is kept within the model's range.
  const turned = withTextLook(text("t", { rotation: 15, rec: { id: "r1", t: 500 } }), { size: 1000 });
  assert.deepEqual([turned.x, turned.y, turned.rotation, turned.rec, turned.size], [100, 100, 15, { id: "r1", t: 500 }, 400]);
});

test("mixed selections: shared values, null where boxes differ", () => {
  assert.equal(sharedTextLook([pen]), null);
  const look = sharedTextLook([text("a", { bold: true, font: "mono" }), pen, text("b", { font: "mono", size: 14, align: "center" })])!;
  assert.deepEqual(look, { font: "mono", size: null, color: "#1f1f1f", bold: null, italic: false, underline: false, align: null, lineHeight: 1.25 });
  // Default face against another one is mixed too.
  assert.equal(sharedTextLook([text("a"), text("b", { font: "serif" })])!.font, null);
  assert.equal(sharedTextLook([text("a"), text("b")])!.font, undefined);
});

test("box, anchor and baselines follow the look", () => {
  const plain = text("a");
  const box = textBox(plain);
  assert.equal(box.h, 2 * 20 * 1.25);
  const spaced = textBox(text("a", { lineHeight: 2 }));
  assert.equal(spaced.h, 80);
  assert.ok(textBox(text("a", { bold: true })).w > box.w, "bold is wider");
  assert.equal(textAnchorX(plain), 100);
  assert.equal(textAnchorX(text("a", { align: "center" })), 100 + textWidth(plain) / 2);
  assert.equal(textAnchorX(text("a", { align: "right" })), 100 + textWidth(plain));
  assert.equal(baselineY(text("a", { lineHeight: 1.5 }), 1), 100 + 16 + 30);
  // Moving and scaling keep the look; the width presets change the size only.
  const styled = text("a", { bold: true, align: "center", lineHeight: 1.5 });
  const moved = transformItem(styled, translation(10, 0)) as InkText;
  assert.deepEqual([moved.bold, moved.align, moved.lineHeight, moved.x], [true, "center", 1.5, 110]);
  const sized = setItemsWidth([styled], new Set(["a"]), 2)[0] as InkText;
  assert.deepEqual([sized.size, sized.bold, sized.align], [20, true, "center"]);
});

test("SVG: weight, style, underline, anchor and line height", () => {
  const styled = text("a", { bold: true, italic: true, underline: true, align: "center", lineHeight: 2 });
  const svg = inkSvgElements([styled]);
  const x = Math.round(textAnchorX(styled) * 100) / 100;
  assert.match(svg, /font-weight="bold"/);
  assert.match(svg, /font-style="italic"/);
  assert.match(svg, /text-decoration="underline"/);
  assert.match(svg, /text-anchor="middle"/);
  assert.ok(svg.includes(`<tspan x="${x}" dy="0">Hallo</tspan><tspan x="${x}" dy="40">Welt!</tspan>`), svg);
  // Plain text as before.
  const plain = inkSvgElements([text("b")]);
  assert.doesNotMatch(plain, /font-weight|font-style|text-decoration|text-anchor/);
  assert.match(plain, /<tspan x="100" dy="25">Welt!<\/tspan>/);
  assert.match(inkSvgElements([text("c", { align: "right" })]), /text-anchor="end"/);
});

test("PDF: standard bold and italic cuts of each family", () => {
  assert.deepEqual(
    [inkPdfFont(undefined, { bold: true }), inkPdfFont("sans", { italic: true }), inkPdfFont("caveat", { bold: true, italic: true })],
    ["Helvetica-Bold", "Helvetica-Oblique", "Helvetica-BoldOblique"],
  );
  assert.deepEqual(
    [inkPdfFont("serif", { bold: true }), inkPdfFont("serif", { italic: true }), inkPdfFont("serif", { bold: true, italic: true }), inkPdfFont("serif")],
    ["Times-Bold", "Times-Italic", "Times-BoldItalic", "Times-Roman"],
  );
  assert.deepEqual([inkPdfFont("mono", { bold: true }), inkPdfFont("mono", { italic: true }), inkPdfFont("mono", { bold: true, italic: true })], ["Courier-Bold", "Courier-Oblique", "Courier-BoldOblique"]);
});

test("PDF export: fonts, centred and right-aligned lines, line height, underline", async () => {
  const items: InkItem[] = [
    text("c", { text: "Mitte\nund eine lange Zeile", align: "center", bold: true, font: "serif", lineHeight: 2, x: 100, y: 100 }),
    text("r", { text: "rechts\nbündig ok", align: "right", italic: true, underline: true, x: 100, y: 400 }),
    text("l", { text: "links", font: "mono", bold: true, italic: true, x: 100, y: 600 }),
  ];
  const bytes = await flattenInk(samplePdf(["Eins"]), withPage(emptyInk(), "1", items));
  const fonts = (await PDFDocument.load(bytes)).context
    .enumerateIndirectObjects()
    .map(([, obj]) => String((obj as { get?: (k: unknown) => unknown }).get?.(PDFName.of("BaseFont")) ?? ""))
    .filter(Boolean);
  for (const name of ["/Times-Bold", "/Helvetica-Oblique", "/Courier-BoldOblique"]) assert.ok(fonts.includes(name), `${name} in ${fonts.join()}`);
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0, disableFontFace: true }).promise;
  const page = await doc.getPage(1);
  const runs = (await page.getTextContent()).items.flatMap((i) => ("str" in i && i.str.trim() ? [{ str: i.str, x: i.transform[4], y: i.transform[5], w: i.width }] : []));
  const run = (s: string) => runs.find((r) => r.str === s)!;
  // The page is 792 pt high: PDF y goes up.
  const [mitte, lang] = [run("Mitte"), run("und eine lange Zeile")];
  const centre = textAnchorX(items[0] as InkText);
  assert.ok(Math.abs(mitte.x + mitte.w / 2 - centre) < 0.6, `centred: ${mitte.x + mitte.w / 2} vs ${centre}`);
  assert.ok(Math.abs(lang.x + lang.w / 2 - centre) < 0.6);
  assert.ok(Math.abs(mitte.y - lang.y - 40) < 0.01, "line height 2 × 20 pt");
  assert.ok(Math.abs(mitte.y - (792 - baselineY(items[0] as InkText, 0))) < 0.01);
  const [rechts, buendig] = [run("rechts"), run("bündig ok")];
  const end = textAnchorX(items[1] as InkText);
  assert.ok(Math.abs(rechts.x + rechts.w - end) < 0.6 && Math.abs(buendig.x + buendig.w - end) < 0.6, "right-aligned");
  assert.equal(Math.round(run("links").x), 100);
  // The underline: filled bars besides the text.
  const { OPS } = pdfjs;
  const ops = (await page.getOperatorList()).fnArray;
  assert.ok(ops.filter((op) => op === OPS.fill || op === OPS.constructPath).length >= 2, "underline bars");
  await doc.loadingTask.destroy();
});
