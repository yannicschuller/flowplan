// The CAD reader of the 3D viewer (#384, components/viewer3d/parse-worker.ts):
// OpenCascade compiled to WebAssembly (occt-import-js, LGPL-2.1 – loaded as
// its own file from the package, so it can be replaced), served from
// Flowplan's own origin, never from a CDN, and fetched only when a STEP or
// IGES file is opened. Not part of the offline copy
// (lib/offline-assets-server.ts lists the build's files only): about 7 MB
// that most people never need.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const runtime = "nodejs";
const FILES: Record<string, string> = { "occt-import-js.wasm": "occt-import-js.wasm" };

export async function GET(_req: Request, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  const name = Object.hasOwn(FILES, file) ? FILES[file] : null;
  if (!name) return new Response("Not found", { status: 404 });
  try {
    const body = await readFile(join(process.cwd(), "node_modules", "occt-import-js", "dist", name));
    return new Response(body, {
      headers: { "Content-Type": "application/wasm", "Cache-Control": "public, max-age=604800" },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
