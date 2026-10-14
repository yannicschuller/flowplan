import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-ocr-languages-"));
process.env.FLOWPLAN_OCR_LANGS = "fra,eng";
const { ocrImage, ocrLanguages, stopOcr } = await import("../lib/ocr");
after(() => stopOcr());

test("FLOWPLAN_OCR_LANGS chooses the bundled languages", () => {
  // Without an argument: the setting of this test run.
  assert.deepEqual(ocrLanguages(), ["fra", "eng"]);
  assert.deepEqual(ocrLanguages(""), ["deu", "eng"]);
  assert.deepEqual(ocrLanguages("fra,eng"), ["fra", "eng"]);
  // Tesseract's own notation and spaces work too; order is kept.
  assert.deepEqual(ocrLanguages("fra+deu"), ["fra", "deu"]);
  assert.deepEqual(ocrLanguages(" FRA , deu ,fra "), ["fra", "deu"]);
  // Unknown codes are dropped: they would name files outside the bundle.
  assert.deepEqual(ocrLanguages("fra,../../etc,ita"), ["fra"]);
  assert.deepEqual(ocrLanguages("xyz"), ["deu", "eng"]);
});

test("French scans are recognised with their accents", async () => {
  // With the default German and English data this line comes out as
  // "Echéance rögl&e a Genéve".
  const text = await ocrImage(readFileSync("tests/fixtures/scan-fr.png"));
  assert.match(text, /Facture/);
  assert.match(text, /4711/);
  assert.match(text, /Échéance/);
  assert.match(text, /réglée/);
  assert.match(text, /Genève/);
});
