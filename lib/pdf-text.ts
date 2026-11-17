// pdf.js for the file texts (lib/file-text.ts) in a worker thread
// (lib/workers/pdf-worker.mjs): parsing a long PDF (2.7 s for 150 pages),
// decoding a scan's images and compressing them as PNG held the event loop
// – every request of the server waited. One worker per process (cluster
// instances and the single container alike), started on first use and
// ended after a minute without work; a job that runs over its time ends
// the worker with it. Should no worker start (a missing file in an
// unusual build), the work runs here as before.
import { Worker } from "node:worker_threads";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const MAX_PDF_TEXT = 100000;
const IDLE_MS = 60_000;
const JOB_MS = 120_000;

type Job = { id: number; kind: "text" | "scan"; data: Uint8Array; maxPages?: number };
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
type Pool = { worker: Worker | null; pending: Map<number, Pending>; next: number; idle: ReturnType<typeof setTimeout> | null; broken: boolean };
const holder = globalThis as { flowplanPdfPool?: Pool };
const pool = (): Pool => (holder.flowplanPdfPool ??= { worker: null, pending: new Map(), next: 1, idle: null, broken: false });

// The worker scripts are plain JavaScript next to the sources (copied into
// the standalone build by next.config.ts), found from the working directory.
export const workerDir = () => join(/*turbopackIgnore: true*/ process.cwd(), "lib", "workers");

function failAll(p: Pool, error: Error) {
  for (const job of p.pending.values()) {
    clearTimeout(job.timer);
    job.reject(error);
  }
  p.pending.clear();
}
function stop(p: Pool) {
  const worker = p.worker;
  p.worker = null;
  if (p.idle) clearTimeout(p.idle);
  p.idle = null;
  void worker?.terminate().catch(() => {});
}
function started(p: Pool): Worker | null {
  if (p.worker) return p.worker;
  const script = join(workerDir(), "pdf-worker.mjs");
  if (p.broken || !existsSync(script)) return null;
  try {
    const worker = new Worker(script);
    worker.unref();
    worker.on("message", (message: { id: number; value?: unknown; error?: string }) => {
      const job = p.pending.get(message.id);
      if (!job) return;
      p.pending.delete(message.id);
      clearTimeout(job.timer);
      if (message.error !== undefined) job.reject(new Error(message.error));
      else job.resolve(message.value);
      if (!p.pending.size) {
        if (p.idle) clearTimeout(p.idle);
        p.idle = setTimeout(() => stop(p), IDLE_MS);
        p.idle.unref?.();
      }
    });
    worker.on("error", (error) => {
      if (p.worker === worker) p.worker = null;
      failAll(p, error instanceof Error ? error : new Error(String(error)));
    });
    worker.on("exit", () => {
      if (p.worker === worker) p.worker = null;
      failAll(p, new Error("Der PDF-Worker wurde beendet."));
    });
    p.worker = worker;
    return worker;
  } catch {
    p.broken = true;
    return null;
  }
}
async function inWorker<T>(job: Omit<Job, "id">, here: () => Promise<T>): Promise<T> {
  const p = pool();
  const worker = started(p);
  if (!worker) return await here();
  if (p.idle) clearTimeout(p.idle);
  p.idle = null;
  const id = p.next++;
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      // Over its time: the worker goes with it (and its other jobs fail, as a timeout would).
      p.pending.delete(id);
      reject(new Error("Zeitüberschreitung beim Lesen der PDF-Datei."));
      stop(p);
      failAll(p, new Error("Zeitüberschreitung beim Lesen der PDF-Datei."));
    }, JOB_MS);
    timer.unref?.();
    p.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
    worker.postMessage({ ...job, id });
  });
}
type Core = { pdfText: (data: Uint8Array) => Promise<string>; pdfScanImages: (data: Uint8Array, maxPages?: number) => Promise<Buffer[]> };
const core = async () => (await import(/*turbopackIgnore: true*/ pathToFileURL(join(workerDir(), "pdf-core.mjs")).href)) as Core;

// The visible text layer of a PDF (no OCR), capped for the index.
export async function pdfText(data: Uint8Array): Promise<string> {
  return await inWorker({ kind: "text", data }, async () => (await core()).pdfText(data));
}
// Images of PDF pages without a text layer (scans), as PNG for OCR.
export async function pdfScanImages(data: Uint8Array, maxPages = 20): Promise<Buffer[]> {
  const images = await inWorker<Uint8Array[]>({ kind: "scan", data, maxPages }, async () => (await core()).pdfScanImages(data, maxPages));
  return images.map((image) => (Buffer.isBuffer(image) ? image : Buffer.from(image.buffer, image.byteOffset, image.byteLength)));
}
// Tests: how many jobs wait and whether a worker runs.
export const pdfPoolState = () => ({ running: !!pool().worker, pending: pool().pending.size });
