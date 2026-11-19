// Fetches and reads a 3D file for the viewer (#384): the size limits of
// lib/model-formats.ts first (from the answer's length, before the file is
// downloaded), then STL, OBJ, STEP and IGES in the worker
// (parse-worker.ts), glTF/GLB and 3MF on the page with three.js's loaders.
// The result is a three.js object in the model's own coordinates.
import * as THREE from "three";
import { modelTooLarge, modelUnit, type LengthUnit, type ModelFormat } from "@/lib/model-formats";
import type { Up } from "@/lib/model-geometry";
import type { MeshData, ParseJob, ParseResult } from "./mesh-data";

export type LoadedModel = { root: THREE.Object3D; up: Up; unit: LengthUnit; assumedUnit: boolean; triangles: number };
export type LoadProblem =
  | { kind: "too-large"; limitMb: number }
  | { kind: "download" }
  | { kind: "parse" }
  | { kind: "empty" }
  | { kind: "compressed" }
  | { kind: "external" }
  | { kind: "reader"; offline: boolean };
export class ModelLoadError extends Error {
  constructor(readonly problem: LoadProblem) {
    super(problem.kind);
  }
}
const fail = (problem: LoadProblem) => new ModelLoadError(problem);

// The CAD reader's WebAssembly, served by Flowplan itself (app/occt).
export const OCCT_WASM = "/occt/occt-import-js.wasm";
export const DEFAULT_COLOR = 0x9aa4b8;

export async function loadModel(src: string, format: ModelFormat, signal: AbortSignal): Promise<LoadedModel> {
  let response: Response;
  try {
    response = await fetch(src, { credentials: "same-origin", signal });
  } catch (error) {
    if (signal.aborted) throw error;
    throw fail({ kind: "download" });
  }
  if (!response.ok) throw fail({ kind: "download" });
  const declared = Number(response.headers.get("content-length") || NaN);
  const early = modelTooLarge(format, declared);
  if (early) {
    void response.body?.cancel().catch(() => {});
    throw fail({ kind: "too-large", limitMb: early });
  }
  const buffer = await response.arrayBuffer();
  const late = modelTooLarge(format, buffer.byteLength);
  if (late) throw fail({ kind: "too-large", limitMb: late });

  if (format === "glb" || format === "gltf") return readGltf(buffer, format);
  if (format === "3mf") return read3mf(buffer);
  const meshes = await inWorker({ format, buffer, wasmUrl: new URL(OCCT_WASM, location.origin).href }, signal);
  const root = new THREE.Group();
  for (const data of meshes) root.add(meshOf(data));
  const { unit, assumed } = modelUnit(format);
  return { root, up: format === "obj" ? "y" : "z", unit, assumedUnit: assumed, triangles: countTriangles(root) };
}

function inWorker(job: ParseJob, signal: AbortSignal): Promise<MeshData[]> {
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
    worker.onmessage = (event: MessageEvent<ParseResult>) => {
      done();
      const result = event.data;
      if (result.ok) resolve(result.meshes);
      else if (result.error === "reader") reject(fail({ kind: "reader", offline: navigator.onLine === false }));
      else reject(fail({ kind: result.error === "empty" ? "empty" : "parse" }));
    };
    worker.onerror = () => {
      done();
      reject(fail({ kind: job.format === "step" || job.format === "iges" ? "reader" : "parse", offline: navigator.onLine === false } as LoadProblem));
    };
    worker.postMessage(job, [job.buffer]);
  });
}

export function surfaceMaterial(rgb?: [number, number, number], vertexColors = false) {
  return new THREE.MeshStandardMaterial({
    color: rgb ? new THREE.Color(rgb[0], rgb[1], rgb[2]) : DEFAULT_COLOR,
    vertexColors,
    metalness: 0.05,
    roughness: 0.6,
    // STL and OBJ files often mix up the sides of their triangles.
    side: THREE.DoubleSide,
  });
}

