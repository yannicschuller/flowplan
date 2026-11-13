import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { GROUPS } from "./types";

// gallery-out/index.html: one static page with every screenshot. A local
// file, never served by the app, so inline CSS and JS are fine here; it
// loads nothing from the network.

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

export type ReportData = {
  shots: Shot[];
  variants: string[];
  generated: string;
  commit: string;
  branch: string;
  seconds: number;
  server: string;
};

export function writeReport(dir: string, data: ReportData) {
  const file = join(dir, "index.html");
  // "</script>" inside the JSON would end the script element.
  const json = JSON.stringify({ ...data, groups: GROUPS }).replace(/</g, "\\u003c");
  writeFileSync(file, PAGE.replace("/*DATA*/null", json));
  return file;
}

const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Flowplan UI gallery</title>
<style>
:root { --bg:#f6f6f4; --card:#fff; --text:#1d1d1b; --muted:#6b6b66; --line:#e2e2dd; --accent:#2f6fde; --bad:#d23b30; --badbg:#fdecea; color-scheme: light dark; }
@media (prefers-color-scheme: dark) { :root { --bg:#161615; --card:#222220; --text:#ececea; --muted:#9a9a94; --line:#383835; --accent:#6f9cf0; --bad:#ff6b5e; --badbg:#3a1d1a; } }
* { box-sizing: border-box; }
body { margin:0; font:14px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif; background:var(--bg); color:var(--text); }
header { position:sticky; top:0; z-index:5; background:color-mix(in srgb, var(--bg) 92%, transparent); backdrop-filter:blur(8px); border-bottom:1px solid var(--line); padding:12px 20px; display:flex; flex-direction:column; gap:10px; }
.top { display:flex; align-items:baseline; gap:16px; flex-wrap:wrap; }
h1 { font-size:18px; margin:0; }
.summary { color:var(--muted); }
.summary b.bad { color:var(--bad); }
.controls { display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
input[type=search] { font:inherit; padding:6px 10px; border:1px solid var(--line); border-radius:8px; background:var(--card); color:var(--text); width:260px; }
.chips { display:flex; gap:6px; flex-wrap:wrap; }
button.chip, .seg button { font:inherit; font-size:13px; padding:4px 10px; border:1px solid var(--line); border-radius:999px; background:var(--card); color:var(--text); cursor:pointer; }
button.chip[aria-pressed=true], .seg button[aria-pressed=true] { background:var(--accent); border-color:var(--accent); color:#fff; }
button.chip .n { opacity:.65; margin-left:4px; }
.seg { display:inline-flex; gap:4px; }
.sep { width:1px; align-self:stretch; background:var(--line); }
main { padding:20px; }
section h2 { font-size:15px; margin:24px 0 10px; color:var(--muted); font-weight:600; }
section:first-child h2 { margin-top:0; }
.grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(300px, 1fr)); gap:14px; }
.grid.all { grid-template-columns:repeat(auto-fill, minmax(620px, 1fr)); }
.tile { background:var(--card); border:1px solid var(--line); border-radius:10px; overflow:hidden; display:flex; flex-direction:column; }
.tile.failed { border-color:var(--bad); box-shadow:0 0 0 1px var(--bad); }
.shots { display:flex; gap:4px; padding:4px; background:color-mix(in srgb, var(--line) 50%, transparent); align-items:flex-start; }
.shot { flex:1 1 0; min-width:0; cursor:zoom-in; position:relative; border:0; padding:0; background:none; }
.shot.phone { flex:0.45 1 0; }
.shot img { display:block; width:100%; height:auto; max-height:420px; object-fit:cover; object-position:top; border-radius:6px; }
.shot .tag { position:absolute; left:4px; bottom:4px; font-size:11px; background:rgba(0,0,0,.6); color:#fff; padding:1px 6px; border-radius:4px; }
.shot.bad img { outline:2px solid var(--bad); outline-offset:-2px; }
.missing { display:flex; align-items:center; justify-content:center; min-height:120px; color:var(--muted); font-size:12px; }
.meta { padding:8px 10px; display:flex; flex-direction:column; gap:2px; }
.meta .t { font-weight:600; }
.meta .p { color:var(--muted); font-size:12px; font-family:ui-monospace,monospace; overflow-wrap:anywhere; }
.err { margin:0 10px 10px; padding:6px 8px; border-radius:6px; background:var(--badbg); color:var(--bad); font-size:12px; font-family:ui-monospace,monospace; overflow-wrap:anywhere; }
.warn { margin:0 10px 8px; color:var(--muted); font-size:11px; }
.empty { color:var(--muted); padding:40px; text-align:center; }
#lb { position:fixed; inset:0; z-index:10; background:rgba(10,10,10,.88); display:none; flex-direction:column; }
#lb.open { display:flex; }
#lb .bar { display:flex; gap:12px; align-items:center; padding:10px 16px; color:#eee; }
#lb .bar .grow { flex:1; min-width:0; }
#lb .bar small { color:#aaa; font-family:ui-monospace,monospace; }
#lb .bar button { font:inherit; background:#333; color:#eee; border:1px solid #555; border-radius:6px; padding:4px 10px; cursor:pointer; }
#lb .img { flex:1; overflow:auto; display:flex; justify-content:center; align-items:flex-start; padding:0 16px 16px; }
#lb img { max-width:100%; height:auto; background:#fff; }
#lb img.actual { max-width:none; }
#lb .lberr { color:#ff8a80; font-family:ui-monospace,monospace; font-size:12px; padding:0 16px 8px; }
</style>
</head>
<body>
<header>
  <div class="top"><h1>Flowplan UI gallery</h1><span class="summary" id="summary"></span></div>
  <div class="controls">
    <input type="search" id="q" placeholder="Filter: title, id, path …" aria-label="Filter scenes">
    <div class="seg" id="variants" role="group" aria-label="Variant"></div>
    <span class="sep"></span>
    <button class="chip" id="failedOnly" aria-pressed="false">Failed only</button>
  </div>
  <div class="chips" id="groups" role="group" aria-label="Groups"></div>
</header>
<main id="main"></main>
<div id="lb" role="dialog" aria-modal="true" aria-label="Screenshot">
  <div class="bar"><div class="grow"><div id="lbTitle"></div><small id="lbSub"></small></div>
  <button id="lbSize" title="Actual size (Space)">1:1</button><button id="lbPrev" title="Previous (←)">←</button><button id="lbNext" title="Next (→)">→</button><button id="lbClose" title="Close (Esc)">✕</button></div>
  <div class="lberr" id="lbErr"></div>
  <div class="img"><img id="lbImg" alt=""></div>
</div>
<script>
const DATA = /*DATA*/null;
const LABEL = { "desktop-light": "Desktop light", "desktop-dark": "Desktop dark", "phone-light": "Phone light", "phone-dark": "Phone dark" };
const state = { q: "", groups: new Set(), variant: DATA.variants.length > 1 ? "all" : DATA.variants[0], failedOnly: false };
try { Object.assign(state, JSON.parse(sessionStorage.getItem("gallery") || "{}"), { groups: new Set(JSON.parse(sessionStorage.getItem("gallery") || "{}").groups || []) }); } catch {}
if (state.variant !== "all" && !DATA.variants.includes(state.variant)) state.variant = "all";
const save = () => { try { sessionStorage.setItem("gallery", JSON.stringify({ ...state, groups: [...state.groups] })); } catch {} };
const el = (tag, props = {}, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(props)) { if (k === "class") e.className = v; else if (k.startsWith("on")) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v); } for (const kid of kids) if (kid != null) e.append(kid); return e; };

// Scenes in their order, each with its shots per variant.
const scenes = [];
const byId = new Map();
for (const s of DATA.shots) {
  let sc = byId.get(s.scene);
  if (!sc) { sc = { id: s.scene, group: s.group, title: s.title, path: s.path, shots: {} }; byId.set(s.scene, sc); scenes.push(sc); }
  sc.shots[s.variant] = s;
}
const failedShots = DATA.shots.filter((s) => s.error);
const failedScenes = scenes.filter((sc) => Object.values(sc.shots).some((s) => s.error));
document.getElementById("summary").innerHTML =
  scenes.length + " scenes · " + DATA.shots.length + " screenshots · " +
  (failedShots.length ? '<b class="bad">' + failedShots.length + " failed</b> (" + failedScenes.length + " scenes)" : "0 failed") +
  " · " + DATA.seconds + " s · " + new Date(DATA.generated).toLocaleString() + " · " + DATA.branch + " @ " + DATA.commit + " · " + DATA.server;

const variantsEl = document.getElementById("variants");
for (const v of [...DATA.variants, ...(DATA.variants.length > 1 ? ["all"] : [])]) {
  variantsEl.append(el("button", { "data-v": v, onclick: () => { state.variant = v; render(); } }, v === "all" ? "All " + DATA.variants.length + " side by side" : LABEL[v] || v));
}
const groupsEl = document.getElementById("groups");
const present = DATA.groups.filter((g) => scenes.some((s) => s.group === g));
groupsEl.append(el("button", { class: "chip", "data-g": "", onclick: () => { state.groups.clear(); render(); } }, "All groups"));
for (const g of present) {
  const n = scenes.filter((s) => s.group === g).length;
  const bad = failedScenes.filter((s) => s.group === g).length;
  groupsEl.append(el("button", { class: "chip", "data-g": g, onclick: () => { state.groups.has(g) ? state.groups.delete(g) : state.groups.add(g); render(); } }, g, el("span", { class: "n" }, String(n) + (bad ? " · " + bad + "✗" : ""))));
}
const q = document.getElementById("q");
q.value = state.q;
q.addEventListener("input", () => { state.q = q.value; render(); });
document.getElementById("failedOnly").addEventListener("click", () => { state.failedOnly = !state.failedOnly; render(); });

let visible = []; // shots in lightbox order
function render() {
  save();
  for (const b of variantsEl.children) b.setAttribute("aria-pressed", String(b.dataset.v === state.variant));
  for (const b of groupsEl.children) b.setAttribute("aria-pressed", String(b.dataset.g ? state.groups.has(b.dataset.g) : state.groups.size === 0));
  document.getElementById("failedOnly").setAttribute("aria-pressed", String(state.failedOnly));
  const words = state.q.toLowerCase().split(/\s+/).filter(Boolean);
  const vs = state.variant === "all" ? DATA.variants : [state.variant];
  const list = scenes.filter((sc) => {
    if (state.groups.size && !state.groups.has(sc.group)) return false;
    const hay = (sc.id + " " + sc.title + " " + sc.group + " " + sc.path).toLowerCase();
    if (!words.every((w) => hay.includes(w))) return false;
    if (!vs.some((v) => sc.shots[v])) return false;
    if (state.failedOnly && !vs.some((v) => sc.shots[v] && sc.shots[v].error)) return false;
    return true;
  });
  visible = [];
  const main = document.getElementById("main");
  main.replaceChildren();
  if (!list.length) { main.append(el("div", { class: "empty" }, "No scene matches.")); return; }
  for (const g of DATA.groups) {
    const items = list.filter((s) => s.group === g);
    if (!items.length) continue;
    const grid = el("div", { class: "grid" + (vs.length > 1 ? " all" : "") });
    for (const sc of items) {
      const shotsEl = el("div", { class: "shots" });
      const errors = [];
      const warns = [];
      for (const v of vs) {
        const s = sc.shots[v];
        if (!s) continue;
        const i = visible.push(s) - 1;
        if (s.error) errors.push((vs.length > 1 ? LABEL[v] + ": " : "") + s.error);
        if (s.pageErrors.length) warns.push(...s.pageErrors);
        const btn = el("button", { class: "shot " + v.split("-")[0] + (s.error ? " bad" : ""), onclick: () => openLb(i), title: LABEL[v] });
        btn.append(s.file ? el("img", { src: s.file, loading: "lazy", alt: sc.title + " – " + LABEL[v] }) : el("div", { class: "missing" }, "no screenshot"));
        if (vs.length > 1) btn.append(el("span", { class: "tag" }, LABEL[v]));
        shotsEl.append(btn);
      }
      const tile = el("article", { class: "tile" + (errors.length ? " failed" : "") }, shotsEl,
        el("div", { class: "meta" }, el("span", { class: "t" }, sc.title), el("span", { class: "p" }, sc.id + (sc.path ? "  ·  " + sc.path : ""))));
      for (const e of errors) tile.append(el("div", { class: "err" }, "failed: " + e));
      if (warns.length) tile.append(el("div", { class: "warn" }, "page errors: " + [...new Set(warns)].join(" | ")));
      grid.append(tile);
    }
    main.append(el("section", {}, el("h2", {}, g + " (" + items.length + ")"), grid));
  }
}

const lb = document.getElementById("lb"), lbImg = document.getElementById("lbImg");
let current = -1;
function openLb(i) {
  current = (i + visible.length) % visible.length;
  const s = visible[current];
  lbImg.src = s.file;
  lbImg.alt = s.title;
  document.getElementById("lbTitle").textContent = s.title + " — " + (LABEL[s.variant] || s.variant);
  document.getElementById("lbSub").textContent = s.group + " · " + s.scene + (s.path ? " · " + s.path : "") + " · " + (current + 1) + "/" + visible.length;
  document.getElementById("lbErr").textContent = s.error ? "failed: " + s.error : "";
  lb.classList.add("open");
}
const closeLb = () => { lb.classList.remove("open"); current = -1; };
document.getElementById("lbPrev").onclick = () => openLb(current - 1);
document.getElementById("lbNext").onclick = () => openLb(current + 1);
document.getElementById("lbClose").onclick = closeLb;
document.getElementById("lbSize").onclick = () => lbImg.classList.toggle("actual");
lb.addEventListener("click", (e) => { if (e.target === lb || e.target.classList.contains("img")) closeLb(); });
document.addEventListener("keydown", (e) => {
  if (current < 0) { if (e.key === "/" && document.activeElement !== q) { e.preventDefault(); q.focus(); } return; }
  if (e.key === "Escape") closeLb();
  else if (e.key === "ArrowRight") openLb(current + 1);
  else if (e.key === "ArrowLeft") openLb(current - 1);
  else if (e.key === " ") { e.preventDefault(); lbImg.classList.toggle("actual"); }
});
render();
</script>
</body>
</html>
`;
