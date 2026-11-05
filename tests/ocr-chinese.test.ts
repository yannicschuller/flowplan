import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Own file: the OCR worker loads its languages once per process.
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-ocr-chinese-"));
process.env.FLOWPLAN_OCR_LANGS = "chi_sim,eng";
const { ocrImage, stopOcr } = await import("../lib/ocr");
after(() => stopOcr());

test("Chinese scans are recognised without spaces between the characters", async () => {
  // Without preserve_interword_spaces Tesseract returns "发 票 编 号 4711".
  const text = await ocrImage(readFileSync("tests/fixtures/scan-zh.png"));
  assert.match(text, /发票编号 4711/);
  assert.match(text, /二〇二六年三月十五日/);
  assert.match(text, /上海市浦东新区/);
});
