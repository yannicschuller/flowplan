// The draw.io Flowplan ships (#454, lib/drawio.ts): the web app of the
// pinned jgraph/drawio release (Apache-2.0, THIRD_PARTY_NOTICES.md) that
// scripts/drawio-fetch.mjs unpacks into vendor/drawio (the Docker image:
// /app/vendor/drawio; FLOWPLAN_DRAWIO_DIR names another folder). Served
// unchanged by app/drawio/[...path]/route.ts under /drawio/<version>/ –
// except js/PreConfig.js, draw.io's place for a deployment's settings,
// which comes from here. Server only.
import { readFile, stat } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import { drawioConfig, isDrawioVersion, type DrawioConfig } from "./drawio";
import { DRAWIO_OFFLINE_LIST } from "./drawio-offline";

export const DRAWIO_MARKER = ".flowplan-drawio.json";
export const drawioBundleDir = () =>
  process.env.FLOWPLAN_DRAWIO_DIR?.trim() || join(/*turbopackIgnore: true*/ process.cwd(), "vendor", "drawio");

// The shipped copy's version, read from the marker the fetch script
// writes last (an unfinished copy has none); looked at again after a
// minute, so a copy fetched while the development server runs is found.
let known: { dir: string; at: number; version: string | null } | null = null;
export function bundledDrawio(): { dir: string; version: string } | null {
  const dir = drawioBundleDir();
  if (!known || known.dir !== dir || Date.now() - known.at > 60_000) {
    let version: string | null = null;
    try {
      const marker = JSON.parse(readFileSync(join(/*turbopackIgnore: true*/ dir, DRAWIO_MARKER), "utf8")) as { version?: unknown };
      if (isDrawioVersion(marker.version)) version = marker.version;
    } catch {}
    known = { dir, at: Date.now(), version };
  }
  return known.version ? { dir, version: known.version } : null;
}
export const forgetBundledDrawio = () => {
  known = null;
};

// The editor this server offers: DRAWIO_URL, else the shipped copy, else
// the public embed.diagrams.net.
export const drawioServerConfig = (): DrawioConfig | null =>
  drawioConfig(process.env.DRAWIO_URL, bundledDrawio()?.version ?? null);

// Content Security Policy of /drawio/* – draw.io's own documents and files,
// shown only inside Flowplan's editor dialog (components/drawio-editor.tsx).
// draw.io runs on Flowplan's origin (so that public/sw.js can keep it for
// offline use, which a sandboxed opaque origin would rule out): it could
// reach the parent page and Flowplan's API with the person's session, so
// nothing but draw.io's own files may run in it.
// - script-src 'self': only draw.io's script files from this origin – no
//   'unsafe-inline' (draw.io's index.html has no inline scripts since its
//   bootstrap moved to js/bootstrap.js and js/main.js), no 'unsafe-eval'
//   (draw.io evaluates code only for codecs with allowEval, which stays
//   off). HTML in diagram labels can never run a script or an on…=
//   attribute, and javascript: links do nothing. Nothing else on this
//   origin serves JavaScript a person controls: uploads are answered as
//   images, media or attachments with nosniff (lib/file-response.ts).
//   'wasm-unsafe-eval': draw.io's routing (libavoid) and layouts compile
//   WebAssembly, which cannot reach the page by itself.
// - style-src 'unsafe-inline': draw.io styles everything inline (and its
//   index.html has a <style>) – styles cannot run code.
// - img-src, font-src, media-src, connect-src: this origin, data: and blob:
//   only, no external host. A diagram's pictures from elsewhere, Google
//   Fonts, icon and export servers are not loaded (the stored picture of a
//   diagram drops external references anyway, lib/drawio-svg.ts), so
//   editing tells no other host about the diagram.
// - frame-src, worker-src: this origin and blob: (draw.io's print preview
//   and layout workers).
// - frame-ancestors 'self': only Flowplan's own pages may frame it.
// - form-action 'none', object-src 'none', base-uri 'self'.
// Flowplan's own pages keep their strict nonce-based policy (proxy.ts),
// which needs nothing new: the frame is same-origin ('self').
export function drawioContentSecurityPolicy() {
  return [
    "default-src 'none'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' data: blob:",
    "connect-src 'self' data: blob:",
    "frame-src 'self' blob:",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
    "frame-ancestors 'self'",
  ].join("; ");
}

