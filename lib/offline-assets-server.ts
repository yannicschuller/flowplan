// The list of the client build's files for offline use (#47), read from the
// build output at runtime: .next/static holds exactly what this server
// serves under /_next/static, with `next start` and in the
// standalone server of the Docker image (which copies .next/static next to
// server.js). A list written at build time could miss the image's layout or
// belong to another build; the directory cannot.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { OfflineAsset, OfflineAssets } from "./offline-assets";

// Source maps are never requested by the app; .woff and .ttf are fallbacks
// of fonts that also come as .woff2, which every supported browser loads.
const FALLBACK_FONT = /\.(woff|ttf)$/;
const fontName = (file: string) => file.replace(/\.[^.]+\.(woff2?|ttf)$/, "");

export function listStaticAssets(staticDir: string): OfflineAsset[] {
  if (!existsSync(staticDir)) return [];
  const result: OfflineAsset[] = [];
  const walk = (dir: string, prefix: string) => {
    const names = readdirSync(dir);
    const woff2 = new Set(names.filter((n) => n.endsWith(".woff2")).map(fontName));
    for (const name of names) {
      const path = join(dir, name);
      const stat = statSync(path);
      if (stat.isDirectory()) walk(path, `${prefix}${name}/`);
      else if (name.endsWith(".map")) continue;
      else if (FALLBACK_FONT.test(name) && woff2.has(fontName(name))) continue;
      else result.push({ path: `/_next/static/${prefix}${encodeURI(name)}`, size: stat.size });
    }
  };
  walk(staticDir, "");
  return result.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// The files of public/ the app's page loads besides the build: its fonts
// (fonts.css and the .woff2 it names) and icons. A service worker stores
// them as it serves them; the iPhone and iPad app, which has none, needs
// them listed to show the stored page in Flowplan's type.
export function listPublicAssets(publicDir: string): OfflineAsset[] {
  const result: OfflineAsset[] = [];
  const add = (path: string, url: string) => {
    try {
      const stat = statSync(path);
      if (stat.isFile()) result.push({ path: url, size: stat.size });
    } catch {}
  };
  add(join(publicDir, "fonts.css"), "/fonts.css");
  for (const [dir, keep] of [
    ["fonts", /\.woff2$/],
    ["icons", /\.(png|svg|webp|ico)$/],
  ] as const) {
    if (!existsSync(join(publicDir, dir))) continue;
    for (const name of readdirSync(join(publicDir, dir)).sort())
      if (keep.test(name)) add(join(publicDir, dir, name), `/${dir}/${encodeURI(name)}`);
  }
  return result;
}

// The build id Next writes next to the build; a build without one (an
// unfinished build) is named after its files.
export function readBuildId(distDir: string, files: OfflineAsset[]): string {
  try {
    const id = readFileSync(join(distDir, "BUILD_ID"), "utf8").trim();
    if (/^[\w-]{1,64}$/.test(id)) return id;
  } catch {}
  let hash = 0;
  for (const { path, size } of files) for (const c of `${path}:${size};`) hash = (hash * 31 + c.charCodeAt(0)) | 0;
  return `files-${(hash >>> 0).toString(36)}`;
}

// Where the build lies: the standalone server names it in its config,
// otherwise FLOWPLAN_DIST_DIR (a second development server) or .next.
export function distDir(cwd = process.cwd()) {
  let dir = process.env.FLOWPLAN_DIST_DIR || ".next";
  try {
    const config = JSON.parse(process.env.__NEXT_PRIVATE_STANDALONE_CONFIG || "{}") as { distDir?: string };
    if (config.distDir) dir = config.distDir;
  } catch {}
  return join(/*turbopackIgnore: true*/ cwd, dir);
}

export function buildOfflineAssets(dir: string, version: string, publicDir?: string): OfflineAssets {
  const built = listStaticAssets(join(dir, "static"));
  // The build id comes from the build's own files only.
  const build = readBuildId(dir, built);
  const files = [...built, ...(publicDir ? listPublicAssets(publicDir) : [])];
  return {
    build,
    version,
    files,
    bytes: files.reduce((sum, file) => sum + file.size, 0),
  };
}

// A production build does not change while it runs: read once.
// The development server builds on demand and cannot run offline anyway
// (it hydrates only with its live-reload connection): nothing to store.
let cached: OfflineAssets | null = null;
export function offlineAssets(): OfflineAssets {
  if (process.env.NODE_ENV === "development")
    return { build: "development", version: process.env.FLOWPLAN_VERSION || "", files: [], bytes: 0 };
  if (cached) return cached;
  const result = buildOfflineAssets(distDir(), process.env.FLOWPLAN_VERSION || "", join(/*turbopackIgnore: true*/ process.cwd(), "public"));
  if (process.env.NODE_ENV === "production" && result.files.length) cached = result;
  return result;
}
