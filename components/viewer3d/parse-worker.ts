// Reads a 3D file in a Web Worker so the page stays responsive (#384): STL
// and OBJ with three.js's loaders, STEP and IGES with OpenCascade
// (occt-import-js, WebAssembly, LGPL-2.1), which triangulates the exact
// surfaces in millimetres. The WebAssembly file (about 7 MB) is fetched
// from Flowplan's own origin (app/occt) only when the first STEP or IGES
// file is opened. glTF/GLB and 3MF are read on the page (their loaders need
// the DOM for textures and XML); see load.ts.
import { transferables, type MeshData, type ParseJob, type ParseResult } from "./mesh-data";

type OcctMesh = {
  name?: string;
  color?: [number, number, number];
  attributes: { position: { array: ArrayLike<number> }; normal?: { array: ArrayLike<number> } };
  index?: { array: ArrayLike<number> };
};
type Occt = { ReadFile: (format: string, content: Uint8Array, params: unknown) => { success: boolean; meshes: OcctMesh[] } };

let occt: Promise<Occt> | null = null;
function cadReader(wasmUrl: string) {
  occt ??= import("occt-import-js")
    .then((module) => {
      const create = ((module as { default?: unknown }).default ?? module) as (options: object) => Promise<Occt>;
      return create({ locateFile: (name: string) => (name.endsWith(".wasm") ? wasmUrl : name) });
    })
    .catch((error) => {
      occt = null;
      throw Object.assign(new Error(String((error as Error)?.message || error)), { reader: true });
    });
  return occt;
}

async function parse(job: ParseJob): Promise<MeshData[]> {
  if (job.format === "stl") {
    const { STLLoader } = await import("three/examples/jsm/loaders/STLLoader.js");
    const geometry = new STLLoader().parse(job.buffer);
    const color = geometry.getAttribute("color");
    return [
      {
        name: "",
        position: geometry.getAttribute("position").array as Float32Array,
        normal: geometry.getAttribute("normal")?.array as Float32Array | undefined,
        color: color ? (color.array as Float32Array) : undefined,
      },
    ];
  }
  if (job.format === "obj") {
    const { OBJLoader } = await import("three/examples/jsm/loaders/OBJLoader.js");
    const group = new OBJLoader().parse(new TextDecoder().decode(job.buffer));
    const meshes: MeshData[] = [];
    group.traverse((child) => {
      const mesh = child as import("three").Mesh;
      if (!mesh.isMesh) return;
      const geometry = mesh.geometry;
      const color = geometry.getAttribute("color");
      meshes.push({
        name: mesh.name || "",
        position: geometry.getAttribute("position").array as Float32Array,
        normal: geometry.getAttribute("normal")?.array as Float32Array | undefined,
        color: color ? (color.array as Float32Array) : undefined,
      });
    });
    return meshes;
  }
  if (job.format === "step" || job.format === "iges") {
    const reader = await cadReader(job.wasmUrl);
    const result = reader.ReadFile(job.format, new Uint8Array(job.buffer), {
      linearUnit: "millimeter",
      linearDeflectionType: "bounding_box_ratio",
      linearDeflection: 0.001,
      angularDeflection: 0.5,
    });
    if (!result.success) throw new Error("The CAD file could not be read.");
    return result.meshes.map((mesh) => ({
      name: mesh.name || "",
      position: Float32Array.from(mesh.attributes.position.array),
      normal: mesh.attributes.normal ? Float32Array.from(mesh.attributes.normal.array) : undefined,
      index: mesh.index ? Uint32Array.from(mesh.index.array) : undefined,
      rgb: mesh.color,
    }));
  }
  throw new Error(`Not read in the worker: ${job.format}`);
}

const post = (message: ParseResult, transfer: ArrayBuffer[] = []) =>
  (self as unknown as { postMessage: (m: ParseResult, t: ArrayBuffer[]) => void }).postMessage(message, transfer);
self.addEventListener("message", (event: MessageEvent<ParseJob>) => {
  parse(event.data).then(
    (meshes) => {
      const filled = meshes.filter((mesh) => mesh.position.length >= 9);
      if (!filled.length) post({ ok: false, error: "empty", message: "No surfaces." });
      else post({ ok: true, meshes: filled }, transferables(filled));
    },
    (error) => post({ ok: false, error: (error as { reader?: boolean })?.reader ? "reader" : "parse", message: String((error as Error)?.message || error) }),
  );
});
