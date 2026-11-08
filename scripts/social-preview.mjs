// Builds the repository's social preview (GitHub → Settings → Social preview):
//
//   node scripts/social-preview.mjs
//
// writes .github/assets/social-preview.png (paper) and
// social-preview-dark.png (night), 1280×640. A small HTML scene in the
// look of the website's social kit (flowplan-website/scripts/social-kit.ts):
// the app's fonts (public/fonts.css), logo and colours (DESIGN.md) and the
// README screenshots, rendered by Playwright's Chromium (QUALITY_CHROMIUM,
// /opt/pw-browsers/chromium or Playwright's own, see scripts/chromium.mjs).
// Everything that matters stays 48 px away from the edges – sites that show
// the image crop it.
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import sharp from "sharp";
import { launchChromium } from "./chromium.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ASSETS = join(ROOT, ".github/assets");
const W = 1280;
const H = 640;
const file = (path) => pathToFileURL(join(ROOT, path)).href;

const FEATURES = ["Docs", "Databases", "Whiteboards", "Journal", "Workflows", "AI optional"];

const fontCss = readFileSync(join(ROOT, "public/fonts.css"), "utf8").replaceAll(
  'url("/',
  `url("${pathToFileURL(join(ROOT, "public")).href}/`,
);

const STYLE = `
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:${W}px;height:${H}px;overflow:hidden}
body{font-family:"Instrument Sans",sans-serif;background:var(--bg);color:var(--ink);position:relative;-webkit-font-smoothing:antialiased}
.light{--bg:#fcfbf8;--ink:#1d1c22;--muted:#5e5a66;--line:#e4e0d6;--accent:#3b3fd8;--chip:#f6f4ef;--glow:rgba(65,70,230,.15);--glow2:rgba(106,63,224,.10);--shadow:0 30px 70px -26px rgba(29,28,34,.38),0 0 0 1px rgba(29,28,34,.09)}
.dark{--bg:#16151b;--ink:#ecebf1;--muted:#b3afbd;--line:#2e2c35;--accent:#959bff;--chip:#1d1c23;--glow:rgba(65,70,230,.30);--glow2:rgba(106,63,224,.22);--shadow:0 30px 70px -26px rgba(0,0,0,.85),0 0 0 1px rgba(255,255,255,.09)}
.bg{position:absolute;inset:0;background:radial-gradient(55% 60% at 88% 12%,var(--glow),transparent 70%),radial-gradient(50% 55% at 6% 100%,var(--glow2),transparent 70%)}
.grid{position:absolute;inset:0;opacity:.55;background-image:radial-gradient(var(--line) 1.3px,transparent 1.3px);background-size:28px 28px;mask-image:linear-gradient(90deg,#000 0,#000 40%,transparent 62%)}
.abs{position:absolute}
.logo{height:46px;display:block}
h1{font-family:"Instrument Serif",serif;font-weight:400;font-size:58px;line-height:1.03;letter-spacing:-.012em}
h1 em{color:var(--accent);font-style:italic}
.lead{font-size:19px;line-height:1.4;color:var(--muted);font-weight:500}
.chips{display:flex;flex-wrap:nowrap;gap:7px}
.chips span{font-size:15px;padding:.36em .78em;white-space:nowrap;border-radius:999px;background:var(--chip);border:1px solid var(--line);font-weight:550}
.chips span.ai::before{content:"";display:inline-block;width:.5em;height:.5em;border-radius:50%;background:#f0663a;margin-right:.45em;vertical-align:.1em}
.foot{display:flex;align-items:center;gap:14px;font-size:17px;font-weight:600;color:var(--muted)}
.foot .dot{width:4px;height:4px;border-radius:50%;background:var(--muted);opacity:.6}
.url{font-family:"JetBrains Mono",monospace;font-size:17px;font-weight:500;color:var(--ink)}
.url b{color:var(--accent);font-weight:600}
.window{position:absolute;border-radius:16px;overflow:hidden;box-shadow:var(--shadow);background:var(--bg)}
.window img{display:block;width:100%;height:100%;object-fit:cover;object-position:0 0}
.crop{position:absolute;border-radius:14px;overflow:hidden;box-shadow:var(--shadow);background:var(--bg)}
.crop img{position:absolute;left:0;top:0;transform-origin:0 0}
`;

// A part of a 1600×1000 screenshot, scaled to `width` px.
const crop = (src, { x, y, w, h }, width, style) => {
  const z = width / w;
  return `<div class="crop" style="width:${width}px;height:${Math.round(h * z)}px;${style}"><img src="${src}" style="width:1600px;height:1000px;transform:translate(${-x * z}px,${-y * z}px) scale(${z})"></div>`;
};

function scene(dark) {
  const theme = dark ? "dark" : "light";
  const shot = (name) => file(`.github/assets/readme/screenshot-${name}-${theme}.png`);
  return `<!doctype html><html><head><meta charset="utf-8"><style>${fontCss}${STYLE}</style></head>
<body class="${theme}"><div class="bg"></div><div class="grid"></div>
  <div class="abs" style="left:64px;top:60px"><img class="logo" src="${file(`.github/assets/logo-${theme}.svg`)}" alt=""></div>
  <div class="abs" style="left:64px;top:162px;width:640px">
    <h1>Open-source workspace<br><em>for docs, databases<br>and whiteboards.</em></h1>
    <p class="lead" style="margin-top:18px;width:540px">The open alternative to Notion and Confluence –<br>self-hosted in one container, your data stays yours.</p>
    <div class="chips" style="margin-top:24px">${FEATURES.map((f) => `<span${f.startsWith("AI") ? ' class="ai"' : ""}>${f}</span>`).join("")}</div>
  </div>
  <div class="abs foot" style="left:64px;bottom:54px"><span>AGPL-3.0</span><i class="dot"></i><span class="url">github.com/<b>yannicschuller/flowplan</b></span></div>
  <div class="window" style="left:744px;top:64px;width:760px;height:475px"><img src="${shot("database")}" alt=""></div>
  ${
    // The whiteboard's canvas stays light in the dark theme, so the night
    // version shows a page of the editor instead.
    dark
      ? crop(shot("document"), { x: 476, y: 116, w: 940, h: 490 }, 340, "left:770px;top:384px")
      : crop(shot("whiteboard"), { x: 244, y: 344, w: 594, h: 370 }, 300, "left:778px;top:396px")
  }
</body></html>`;
}

const { browser, error } = await launchChromium();
if (!browser) throw new Error(`No Chromium: ${error}`);
const dir = mkdtempSync(join(tmpdir(), "flowplan-social-preview-"));
try {
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  for (const dark of [false, true]) {
    const html = join(dir, "scene.html");
    writeFileSync(html, scene(dark));
    await page.goto(pathToFileURL(html).href);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForLoadState("networkidle");
    const png = await page.screenshot({ type: "png" });
    const out = join(ASSETS, `social-preview${dark ? "-dark" : ""}.png`);
    const info = await sharp(png).png({ compressionLevel: 9, palette: true, quality: 92, effort: 10 }).toFile(out);
    console.log(`${out} (${Math.round(info.size / 1024)} KB)`);
  }
} finally {
  await browser.close();
  rmSync(dir, { recursive: true, force: true });
}