// draw.io's deployment settings (its own js/PreConfig.js, loaded before
// the app): no export, lightbox or viewer server elsewhere, its base the
// folder it is served from, and the switches of BUNDLED_DRAWIO_PARAMS
// once more – whatever the address of the frame says.
export const DRAWIO_PRECONFIG = `// Flowplan's settings for the draw.io it ships (lib/drawio-bundle.ts).
window.DRAWIO_PUBLIC_BUILD = true;
window.EXPORT_URL = null;
window.DRAWIO_BASE_URL = window.location.href.replace(/[?#].*$/, "").replace(/\\/[^/]*$/, "");
window.DRAWIO_LIGHTBOX_URL = window.DRAWIO_BASE_URL;
window.DRAWIO_VIEWER_URL = null;
window.DRAW_MATH_URL = "math4/es5";
window.DRAWIO_CONFIG = null;
urlParams["sync"] = "manual";
urlParams["stealth"] = "1";
urlParams["lockdown"] = "1";
urlParams["pwa"] = "0";
`;

// The files draw.io loads to start in embed mode, for the warm-up of the
// offline copy (lib/drawio-offline.ts): "" is its page. Those that exist in
// this copy (the shape bundle's name carries a version).
export function drawioStartFiles(dir: string): string[] {
  let shapes: string[] = [];
  try {
    shapes = readdirSync(join(/*turbopackIgnore: true*/ dir, "js")).filter((name) => /^shapes-[\d-]+\.min\.js$/.test(name)).map((name) => `js/${name}`);
  } catch {}
  const files = [
    "styles/grapheditor.css",
    "styles/high-contrast.css",
    "js/bootstrap.js",
    "js/main.js",
    "js/PostConfig.js",
    "js/app.min.js",
    "mxgraph/css/common.css",
    ...shapes,
    "js/stencils.min.js",
    "js/extensions.min.js",
  ].filter((file) => existsSync(join(/*turbopackIgnore: true*/ dir, file)));
  return ["", "js/PreConfig.js", ...files];
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".gif": "image/gif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
};
// The file of a request's path below /drawio/<version>/, or null: no
// hidden names (the marker), nothing outside the folder, known types only.
export function drawioFilePath(dir: string, parts: string[]): string | null {
  const rel = parts.length ? parts.join("/") : "index.html";
  // draw.io's names hold spaces, commas and brackets (img/lib/…).
  if (!parts.every((part) => part && !part.startsWith(".") && !/[\\/\0]/.test(part))) return null;
  if (!TYPES[extname(rel).toLowerCase()]) return null;
  const path = normalize(join(/*turbopackIgnore: true*/ dir, rel));
  return path.startsWith(normalize(dir) + sep) ? path : null;
}

const notFound = () =>
  new Response("Not found", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'" },
  });

// GET /drawio/<version>/<file>. Another version than the shipped one is not
// served (a frame of an older release reloads after an update instead of
// mixing files); /drawio/<version> goes on to its folder.
export async function drawioFileResponse(request: Request, path: string[]): Promise<Response> {
  const bundle = bundledDrawio();
  const [version, ...rest] = path;
  if (!bundle || version !== bundle.version) return notFound();
  if (!rest.length && !new URL(request.url).pathname.endsWith("/")) {
    const url = new URL(request.url);
    return new Response(null, { status: 308, headers: { Location: `${url.pathname}/${url.search}`, "Cache-Control": "no-store" } });
  }
  const headers: Record<string, string> = {
    "Content-Security-Policy": drawioContentSecurityPolicy(),
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "same-origin",
    // The service worker names its copy after it (public/sw.js).
    "X-Flowplan-Drawio": bundle.version,
  };
  // The files of one version never change; the page and the settings may
  // with a Flowplan update of the same draw.io.
  const page = !rest.length || (rest.length === 1 && rest[0] === "index.html");
  const settings = rest.join("/") === "js/PreConfig.js";
  const list = rest.join("/") === DRAWIO_OFFLINE_LIST;
  headers["Cache-Control"] = page || settings || list ? "public, max-age=3600" : "public, max-age=31536000, immutable";
  if (settings) return new Response(DRAWIO_PRECONFIG, { headers: { ...headers, "Content-Type": TYPES[".js"] } });
  if (list) return Response.json({ version: bundle.version, files: drawioStartFiles(bundle.dir) }, { headers });
  const file = drawioFilePath(bundle.dir, rest);
  if (!file) return notFound();
  try {
    if (!(await stat(/*turbopackIgnore: true*/ file)).isFile()) return notFound();
    const body = await readFile(/*turbopackIgnore: true*/ file);
    return new Response(request.method === "HEAD" ? null : body, {
      headers: { ...headers, "Content-Type": TYPES[extname(file).toLowerCase()] },
    });
  } catch {
    return notFound();
  }
}
