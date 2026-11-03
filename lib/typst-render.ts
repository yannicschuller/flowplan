import { TYPST_FONTS } from "./typst-assets";

// Typst code blocks as a picture (#92): the Typst compiler and renderer
// (typst.ts, WebAssembly) and the default fonts load from this server
// (app/typst/[file]/route.ts) the first time a Typst block shows its
// preview – nothing of it is part of the page's JavaScript. The result is an
// SVG, shown as an image (no scripts, no links). Typst packages
// (@preview/…) and files are not available: there is no registry.
type Compiler = import("@myriaddreamin/typst.ts").TypstCompiler;
type Renderer = import("@myriaddreamin/typst.ts").TypstRenderer;
let engine: Promise<{ compiler: Compiler; renderer: Renderer }> | null = null;
let queue: Promise<unknown> = Promise.resolve();
const cache = new Map<string, Promise<string>>();
export const MAX_TYPST_LENGTH = 50_000;
// A page as wide as a document column, as long as its content; the block's
// own #set page(…) still wins.
const PAGE = "#set page(width: 16cm, height: auto, margin: 1em)\n";

function load() {
  engine ||= (async () => {
    const typst = await import("@myriaddreamin/typst.ts");
    const fonts = await Promise.all(
      TYPST_FONTS.map(async (name) => {
        const response = await fetch(`/typst/${name}`);
        if (!response.ok) throw new Error(`font ${name}`);
        return new Uint8Array(await response.arrayBuffer());
      }),
    );
    const compiler = typst.createTypstCompiler();
    const renderer = typst.createTypstRenderer();
    await Promise.all([
      compiler.init({
        getModule: () => fetch("/typst/compiler.wasm"),
        // Only the fonts above: no font CDN.
        beforeBuild: [typst.loadFonts(fonts, { assets: false })],
      }),
      renderer.init({ getModule: () => fetch("/typst/renderer.wasm") }),
    ]);
    return { compiler, renderer };
  })();
  engine.catch(() => (engine = null));
  return engine;
}

type Diagnostic = { range?: string; message?: string; severity?: string };
// "Line 3: unknown variable: x" (lines of the block, without the page line).
export function typstError(diagnostics: Diagnostic[] | undefined, line: (n: number) => string) {
  const error = diagnostics?.find((d) => d.severity === "error") || diagnostics?.[0];
  if (!error) return null;
  const at = /^(\d+):/.exec(error.range || "");
  const row = at ? Math.max(1, Number(at[1])) : 0;
  return `${row ? `${line(row)}: ` : ""}${error.message || "Typst"}`;
}

// The SVG of a Typst text; rejects with the first error (its line).
export function renderTypst(source: string, line: (n: number) => string = (n) => `Line ${n}`): Promise<string> {
  if (source.length > MAX_TYPST_LENGTH) return Promise.reject(new Error("Typst > 50,000"));
  const cached = cache.get(source);
  if (cached) return cached;
  const result = queue.then(async () => {
    const { compiler, renderer } = await load();
    compiler.addSource("/main.typ", PAGE + source);
    const compiled = (await compiler.compile({ mainFilePath: "/main.typ", diagnostics: "full" })) as {
      result?: Uint8Array;
      diagnostics?: Diagnostic[];
    };
    if (!compiled.result) throw new Error(typstError(compiled.diagnostics, line) || "Typst");
    return renderer.runWithSession(async (session) => {
      renderer.manipulateData({ renderSession: session, action: "reset", data: compiled.result! });
      // Without the renderer's text-selection script (an <img> runs none,
      // and its unescaped "&&" would break the SVG).
      const svg = String(await renderer.renderSvg({ renderSession: session, data_selection: { body: true, defs: true, css: true, js: false } }));
      return svg.replace(/<script\b[\s\S]*?<\/script>/gi, "");
    });
  });
  queue = result.catch(() => undefined);
  cache.set(source, result);
  result.catch(() => cache.delete(source));
  if (cache.size > 20) cache.delete(cache.keys().next().value!);
  return result;
}
