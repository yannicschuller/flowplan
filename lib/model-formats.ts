// 3D and CAD files (#384): which files the 3D viewer opens
// (components/model-viewer.tsx), the type an upload of one is stored with,
// and how large a file the viewer takes. Pure, shared by the server (upload
// type) and the browser (viewer, icons); no three.js here.
//
// Mesh formats (STL, OBJ, glTF/GLB, 3MF) are read with three.js; STEP and
// IGES are CAD formats (exact surfaces), triangulated in the browser by
// OpenCascade compiled to WebAssembly (occt-import-js), which is loaded
// only when such a file is opened.

export type ModelFormat = "stl" | "obj" | "gltf" | "glb" | "3mf" | "step" | "iges";

const EXTENSIONS: Record<string, ModelFormat> = {
  stl: "stl",
  obj: "obj",
  gltf: "gltf",
  glb: "glb",
  "3mf": "3mf",
  step: "step",
  stp: "step",
  iges: "iges",
  igs: "iges",
};
// The extensions, for file pickers (accept=…) and the documentation.
export const MODEL_EXTENSIONS = Object.keys(EXTENSIONS).map((ext) => `.${ext}`);

// The type an upload is stored with (registered with IANA, model/*).
export const MODEL_MIMES: Record<ModelFormat, string> = {
  stl: "model/stl",
  obj: "model/obj",
  gltf: "model/gltf+json",
  glb: "model/gltf-binary",
  "3mf": "model/3mf",
  step: "model/step",
  iges: "model/iges",
};
// Older or vendor names browsers and systems send for the same files.
const MIME_ALIASES: Record<string, ModelFormat> = {
  "application/sla": "stl",
  "application/vnd.ms-pki.stl": "stl",
  "model/x.stl-binary": "stl",
  "model/x.stl-ascii": "stl",
  "application/vnd.ms-3mfdocument": "3mf",
  "application/step": "step",
  "application/stp": "step",
  "application/iges": "iges",
};

// The format of a file name (by its extension), or null.
export function modelFormatOf(name: string): ModelFormat | null {
  const match = /\.([a-z0-9]+)$/i.exec((name || "").trim());
  return match ? EXTENSIONS[match[1].toLowerCase()] || null : null;
}
export const isModelName = (name: string) => modelFormatOf(name) !== null;

// The format of a stored type, or null.
export function modelFormatOfMime(mime: string): ModelFormat | null {
  const type = (mime || "").toLowerCase().split(";")[0].trim();
  for (const [format, known] of Object.entries(MODEL_MIMES)) if (known === type) return format as ModelFormat;
  return MIME_ALIASES[type] || null;
}
// A file the viewer opens: by its type, else by its name.
export const modelFormatOfFile = (file: { name: string; mime?: string | null }) =>
  modelFormatOfMime(file.mime || "") || modelFormatOf(file.name);

// STEP and IGES need the CAD reader (several MB of WebAssembly).
export const isCadFormat = (format: ModelFormat) => format === "step" || format === "iges";

// Short names for the interface.
export const MODEL_FORMAT_LABELS: Record<ModelFormat, string> = {
  stl: "STL",
  obj: "OBJ",
  gltf: "glTF",
  glb: "GLB",
  "3mf": "3MF",
  step: "STEP",
  iges: "IGES",
};

// The largest file the viewer reads: a mesh is held in memory a few times
// over while it is read (file, parsed arrays, GPU buffers); a CAD file is
// triangulated in WebAssembly memory, which grows much faster with the
// size of the file.
export const MB = 1024 * 1024;
export const MODEL_LIMITS = { mesh: 200 * MB, cad: 100 * MB } as const;
export const modelSizeLimit = (format: ModelFormat) => (isCadFormat(format) ? MODEL_LIMITS.cad : MODEL_LIMITS.mesh);
// null when the file is small enough, otherwise the limit in MB.
export function modelTooLarge(format: ModelFormat, bytes: number): number | null {
  const limit = modelSizeLimit(format);
  return Number.isFinite(bytes) && bytes > limit ? limit / MB : null;
}

// Whether the content looks like the format its name says – loosely: the
// file is only ever offered as a download (lib/file-response.ts) and read
// by the viewer, which reports what it cannot read.
export function looksLikeModel(format: ModelFormat, head: Uint8Array): boolean {
  const text = (from: number, length: number) => String.fromCharCode(...head.subarray(from, from + length));
  const start = text(0, Math.min(head.length, 512)).replace(/^﻿/, "").trimStart();
  switch (format) {
    case "glb":
      return text(0, 4) === "glTF";
    case "3mf":
      // A ZIP archive (Open Packaging Conventions).
      return head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
    case "gltf":
      return start.startsWith("{");
    case "step":
      return start.startsWith("ISO-10303-21");
    case "stl":
      // Binary STL has no signature (an 80-byte header, then the count);
      // ASCII STL starts with "solid". Anything at least as long as the header.
      return head.length >= 84 || /^solid\b/i.test(start);
    case "obj":
    case "iges":
      // Plain text: no NUL bytes at the start.
      return head.length > 0 && !head.subarray(0, 512).includes(0);
  }
}

// The type to store for an upload named like a 3D file, or null when the
// name is not one (the caller's usual check applies then). A file whose
// content does not match its name becomes a plain download.
export function modelUploadMime(name: string, head: Uint8Array): string | null {
  const format = modelFormatOf(name);
  if (!format) return null;
  return looksLikeModel(format, head) ? MODEL_MIMES[format] : "application/octet-stream";
}

// The unit a format's coordinates are in. STEP and IGES are converted to
// millimetres by the reader; glTF is in metres by definition; 3MF says its
// unit in the file (millimetres by default); STL and OBJ store none – CAD
// and slicer programs write millimetres, so that is assumed (and said).
export type LengthUnit = "µm" | "mm" | "cm" | "m" | "in" | "ft";
export function modelUnit(format: ModelFormat, declared?: string | null): { unit: LengthUnit; assumed: boolean } {
  if (format === "gltf" || format === "glb") return { unit: "m", assumed: false };
  if (format === "3mf") {
    const units: Record<string, LengthUnit> = { micron: "µm", millimeter: "mm", centimeter: "cm", meter: "m", inch: "in", foot: "ft" };
    return { unit: units[(declared || "millimeter").toLowerCase()] || "mm", assumed: false };
  }
  if (format === "stl" || format === "obj") return { unit: "mm", assumed: true };
  return { unit: "mm", assumed: false };
}
