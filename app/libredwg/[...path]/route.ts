// The DWG reader of the drawing viewer (#384, components/viewer2d/
// parse-worker.ts): LibreDWG compiled to WebAssembly (@mlightcad/
// libredwg-web, GPL-3.0 – compatible with Flowplan's AGPL-3.0; its source
// is at github.com/mlightcad/libredwg-web and the LibreDWG project). Its
// three files are served unchanged from the package, from Flowplan's own
// origin, never from a CDN, and only when a DWG file is opened: the
// wrapper imports the module, which fetches the WebAssembly next to it.
// Not part of the offline copy (lib/offline-assets-server.ts lists the
// build's files only): about 11 MB (2.5 MB compressed) that most people
// never need. The Content Security Policy needs nothing new: the worker
// imports same-origin modules, and 'wasm-unsafe-eval' is already allowed.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const runtime = "nodejs";
const FILES: Record<string, string> = {
  "dist/libredwg-web.js": "text/javascript; charset=utf-8",
  "wasm/libredwg-web.js": "text/javascript; charset=utf-8",
  "wasm/libredwg-web.wasm": "application/wasm",
};

export async function GET(_req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const file = (path || []).join("/");
  const type = Object.hasOwn(FILES, file) ? FILES[file] : null;
  if (!type) return new Response("Not found", { status: 404 });
  try {
    const body = await readFile(join(process.cwd(), "node_modules", "@mlightcad", "libredwg-web", ...file.split("/")));
    return new Response(body, {
      headers: { "Content-Type": type, "Cache-Control": "public, max-age=604800", "X-Content-Type-Options": "nosniff" },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
