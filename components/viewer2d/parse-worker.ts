// Reads a DXF or DWG drawing in a Web Worker so the page stays responsive
// (#384): DXF with dxf-parser (MIT, lib/drawing-dxf.ts), DWG with
// LibreDWG compiled to WebAssembly (@mlightcad/libredwg-web, GPL-3.0,
// lib/drawing-dwg.ts). LibreDWG is not bundled: its files are served from
// Flowplan's own origin (app/libredwg) and imported only when the first
// DWG file is opened. Both end in the scene of lib/drawing-scene.ts.
import { buildScene, sceneTransferables } from "@/lib/drawing-scene";
import { decodeDxf, isBinaryDxf, readDxf } from "@/lib/drawing-dxf";
import { readDwgDatabase } from "@/lib/drawing-dwg";
import type { Drawing } from "@/lib/drawing-model";
import type { DrawingError, DrawingJob, DrawingResult } from "./drawing-data";

type LibreDwg = {
  FS: { writeFile(name: string, data: Uint8Array): void; unlink(name: string): void };
  dwg_read_file(name: string): { error: number; data: number } | null;
  convert(data: number): unknown;
  dwg_free(data: number): void;
};
class Failure extends Error {
  constructor(
    readonly kind: DrawingError,
    message: string,
  ) {
    super(message);
  }
}

let reader: Promise<LibreDwg> | null = null;
function dwgReader(url: string) {
  reader ??= import(/* webpackIgnore: true */ /* turbopackIgnore: true */ url)
    .then((module: { LibreDwg: { create(path?: string): Promise<LibreDwg> } }) => module.LibreDwg.create())
    .catch((error) => {
      reader = null;
      throw new Failure("reader", String((error as Error)?.message || error));
    });
  return reader;
}

// LibreDWG's error bits from 128 on (classes, sections, pages not found,
// internal error, not a DWG file, I/O, memory) mean nothing usable came out.
const CRITICAL = ~127;

async function readDwg(job: DrawingJob): Promise<Drawing> {
  const lib = await dwgReader(job.readerUrl);
  const name = "drawing.dwg";
  let result: { error: number; data: number } | null;
  try {
    lib.FS.writeFile(name, new Uint8Array(job.buffer));
    result = lib.dwg_read_file(name);
  } catch (error) {
    // A crash inside WebAssembly leaves the module unusable.
    reader = null;
    throw new Failure(/memory/i.test(String(error)) ? "memory" : "dwg", String((error as Error)?.message || error));
  } finally {
    try {
      lib.FS.unlink(name);
    } catch {}
  }
  if (!result || !result.data || result.error & CRITICAL) {
    try {
      if (result?.data) lib.dwg_free(result.data);
    } catch {}
    throw new Failure(result && result.error & 8192 ? "memory" : "dwg", `LibreDWG error ${result?.error}`);
  }
  try {
    return readDwgDatabase(lib.convert(result.data) as Parameters<typeof readDwgDatabase>[0]);
  } catch (error) {
    reader = null;
    throw new Failure("dwg", String((error as Error)?.message || error));
  } finally {
    try {
      lib.dwg_free(result.data);
    } catch {}
  }
}

async function read(job: DrawingJob): Promise<Drawing> {
  if (job.format === "dwg") return readDwg(job);
  if (isBinaryDxf(new Uint8Array(job.buffer, 0, Math.min(32, job.buffer.byteLength)))) throw new Failure("binary", "Binary DXF.");
  try {
    return readDxf(decodeDxf(job.buffer));
  } catch (error) {
    throw new Failure(error instanceof RangeError ? "memory" : "parse", String((error as Error)?.message || error));
  }
}

const post = (message: DrawingResult, transfer: ArrayBuffer[] = []) =>
  (self as unknown as { postMessage: (m: DrawingResult, t: ArrayBuffer[]) => void }).postMessage(message, transfer);
self.addEventListener("message", (event: MessageEvent<DrawingJob>) => {
  read(event.data)
    .then((drawing) => {
      const scene = buildScene(drawing);
      if (!scene.bounds) post({ ok: false, error: "empty", message: "Nothing to draw." });
      else post({ ok: true, scene }, sceneTransferables(scene));
    })
    .catch((error) => post({ ok: false, error: error instanceof Failure ? error.kind : "parse", message: String((error as Error)?.message || error) }));
});
