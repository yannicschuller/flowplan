import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Manifest } from "./compare";

// The gallery's page: index.html (a static shell), gallery.css (Flowplan's
// own colour, radius and type tokens, read from app/globals.css at write
// time, plus the page's styles), gallery.js and manifest.json – the same
// files for a local run and the nightly site (gallery.flowplan.org). No
// inline scripts or styles, nothing from other hosts. Opened as a local
// file the page cannot fetch manifest.json, so the same data is also in
// manifest.js, which only a file:// page loads.

export type Shot = {
  scene: string;
  group: string;
  title: string;
  path: string;
  variant: string;
  file: string;
  error?: string;
  pageErrors: string[];
  ms: number;
};

const root = process.cwd();
const assets = join(import.meta.dirname, "assets");

// The tokens the page uses, light (:root) and dark ([data-theme="dark"]).
const TOKENS = [
  "--bg", "--surface", "--sidebar", "--hover", "--border", "--text", "--muted", "--secondary",
  "--blue", "--blue-light", "--accent-strong", "--on-accent", "--focus-ring", "--signal",
  "--code-inline-fg", "--shadow", "--radius", "--font-ui", "--font-display", "--font-mono",
];

// The first rule with exactly this selector, its custom properties.
function declarations(css: string, selector: string) {
  const start = `\n${css}`.indexOf(`\n${selector} {\n`);
  if (start < 0) throw new Error(`app/globals.css has no "${selector} {" rule`);
  const body = css.slice(css.indexOf("{", start) + 1, css.indexOf("\n}", start));
  const found = new Map<string, string>();
  for (const m of body.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) found.set(m[1], m[2].replace(/\s+/g, " ").trim());
  return found;
}

export function themeCss(globals: string) {
  const light = declarations(globals, ":root");
  const dark = declarations(globals, '[data-theme="dark"]');
  const missing = TOKENS.filter((t) => !light.has(t));
  if (missing.length) throw new Error(`app/globals.css :root lacks ${missing.join(", ")}`);
  const lines = (from: Map<string, string>) =>
    TOKENS.filter((t) => from.has(t))
      .map((t) => `  ${t}: ${from.get(t)};`)
      .join("\n");
  // Dark overrides only what it redefines (radius and type stay).
  const darkBlock = lines(dark);
  return `/* Flowplan's tokens, from app/globals.css. */
:root {
${lines(light)}
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
${darkBlock.replace(/^/gm, "  ")}
    color-scheme: dark;
  }
}
:root[data-theme="dark"] {
${darkBlock}
  color-scheme: dark;
}
`;
}

export function writeReport(dir: string, manifest: Manifest) {
  const globals = readFileSync(join(root, "app/globals.css"), "utf8");
  writeFileSync(join(dir, "gallery.css"), themeCss(globals) + readFileSync(join(assets, "gallery.css"), "utf8"));
  copyFileSync(join(assets, "gallery.js"), join(dir, "gallery.js"));
  copyFileSync(join(root, "public/icon.svg"), join(dir, "logo.svg"));
  mkdirSync(join(dir, "fonts"), { recursive: true });
  copyFileSync(join(root, "public/fonts/instrument-sans-latin-standard-normal.woff2"), join(dir, "fonts/instrument-sans.woff2"));
  const json = JSON.stringify(manifest);
  writeFileSync(join(dir, "manifest.json"), json);
  writeFileSync(join(dir, "manifest.js"), `window.GALLERY_MANIFEST = ${json.replace(/</g, "\\u003c")};\n`);
  const file = join(dir, "index.html");
  writeFileSync(file, readFileSync(join(assets, "index.html"), "utf8"));
  return file;
}
