// Files pdf.js needs in the browser for some PDFs: standard fonts,
// character maps and WebAssembly image decoders – served from the package.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const runtime = "nodejs";
const folders = new Set(["cmaps", "standard_fonts", "wasm"]);
const types: Record<string, string> = {
  bcmap: "application/octet-stream",
  pfb: "application/octet-stream",
  ttf: "font/ttf",
  wasm: "application/wasm",
  js: "text/javascript",
  mjs: "text/javascript",
};

export async function GET(_req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const [folder, name, ...rest] = (await params).path;
  const ext = name?.split(".").pop() || "";
  if (rest.length || !folders.has(folder) || !/^[A-Za-z0-9_.-]+$/.test(name || "") || !types[ext])
    return new Response("Not found", { status: 404 });
  try {
    const body = await readFile(join(process.cwd(), "node_modules", "pdfjs-dist", folder, name));
    return new Response(body, {
      headers: { "Content-Type": types[ext], "Cache-Control": "public, max-age=604800, immutable" },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
