// The one-minute tour for the website's /demo page (public/demos/tour.mp4
// and tour.webp, 1280×720, 30 fps, muted): a title card, seven scenes from
// the encoded clips (MEDIA_DIR/demos, run clips.mjs and encode.sh first)
// with a caption each, and an end card, joined with cross-fades.
//
//   WEBSITE=../flowplan-website MEDIA_DIR=… node scripts/site-media/tour.mjs
//
// Cards and captions are HTML in the website's fonts and logo, drawn by
// Playwright; ffmpeg does the rest.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { launch, DIR } from "./lib.mjs";

const SITE = process.env.WEBSITE;
if (!SITE) throw new Error("WEBSITE: the flowplan-website checkout (fonts and logo)");
const W = 1280;
const H = 720;
const FPS = 30;
const FADE = 0.4;
const work = join(DIR, "tour");
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const ffmpeg = (...a) => execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...a]);

// clip, from (s), length (s), caption, line below it
const SCENES = [
  ["editor-en", 1.0, 7, "Documents with a fast block editor", "Type / for headings, tasks, tables, code, diagrams and more"],
  ["db-views-en", 0.5, 7.5, "Databases with ten views", "Table, board, calendar, timeline, gallery, list, chart and more – on the same records"],
  ["board-drag", 0.4, 7, "Kanban boards with drag and drop", "Move a card – its status changes everywhere"],
  ["timeline", 0.5, 7, "Timelines with dependencies", "Move a task and its successors follow, the critical path stays marked"],
  ["whiteboard-en", 0.5, 7, "Whiteboards for brainstorming", "Sticky notes, shapes, connectors, mind maps – live with your team"],
  ["ai-write", 4.5, 11, "AI, optional – also completely local", "Ollama or your own key; you decide what it reads"],
  ["db-views-en-dark", 0.5, 5, "Light and dark mode", "Follows your system or your choice"],
];

const font = (f) => `data:font/woff2;base64,${readFileSync(join(SITE, "public/fonts", f)).toString("base64")}`;
const FONTS = `@font-face{font-family:"Instrument Serif";src:url(${font("instrument-serif-latin-400-normal.woff2")})}
@font-face{font-family:"Instrument Sans";src:url(${font("instrument-sans-latin-standard-normal.woff2")});font-weight:400 700}`;
const LOGO = readFileSync(join(SITE, "public/brand/logo/flowplan-logo.svg"), "utf8");
const PAPER = "radial-gradient(ellipse 75% 42% at 50% 78%,#e4e3fb 0%,rgba(228,227,251,0) 72%),radial-gradient(ellipse 55% 26% at 96% 2%,#fbe6da 0%,rgba(251,230,218,0) 70%),#f6f4ef";
const card = (inner) => `<!doctype html><html><head><meta charset="utf-8"><style>${FONTS}
html,body{margin:0;width:${W}px;height:${H}px;overflow:hidden}
body{background:${PAPER};color:#1d1c22;font-family:"Instrument Sans",sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center}
.logo svg{height:72px;width:auto}
h1{font:400 50px/1.08 "Instrument Serif",serif;margin:32px 0 0}
p{font-size:22px;color:#5e5a66;margin:18px 0 0;font-weight:500}
</style></head><body>${inner}</body></html>`;
const caption = (title, sub) => `<!doctype html><html><head><meta charset="utf-8"><style>${FONTS}
html,body{margin:0;width:${W}px;height:${H}px;background:transparent}
div{position:absolute;left:50%;bottom:30px;transform:translateX(-50%);background:rgba(29,28,34,.92);color:#fff;border-radius:14px;padding:11px 22px 12px;text-align:center;white-space:nowrap;box-shadow:0 10px 30px rgba(20,18,40,.28);font-family:"Instrument Sans",sans-serif}
b{display:block;font:400 26px/1.1 "Instrument Serif",serif}
span{display:block;font-size:12.5px;color:#cfccd8;margin-top:5px;font-weight:500}
</style></head><body><div><b>${title}</b><span>${sub}</span></div></body></html>`;

const browser = await launch();
const page = await browser.newPage({ viewport: { width: W, height: H } });
const shot = async (html, file, transparent = false) => {
  await page.setContent(html);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: file, omitBackground: transparent });
};
await shot(card(`<div class="logo">${LOGO}</div><h1>Your notes, docs and projects.<br>On your own server.</h1><p>The open-source, self-hosted Notion alternative</p>`), join(work, "intro.png"));
await shot(card(`<div class="logo">${LOGO}</div><h1 style="font-size:34px">flowplan.org · Open source · AGPL-3.0</h1><p>Try the demo at app.flowplan.org/demo</p>`), join(work, "outro.png"));
for (const [i, [, , , title, sub]] of SCENES.entries()) await shot(caption(title, sub), join(work, `cap${i}.png`), true);
await browser.close();

// The parts, each as 30 fps H.264.
const parts = [];
const still = (png, seconds, out) => {
  ffmpeg("-loop", "1", "-t", String(seconds), "-i", png, "-vf", `fps=${FPS},format=yuv420p`, "-c:v", "libx264", "-crf", "16", out);
  parts.push([out, seconds]);
};
still(join(work, "intro.png"), 4, join(work, "p00.mp4"));
for (const [i, [clip, from, seconds]] of SCENES.entries()) {
  const out = join(work, `p${String(i + 1).padStart(2, "0")}.mp4`);
  // 1280×800 → 1280×720: a little off the top and the bottom.
  ffmpeg(
    "-ss", String(from), "-t", String(seconds), "-i", join(DIR, "demos", `${clip}.mp4`),
    "-loop", "1", "-t", String(seconds), "-i", join(work, `cap${i}.png`),
    "-filter_complex", `[0:v]crop=${W}:${H}:0:30,fps=${FPS},setpts=PTS-STARTPTS[v];[1:v]format=rgba,fade=in:st=0.35:d=0.45:alpha=1,fade=out:st=${seconds - 0.7}:d=0.4:alpha=1[c];[v][c]overlay=0:0:shortest=1,format=yuv420p`,
    "-an", "-c:v", "libx264", "-crf", "16", out,
  );
  parts.push([out, seconds]);
}
still(join(work, "outro.png"), 4.5, join(work, "p99.mp4"));

// Cross-fades between all parts.
const inputs = parts.flatMap(([f]) => ["-i", f]);
let chain = "";
let last = "[0:v]";
let offset = 0;
for (let i = 1; i < parts.length; i++) {
  offset += parts[i - 1][1] - FADE;
  const label = i === parts.length - 1 ? "[out]" : `[x${i}]`;
  chain += `${last}[${i}:v]xfade=transition=fade:duration=${FADE}:offset=${offset.toFixed(2)}${label};`;
  last = label;
}
const out = join(DIR, "demos", "tour.mp4");
ffmpeg(...inputs, "-filter_complex", chain.slice(0, -1), "-map", "[out]", "-an", "-c:v", "libx264", "-profile:v", "high", "-preset", "slow", "-crf", "28", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out);
// Poster: the title card.
ffmpeg("-i", join(work, "intro.png"), "-c:v", "libwebp", "-quality", "72", join(DIR, "demos", "tour.webp"));
console.log("tour", execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", out]).toString().trim(), "s");
