// Writes the screenshots (MEDIA_DIR/shots) as WebP and the encoded clips
// (MEDIA_DIR/demos) into the docs and the website:
//
//   DOCS=../flowplan-docs WEBSITE=../flowplan-website node scripts/site-media/publish.mjs
//
// A WebP that replaces a file starts at quality 82 and steps down until it
// is no heavier than the old one (pages must not get slower). Then, in the
// website, `npm run brand-kit` makes the PNG downloads and the ZIP from the
// previews, and `npm run social-kit` the images and clips for sharing.
import { copyFileSync, existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { DIR } from "./lib.mjs";

const require = createRequire(new URL("../../package.json", import.meta.url));
const sharp = require("sharp");
const shots = join(DIR, "shots");

// shot → [repository, path]
const TARGETS = {
  "hero-light": ["WEBSITE", "public/brand/screenshots/preview/hero-light.webp"],
  "hero-dark": ["WEBSITE", "public/brand/screenshots/preview/hero-dark.webp"],
  "ai-ask": ["WEBSITE", "public/brand/screenshots/preview/ai-ask.webp"],
  calendar: ["WEBSITE", "public/brand/screenshots/preview/calendar.webp"],
  whiteboard: ["WEBSITE", "public/brand/screenshots/preview/whiteboard.webp"],
  journal: ["WEBSITE", "public/brand/screenshots/preview/journal.webp"],
  "notebook-ipad-light": ["WEBSITE", "public/brand/screenshots/preview/notebook-ipad-light.webp"],
  "pdf-annotate": [["WEBSITE", "public/brand/screenshots/preview/pdf-annotate.webp"], ["DOCS", "public/screenshots/pdf-annotate.webp"]],
  "home-customize": ["WEBSITE", "public/brand/screenshots/preview/home-customize.webp"],
  "mobile-board": ["WEBSITE", "public/brand/screenshots/preview/mobile-board.webp"],
  "mobile-journal": ["WEBSITE", "public/brand/screenshots/preview/mobile-journal.webp"],
  "docs-notebook": ["DOCS", "public/screenshots/notebook.webp"],
  "docs-home-customize": ["DOCS", "public/screenshots/home-customize.webp"],
  "docs-draw-block": ["DOCS", "public/screenshots/draw-block.webp"],
  "docs-code-preview": ["DOCS", "public/screenshots/code-preview.webp"],
};
// Allowed growth: the Ask AI panel used to be a dimmed dialog and is now a
// side panel full of text; at the old weight its text blurs.
const ALLOW = { "ai-ask": 1.5 };
const only = process.argv.slice(2);
const report = [];
for (const [shot, list] of Object.entries(TARGETS)) {
  if (only.length && !only.includes(shot)) continue;
  const src = join(shots, `${shot}.png`);
  if (!existsSync(src)) continue;
  for (const [repo, path] of Array.isArray(list[0]) ? list : [list]) {
    const root = process.env[repo];
    if (!root) continue;
    const dest = join(root, path);
    const before = existsSync(dest) ? statSync(dest).size : null;
    // A new file: about the weight of the others (≤ 150 KB).
    const limit = (before ?? 150_000) * (ALLOW[shot] ?? 1);
    let q = 82;
    let buf;
    for (;;) {
      buf = await sharp(src).webp({ quality: q, effort: 6, smartSubsample: true }).toBuffer();
      if (buf.length <= limit || q <= 50) break;
      q -= 4;
    }
    writeFileSync(dest, buf);
    report.push(`${repo.toLowerCase()} ${path}  ${before ?? "new"} → ${buf.length} (q${q})`);
  }
}
// The clips.
const demos = join(DIR, "demos");
if (process.env.WEBSITE && existsSync(demos))
  for (const f of readdirSync(demos)) {
    if (only.length && !only.some((n) => f.startsWith(n + "."))) continue;
    const dest = join(process.env.WEBSITE, "public/demos", f);
    const before = existsSync(dest) ? statSync(dest).size : null;
    copyFileSync(join(demos, f), dest);
    report.push(`website public/demos/${f}  ${before ?? "new"} → ${statSync(dest).size}`);
  }
console.log(report.join("\n"));
