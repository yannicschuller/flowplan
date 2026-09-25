import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { all, run } from "./db";
import { pdfText } from "./pdf-text";

const MAX_PDF_BYTES = 50 * 1024 * 1024,
  TIMEOUT = 30000;
const runtime = globalThis as typeof globalThis & {
  flowplanFileTextTimer?: ReturnType<typeof setInterval>;
  flowplanFileTextBusy?: boolean;
};

function withTimeout<T>(promise: Promise<T>) {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), TIMEOUT);
    }),
  ]).finally(() => clearTimeout(timer));
}

// Extracts the text of PDFs without a stored result; failures are stored
// too, so a broken file is not retried on every run. Returns the count.
export async function extractPendingFileTexts(limit = 5) {
  const pending = all<{ id: string; size: number }>(
    `SELECT f.id,f.size FROM files f LEFT JOIN file_texts t ON t.file_id=f.id
     WHERE t.file_id IS NULL AND f.mime='application/pdf' LIMIT ?`,
    limit,
  );
  const dir = resolve(process.env.FLOWPLAN_DATA_DIR || "./data", "uploads");
  for (const file of pending) {
    let text = "",
      status = "ok";
    try {
      const path = resolve(dir, file.id);
      if (statSync(path).size > MAX_PDF_BYTES) status = "too-large";
      else text = await withTimeout(pdfText(readFileSync(path)));
    } catch {
      status = "error";
    }
    // The file may have been deleted meanwhile; then nothing is stored.
    run(
      "INSERT OR IGNORE INTO file_texts(file_id,text,status) SELECT id,?,? FROM files WHERE id=?",
      text,
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
