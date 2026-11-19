// What the parsing worker (parse-worker.ts) hands the viewer: plain typed
// arrays (transferred, not copied) that the scene turns into three.js
// meshes. In the model's own coordinates and units.
import type { ModelFormat } from "@/lib/model-formats";

export type MeshData = {
  name: string;
  position: Float32Array;
  normal?: Float32Array;
  // Colours per vertex (r, g, b in 0–1), or one colour for the mesh.
  color?: Float32Array;
  rgb?: [number, number, number];
  index?: Uint32Array;
};
export type ParseJob = { format: ModelFormat; buffer: ArrayBuffer; wasmUrl: string };
// "reader": the CAD reader (WebAssembly) could not be loaded.
export type ParseError = "parse" | "empty" | "reader";
export type ParseResult = { ok: true; meshes: MeshData[] } | { ok: false; error: ParseError; message: string };

export function transferables(meshes: MeshData[]): ArrayBuffer[] {
  const list: ArrayBuffer[] = [];
  for (const mesh of meshes)
    for (const array of [mesh.position, mesh.normal, mesh.color, mesh.index])
      if (array && array.buffer instanceof ArrayBuffer && !list.includes(array.buffer)) list.push(array.buffer);
  return list;
}
