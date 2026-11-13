// Controls in the accent follow a workspace's accent colour (#196, #277):
// they use var(--blue) and its relatives, or var(--accent, <colour>) where
// Flowplan's own look has a slightly different colour. This guards against
// new hard-coded brand blues in the style sheets and the components; the
// places that keep Flowplan's colours on purpose are listed with the reason.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Flowplan's accent, its dark-mode version and its derivatives, the hover
// literal and the mark's gradient – with or without an alpha byte.
const BRAND = /#(?:3b3fd8|959bff|2c2fb5|b9bcff|ecebfc|2a2a55|2468cf|4146e6|6a3fe0|2b2fb8|2f33b8|6371de|5561c7)(?:[0-9a-f]{2})?\b/gi;

// Custom properties that define the default palette (lib/workspace-theme.ts
// overrides them) or are palettes of their own.
const TOKENS = new Set(["--blue", "--blue-light", "--accent-strong", "--focus-ring", "--cell-selection", "--cell-selection-strong", "--primary-hover", "--chart-1", "--auth-panel"]);
// Rules that keep Flowplan's colours on purpose.
const SELECTORS: [RegExp, string][] = [
  [/\.look-swatch-default/, "the swatch for Flowplan's own accent in the settings"],
  [/\.wb-cover-card/, "covered whiteboard cards: drawn content, matches the cover pattern"],
  [/\.wb-player-bar/, "the presenter's bar is always dark"],
];

const stylesheets = () => readdirSync("app").filter((f) => f.endsWith(".css")).map((f) => join("app", f));

function offenders(file: string) {
  const css = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
  const found: string[] = [];
  // The selector of each position: the text since the last brace before
  // the innermost open block.
  const stack: string[] = [];
  let start = 0;
  let line = 1;
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === "\n") line++;
    if (c === "{") {
      stack.push(css.slice(start, i).trim());
      start = i + 1;
    } else if (c === "}") {
      stack.pop();
      start = i + 1;
    } else if (c === ";") {
      const declaration = css.slice(start, i);
      start = i + 1;
      for (const m of declaration.matchAll(BRAND)) {
        const before = declaration.slice(0, m.index);
        const property = /^\s*(--[\w-]+)\s*:/.exec(declaration)?.[1];
        if (property && TOKENS.has(property)) continue;
        // A fallback: var(--x, #…) – the colour of Flowplan's own look.
        if (/var\(--[\w-]+,\s*$/.test(before)) continue;
        const selector = stack[stack.length - 1] || "";
        if (SELECTORS.some(([re]) => re.test(selector))) continue;
        found.push(`${file}:${line} ${selector.split("\n").pop()} { ${declaration.trim()} }`);
      }
    }
  }
  return found;
}

test("no hard-coded brand blue in the style sheets outside the palette and the listed exceptions", () => {
  const found = stylesheets().flatMap(offenders);
  assert.deepEqual(found, [], "use var(--blue), var(--blue-light), var(--accent-strong), var(--on-accent) – or var(--accent, <colour>) to keep the default exactly");
});

// Components and libraries whose brand blue is not a control: content and
// its defaults (whiteboards, plots, demo pages), palettes, e-mails and
// images without a workspace, the brand itself.
const CODE_ALLOWED: Record<string, string> = {
  "lib/workspace-theme.ts": "the palette and the mark",
  "components/brand-mark.tsx": "the mark's default colours (CSS variables override them)",
  "components/settings/user/workspace-look.tsx": "Flowplan's own accent as a choice and in the preview",
  "components/publication-domain.tsx": "a custom domain's own accent setting",
  "components/admin-storage.tsx": "chart palette",
  "components/text-menu.tsx": "default colours of new function plots (content)",
  "components/editor.tsx": "default colour of a new function plot (content)",
  "lib/function-plot.ts": "plot palette (content)",
  "lib/demo-content.ts": "demo text colour (content)",
  "lib/mail.ts": "e-mails: no workspace look",
  "lib/weekly-digest.ts": "e-mails: no workspace look",
  "app/opengraph-image.tsx": "the brand's share image",
  "app/manifest.ts": "installed app: Flowplan's colours",
};
const CODE_ALLOWED_DIRS = ["components/whiteboard/", "lib/whiteboard", "lib/marketplace-official-extra/"];

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sources(join(dir, e.name)) : /\.(tsx?|mjs)$/.test(e.name) ? [join(dir, e.name)] : [],
  );
}

test("no hard-coded brand blue in components and libraries outside the listed content and brand places", () => {
  const found: string[] = [];
  for (const file of ["app", "components", "lib"].flatMap(sources)) {
    if (CODE_ALLOWED[file] || CODE_ALLOWED_DIRS.some((d) => file.startsWith(d))) continue;
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((text, i) => {
        if (BRAND.test(text) && !/var\(--[\w-]+,\s*#/.test(text)) found.push(`${file}:${i + 1}`);
        BRAND.lastIndex = 0;
      });
  }
  assert.deepEqual(found, []);
});

test("Flowplan's own look keeps its exact colours: every fallback equals the old literal", () => {
  // The defaults the fallbacks stand for (#277 changed no default colour).
  const css = stylesheets().map((f) => readFileSync(f, "utf8")).join("\n");
  for (const fallback of [
    "var(--accent-soft, #e9f0fc)",
    "var(--accent, #3f6aa8)",
    "var(--accent, #5561c7)",
    "var(--logo-from, #4146e6)",
    "var(--logo-to, #6a3fe0)",
    "var(--logo-glow, #4146e659)",
    "var(--avatar-ink, #5d6478)",
  ])
    assert.ok(css.includes(fallback), fallback);
});
