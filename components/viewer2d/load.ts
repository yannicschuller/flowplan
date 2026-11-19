// Fetches and reads a DXF or DWG drawing for the drawing viewer (#384):
// the size limits of lib/model-formats.ts first (from the answer's
// length, before the file is downloaded), then the worker
// (parse-worker.ts), which answers with the scene to draw.
import { modelTooLarge } from "@/lib/model-formats";
import { dwgVersion } from "@/lib/drawing-model";
import type { DrawingScene } from "@/lib/drawing-scene";
import type { DrawingJob, DrawingResult } from "./drawing-data";

// The DWG reader (LibreDWG), served by Flowplan itself (app/libredwg).
export const DWG_READER = "/libredwg/dist/libredwg-web.js";

export type DrawingProblem =
  | { kind: "too-large"; limitMb: number }
  | { kind: "download" }
  | { kind: "parse" }
  | { kind: "empty" }
  | { kind: "binary" }
  | { kind: "memory" }
  | { kind: "dwg"; release: string | null }
  | { kind: "reader"; offline: boolean };
export class DrawingLoadError extends Error {
  constructor(readonly problem: DrawingProblem) {
    super(problem.kind);
  }
}
const fail = (problem: DrawingProblem) => new DrawingLoadError(problem);

export type LoadedDrawing = { scene: DrawingScene; release: string | null };

export async function loadDrawing(src: string, format: "dxf" | "dwg", signal: AbortSignal): Promise<LoadedDrawing> {
  let response: Response;
  try {
    response = await fetch(src, { credentials: "same-origin", signal });
  } catch (error) {
    if (signal.aborted) throw error;
    throw fail({ kind: "download" });
  }
  if (!response.ok) throw fail({ kind: "download" });
  const early = modelTooLarge(format, Number(response.headers.get("content-length") || NaN));
  if (early) {
    void response.body?.cancel().catch(() => {});
    throw fail({ kind: "too-large", limitMb: early });
  }
  const buffer = await response.arrayBuffer();
  const late = modelTooLarge(format, buffer.byteLength);
  if (late) throw fail({ kind: "too-large", limitMb: late });
  const version = format === "dwg" ? dwgVersion(new Uint8Array(buffer, 0, Math.min(6, buffer.byteLength))) : null;
  if (format === "dwg" && !version) throw fail({ kind: "dwg", release: null });
  const release = version?.release ?? version?.code ?? null;
  const scene = await inWorker({ format, buffer, readerUrl: new URL(DWG_READER, location.origin).href }, signal, release);
  return { scene, release };
}

function inWorker(job: DrawingJob, signal: AbortSignal, release: string | null): Promise<DrawingScene> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./parse-worker.ts", import.meta.url), { type: "module" });
    const done = () => {
      worker.terminate();
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      done();
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", abort);
    worker.onmessage = (event: MessageEvent<DrawingResult>) => {
      done();
      const result = event.data;
      if (result.ok) return resolve(result.scene);
      if (result.error === "reader") reject(fail({ kind: "reader", offline: navigator.onLine === false }));
      else if (result.error === "dwg") reject(fail({ kind: "dwg", release }));
      else reject(fail({ kind: result.error }));
    };
    worker.onerror = () => {
      done();
      // An error the worker did not catch: LibreDWG gave up on the file.
      reject(fail(job.format === "dwg" ? { kind: "dwg", release } : { kind: "parse" }));
    };
    worker.postMessage(job, [job.buffer]);
  });
}
