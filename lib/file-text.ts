import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { all, run } from "./db";
import { MAX_PDF_TEXT, pdfScanImages, pdfText } from "./pdf-text";
import { OFFICE_TYPES, officeKind, officeText } from "./office-text";
import { ocrImage } from "./ocr";

const MAX_PDF_BYTES = 50 * 1024 * 1024,
  TIMEOUT = 30000;
const runtime = globalThis as typeof globalThis & {
  flowplanFileTextTimer?: ReturnType<typeof setInterval>;
  flowplanFileTextBusy?: boolean;
};

function withTimeout<T>(promise: Promise<T>, ms = TIMEOUT) {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

const OCR_TIMEOUT = 180000,
  MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const ocrEnabled = () => process.env.FLOWPLAN_OCR !== "0";
const IMAGE_TYPES = ["image/png", "image/jpeg"];
// Office and image types are listed for the query; names catch Office
// files uploaded without a specific type.
const officeMimes = Object.keys(OFFICE_TYPES);

async function extract(file: { id: string; name: string; mime: string }) {
  const path = resolve(
    process.env.FLOWPLAN_DATA_DIR || "./data",
    "uploads",
    file.id,
  );
  const size = statSync(path).size;
  const office = officeKind(file.mime, file.name);
  if (office) {
    if (size > MAX_PDF_BYTES) return { text: "", status: "too-large" };
    return {
      text: await withTimeout(officeText(readFileSync(path), office)),
      status: "ok",
    };
  }
  if (IMAGE_TYPES.includes(file.mime)) {
    if (!ocrEnabled()) return { text: "", status: "skipped" };
    if (size > MAX_IMAGE_BYTES) return { text: "", status: "too-large" };
    return {
      text: await withTimeout(ocrImage(readFileSync(path)), OCR_TIMEOUT),
      status: "ocr",
    };
  }
  if (size > MAX_PDF_BYTES) return { text: "", status: "too-large" };
  const data = readFileSync(path);
  const text = await withTimeout(pdfText(data));
  if (text.trim().length >= 20 || !ocrEnabled()) return { text, status: "ok" };
  // Scanned documents: recognise the page images.
  const pages = await withTimeout(pdfScanImages(data), OCR_TIMEOUT);
  const recognised: string[] = [];
  const started = Date.now();
  for (const image of pages) {
    if (Date.now() - started > OCR_TIMEOUT) break;
    recognised.push(await withTimeout(ocrImage(image), OCR_TIMEOUT));
  }
  return {
    text: [text, ...recognised].join("\n").trim().slice(0, MAX_PDF_TEXT),
    status: pages.length ? "ocr" : "ok",
  };
}
// Extracts text of PDFs, Office files and images without a stored result;
// failures are stored too, so a broken file is not retried on every run.
export async function extractPendingFileTexts(limit = 5) {
  const pending = all<{ id: string; name: string; mime: string }>(
    `SELECT f.id,f.name,f.mime FROM files f LEFT JOIN file_texts t ON t.file_id=f.id
     WHERE t.file_id IS NULL AND (f.mime IN (${["application/pdf", ...IMAGE_TYPES, ...officeMimes].map(() => "?").join(",")})
       OR lower(f.name) GLOB '*.docx' OR lower(f.name) GLOB '*.xlsx' OR lower(f.name) GLOB '*.pptx'
       OR lower(f.name) GLOB '*.odt' OR lower(f.name) GLOB '*.ods' OR lower(f.name) GLOB '*.odp')
     LIMIT ?`,
    "application/pdf",
    ...IMAGE_TYPES,
    ...officeMimes,
    limit,
  );
  for (const file of pending) {
    let text = "",
      status = "ok";
    try {
      ({ text, status } = await extract(file));
    } catch (error) {
      status = "error";
      console.error(
        `Text extraction failed for file ${file.id}:`,
        (error as Error).message,
      );
    }
    // The file may have been deleted meanwhile; then nothing is stored.
    run(
      "INSERT OR IGNORE INTO file_texts(file_id,text,status) SELECT id,?,? FROM files WHERE id=?",
      text.slice(0, MAX_PDF_TEXT),
      status,
      file.id,
    );
  }
  return pending.length;
}

export function startFileTextWorker() {
  if (runtime.flowplanFileTextTimer) return;
  const tick = async () => {
    if (runtime.flowplanFileTextBusy) return;
    runtime.flowplanFileTextBusy = true;
    try {
      while (await extractPendingFileTexts()) {}
    } catch (error) {
      console.error("PDF text extraction failed", error);
    } finally {
      runtime.flowplanFileTextBusy = false;
    }
  };
  runtime.flowplanFileTextTimer = setInterval(() => void tick(), 10000);
  runtime.flowplanFileTextTimer.unref();
  void tick();
}
