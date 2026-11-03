// The Typst preview of code blocks (#92, lib/typst-render.ts) in the
// browser: the compiler and renderer as WebAssembly and the default fonts,
// served from their packages – loaded only when a Typst block is previewed,
// never from a CDN.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { TYPST_FONTS } from "@/lib/typst-assets";

export const runtime = "nodejs";
const FILES: Record<string, string[]> = {
  "compiler.wasm": ["@myriaddreamin", "typst-ts-web-compiler", "pkg", "typst_ts_web_compiler_bg.wasm"],
  "renderer.wasm": ["@myriaddreamin", "typst-ts-renderer", "pkg", "typst_ts_renderer_bg.wasm"],
  ...Object.fromEntries(TYPST_FONTS.map((name) => [name, ["@typst-wasm", "fonts", "dist", "files", name]])),
};
const TYPES: Record<string, string> = { wasm: "application/wasm", otf: "font/otf", ttf: "font/ttf" };

export async function GET(_req: Request, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  const path = Object.hasOwn(FILES, file) ? FILES[file] : null;
  if (!path) return new Response("Not found", { status: 404 });
  try {
    const body = await readFile(join(process.cwd(), "node_modules", ...path));
    return new Response(body, {
      headers: {
        "Content-Type": TYPES[file.split(".").pop() || ""] || "application/octet-stream",
        "Cache-Control": "public, max-age=604800",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
