// MEDIA_DIR/video/hero.webm + hero.json (segments to keep) → .github/assets/readme/hero.gif
//
//   node scripts/readme-media/make-hero.mjs [width=960] [fps=12]
//
// Needs ffmpeg. The GIF gets one palette for the whole clip (UI colours are
// few and flat), no dithering, and loops forever.
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DIR, ASSETS } from "./lib.mjs";

const width = Number(process.argv[2] || 800);
const fps = Number(process.argv[3] || 10);
const src = join(DIR, "video", "hero.webm");
const segments = JSON.parse(readFileSync(join(DIR, "video", "hero.json"), "utf8"));
const out = join(ASSETS, "hero.gif");

// [start, end, target?]: a target length speeds the piece up to fit.
const speed = ([a, b, target]) => (target ? Math.max(1, (b - a) / target) : 1);
const trims = segments.map((seg, i) => `[0:v]trim=start=${seg[0].toFixed(2)}:end=${seg[1].toFixed(2)},setpts=(PTS-STARTPTS)/${speed(seg).toFixed(3)}[s${i}]`);
const concat = `${segments.map((_, i) => `[s${i}]`).join("")}concat=n=${segments.length}:v=1:a=0[cat]`;
const look = `[cat]fps=${fps},scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=192:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle`;
execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-i", src, "-filter_complex", [...trims, concat, look].join(";"), "-loop", "0", out], { stdio: "inherit" });
const seconds = segments.reduce((n, seg) => n + (seg[1] - seg[0]) / speed(seg), 0);
console.log(out, (statSync(out).size / 1024 / 1024).toFixed(2), "MB,", seconds.toFixed(1), "s");