function meshOf(data: MeshData) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(data.position, 3));
  if (data.normal && data.normal.length === data.position.length) geometry.setAttribute("normal", new THREE.BufferAttribute(data.normal, 3));
  if (data.color && data.color.length === data.position.length) geometry.setAttribute("color", new THREE.BufferAttribute(data.color, 3));
  if (data.index) geometry.setIndex(new THREE.BufferAttribute(data.index, 1));
  if (!geometry.getAttribute("normal")) geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  const mesh = new THREE.Mesh(geometry, surfaceMaterial(data.rgb, !!geometry.getAttribute("color")));
  mesh.name = data.name;
  return mesh;
}

function countTriangles(root: THREE.Object3D) {
  let count = 0;
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    const geometry = mesh.geometry;
    count += Math.floor((geometry.index ? geometry.index.count : geometry.getAttribute("position").count) / 3);
  });
  return count;
}

async function readGltf(buffer: ArrayBuffer, format: ModelFormat): Promise<LoadedModel> {
  const [{ GLTFLoader }, { MeshoptDecoder }] = await Promise.all([
    import("three/examples/jsm/loaders/GLTFLoader.js"),
    import("three/examples/jsm/libs/meshopt_decoder.module.js"),
  ]);
  if (format === "gltf") {
    // Only self-contained glTF files (data: URIs): the other files of one
    // that refers to them (scene.bin, textures) are not in Flowplan with it.
    const text = new TextDecoder().decode(buffer);
    try {
      const json = JSON.parse(text) as { buffers?: { uri?: string }[]; images?: { uri?: string }[] };
      if ([...(json.buffers || []), ...(json.images || [])].some((item) => item.uri && !item.uri.startsWith("data:"))) throw fail({ kind: "external" });
    } catch (error) {
      if (error instanceof ModelLoadError) throw error;
      throw fail({ kind: "parse" });
    }
  }
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  let gltf;
  try {
    gltf = await loader.parseAsync(buffer, "");
  } catch (error) {
    if (/DRACO|KTX2/i.test(String((error as Error)?.message || error))) throw fail({ kind: "compressed" });
    throw fail({ kind: "parse" });
  }
  const root = gltf.scene;
  root.updateMatrixWorld(true);
  const triangles = countTriangles(root);
  if (!triangles) throw fail({ kind: "empty" });
  return { root, up: "y", unit: "m", assumedUnit: false, triangles };
}

async function read3mf(buffer: ArrayBuffer): Promise<LoadedModel> {
  const [{ ThreeMFLoader }, { unzipSync, strFromU8 }] = await Promise.all([
    import("three/examples/jsm/loaders/3MFLoader.js"),
    import("three/examples/jsm/libs/fflate.module.js"),
  ]);
  // The unit the file names on its model (millimetres when it names none).
  let declared: string | null = null;
  let root: THREE.Group;
  try {
    const parts = unzipSync(new Uint8Array(buffer), { filter: (file) => /^3D\/[^/]+\.model$/i.test(file.name) });
    for (const data of Object.values(parts)) {
      declared ??= /<model\b[^>]*\bunit="([a-z]+)"/i.exec(strFromU8(data.subarray(0, 4096)))?.[1] || null;
    }
    root = new ThreeMFLoader().parse(buffer);
  } catch {
    throw fail({ kind: "parse" });
  }
  // The loader's own materials are flat colours; the viewer's light needs
  // the standard one (with the file's colour where it has one).
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    const color = (material as THREE.MeshPhongMaterial | undefined)?.color;
    const vertexColors = !!mesh.geometry.getAttribute("color");
    mesh.material = surfaceMaterial(color && !vertexColors && color.getHex() !== 0xffffff ? [color.r, color.g, color.b] : undefined, vertexColors);
    if (!mesh.geometry.getAttribute("normal")) mesh.geometry.computeVertexNormals();
  });
  root.updateMatrixWorld(true);
  const triangles = countTriangles(root);
  if (!triangles) throw fail({ kind: "empty" });
  const { unit } = modelUnit("3mf", declared);
  return { root, up: "z", unit, assumedUnit: false, triangles };
}
