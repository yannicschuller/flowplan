// What the drawing viewer's worker (parse-worker.ts) is given and answers
// (#384): the file, and the scene of lib/drawing-scene.ts with its arrays
// transferred, or why the file could not be read.
import type { DrawingScene } from "@/lib/drawing-scene";

export type DrawingJob = { format: "dxf" | "dwg"; buffer: ArrayBuffer; readerUrl: string };
// "reader": LibreDWG (WebAssembly) could not be loaded; "dwg": LibreDWG
// could not read this DWG file (version or content); "binary": binary DXF;
// "memory": the file needs more memory than the browser gives.
export type DrawingError = "parse" | "empty" | "reader" | "dwg" | "binary" | "memory";
export type DrawingResult = { ok: true; scene: DrawingScene } | { ok: false; error: DrawingError; message: string };
