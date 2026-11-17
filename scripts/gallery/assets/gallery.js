// The UI gallery's page (scripts/gallery/report.ts). Plain browser
// JavaScript, no framework: reads manifest.json (manifest.js when opened as
// a local file) and draws the grid, the "Changed" view and the lightbox.
"use strict";

const REPO = "https://github.com/yannicschuller/flowplan";
const DEVICE = { desktop: "Desktop", phone: "Phone" };
const THEME = { light: "Light", dark: "Dark" };
const label = (v) => DEVICE[v.split("-")[0]] + " · " + THEME[v.split("-")[1]];

// ---------- Theme: system, light or dark, remembered per browser ----------
const THEMES = ["system", "light", "dark"];
let theme = "system";
try { theme = THEMES.includes(localStorage.getItem("gallery-theme")) ? localStorage.getItem("gallery-theme") : "system"; } catch {}
function applyTheme() {
  if (theme === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
}
applyTheme();

// ---------- Small helpers ----------
const $ = (id) => document.getElementById(id);
function el(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) e.append(kid);
  return e;
}
const pct = (r) => (r >= 0.1 ? Math.round(r * 100) : Math.max(0.1, Math.round(r * 1000) / 10)) + "%";
function when(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) + ", " + d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

function loadManifest() {
  if (location.protocol === "file:") {
    return new Promise((resolve, reject) => {
      const s = el("script", { src: "manifest.js" });
      s.onload = () => resolve(window.GALLERY_MANIFEST);
      s.onerror = () => reject(new Error("manifest.js could not be loaded"));
      document.head.append(s);
    });
  }
  return fetch("manifest.json", { cache: "no-cache" }).then((r) => {
    if (!r.ok) throw new Error("manifest.json: HTTP " + r.status);
    return r.json();
  });
}

// ---------- State ----------
const stored = (() => { try { return JSON.parse(localStorage.getItem("gallery-filters") || "{}"); } catch { return {}; } })();
const state = {
  view: "all",
  q: "",
  groups: new Set(Array.isArray(stored.groups) ? stored.groups : []),
  device: ["all", "desktop", "phone"].includes(stored.device) ? stored.device : "all",
  scheme: ["all", "light", "dark"].includes(stored.scheme) ? stored.scheme : "all",
  failedOnly: false,
};
const save = () => { try { localStorage.setItem("gallery-filters", JSON.stringify({ groups: [...state.groups], device: state.device, scheme: state.scheme })); } catch {} };

let M; // the manifest
let scenes = []; // { id, group, title, path, shots: { variant: shot } }
const byScene = new Map();
let changeOf = new Map(); // "scene--variant" → change
let addedSet = new Set();

function boot(manifest) {
  M = manifest;
  for (const s of M.shots) {
    let sc = byScene.get(s.scene);
    if (!sc) { sc = { id: s.scene, group: s.group, title: s.title, path: s.path, shots: {} }; byScene.set(s.scene, sc); scenes.push(sc); }
    sc.shots[s.variant] = s;
  }
  const ch = M.changes || { changed: [], added: [], removed: [] };
  changeOf = new Map(ch.changed.map((c) => [c.scene + "--" + c.variant, c]));
  addedSet = new Set(ch.added.map((c) => c.scene + "--" + c.variant));

  // Header line: date, commit, version, counts.
  const failed = M.shots.filter((s) => s.error).length;
  const clean = /^[0-9a-f]{40}$/.test(M.commit);
  $("meta").replaceChildren(
    el("time", { datetime: M.generated }, when(M.generated)), " · ",
    clean ? el("a", { href: REPO + "/commit/" + M.commit, title: "Commit " + M.commit }, M.commitShort) : M.commitShort, " · ",
    "v" + M.version, " · ",
    scenes.length + " scenes, " + M.shots.length + " screenshots",
    failed ? [" · ", el("span", { class: "bad" }, failed + " failed")] : "",
  );
  $("failedOnly").hidden = !failed;
  const nChanged = ch.changed.length + ch.added.length + ch.removed.length;
  $("changedCount").textContent = ch.previous ? String(nChanged) : "";
  $("changedCount").classList.toggle("zero", !nChanged);

  // Group chips with their counts.
  const groups = $("groups");
  const present = M.groups.filter((g) => scenes.some((s) => s.group === g));
  for (const g of [...state.groups]) if (!present.includes(g)) state.groups.delete(g);
  groups.append(el("button", { type: "button", class: "chip", "data-g": "", onclick: () => { state.groups.clear(); render(); } }, "All groups"));
  for (const g of present) {
    const items = scenes.filter((s) => s.group === g);
    const bad = items.filter((s) => Object.values(s.shots).some((x) => x.error)).length;
    groups.append(el("button", { type: "button", class: "chip", "data-g": g, onclick: () => { state.groups.has(g) ? state.groups.delete(g) : state.groups.add(g); render(); } },
      g, el("span", { class: "n" + (bad ? " bad" : "") }, bad ? items.length + " · " + bad + " ✗" : String(items.length))));
  }
  for (const [id, key] of [["device", "device"], ["scheme", "scheme"]])
    for (const b of $(id).children) b.addEventListener("click", () => { state[key] = b.dataset.v; render(); });
  $("failedOnly").addEventListener("click", () => { state.failedOnly = !state.failedOnly; render(); });
  const q = $("q");
  q.addEventListener("input", () => { state.q = q.value; render(); });
  window.addEventListener("hashchange", route);
  route();
}

// ---------- Filters ----------
function variantsShown() {
  return M.variants.filter((v) => (state.device === "all" || v.startsWith(state.device + "-")) && (state.scheme === "all" || v.endsWith("-" + state.scheme)));
}
function sceneMatches(sc) {
  if (state.groups.size && !state.groups.has(sc.group)) return false;
  const words = state.q.toLowerCase().split(/\s+/).filter(Boolean);
  const hay = (sc.id + " " + sc.title + " " + sc.group + " " + (sc.path || "")).toLowerCase();
  return words.every((w) => hay.includes(w));
}
const aspect = (w, h, variant) => (w && h ? w / h : variant.startsWith("phone") ? 390 / 844 : 1440 / 900);
// Cards wide enough for their thumbnails at a readable height.
function cardMin(vs, height) {
  const sum = vs.reduce((n, v) => n + aspect(0, 0, v), 0);
  return Math.max(vs.length > 1 ? 260 : 170, Math.round(sum * height)) + "px";
}

// ---------- Rendering ----------
let visible = []; // lightbox order: { shot, change?, before? }
function syncControls() {
  for (const b of $("device").children) b.setAttribute("aria-pressed", String(b.dataset.v === state.device));
  for (const b of $("scheme").children) b.setAttribute("aria-pressed", String(b.dataset.v === state.scheme));
  for (const b of $("groups").children) b.setAttribute("aria-pressed", String(b.dataset.g ? state.groups.has(b.dataset.g) : state.groups.size === 0));
  $("failedOnly").setAttribute("aria-pressed", String(state.failedOnly));
  const changed = state.view === "changed";
  $("tabAll").toggleAttribute("aria-current", !changed);
  if (!changed) $("tabAll").setAttribute("aria-current", "page");
  $("tabChanged").toggleAttribute("aria-current", changed);
  if (changed) $("tabChanged").setAttribute("aria-current", "page");
  document.title = (changed ? "Changed – " : "") + "Flowplan UI gallery";
}

function thumbButton(shot, opts) {
  const { src, w, h, index, badge, cls } = opts;
  const ar = aspect(w, h, shot.variant);
  if (!src) {
    const b = el("div", { class: "thumb missing" }, "no screenshot");
    b.style.setProperty("--ar", String(ar));
    return b;
  }
  const b = el("button", { type: "button", class: "thumb" + (shot.error ? " bad" : "") + (cls ? " " + cls : ""), "data-i": index, "aria-label": shot.title + " – " + label(shot.variant) },
    el("img", { src, width: w || null, height: h || null, alt: "", loading: "lazy", decoding: "async" }),
    // The shape tells desktop from phone; the badge names the theme.
    badge === false ? null : el("span", { class: "badge" }, badge || THEME[shot.variant.split("-")[1]]));
  b.style.setProperty("--ar", String(ar));
  b.addEventListener("click", () => openLb(index));
  return b;
}

function sceneCard(sc, vs) {
  const strip = el("div", { class: "strip" });
  const errors = [], warns = [];
  for (const v of vs) {
    const s = sc.shots[v];
    if (!s) continue;
    const i = visible.push({ shot: s }) - 1;
    if (s.error) errors.push((vs.length > 1 ? label(v) + ": " : "") + s.error);
    warns.push(...(s.pageErrors || []));
    strip.append(thumbButton(s, { src: s.thumb, w: s.thumbWidth, h: s.thumbHeight, index: i }));
  }
  return el("article", { class: "card" + (errors.length ? " failed" : ""), id: sc.id },
    strip,
    el("div", { class: "card-body" },
      el("div", { class: "card-title" }, el("strong", {}, sc.title), el("a", { href: "#" + sc.id, title: "Link to this scene" }, "#")),
      el("span", { class: "card-sub" }, sc.id + (sc.path ? "  ·  " + sc.path : ""))),
    errors.map((e) => el("p", { class: "err" }, "Failed: " + e)),
    warns.length ? el("p", { class: "warn" }, "Page errors: " + [...new Set(warns)].join(" | ")) : null);
}

function renderAll(main) {
  const vs = variantsShown();
  const list = scenes.filter((sc) => sceneMatches(sc) && vs.some((v) => sc.shots[v]) && (!state.failedOnly || vs.some((v) => sc.shots[v] && sc.shots[v].error)));
  if (!list.length) return main.append(el("p", { class: "empty" }, "No scene matches the filters."));
  const min = cardMin(vs, vs.length > 1 ? 150 : 200);
  for (const g of M.groups) {
    const items = list.filter((s) => s.group === g);
    if (!items.length) continue;
    const grid = el("div", { class: "grid" });
    grid.style.setProperty("--card-min", min);
    for (const sc of items) grid.append(sceneCard(sc, vs));
    main.append(el("section", { class: "section", "aria-label": g }, el("h2", {}, g, el("span", { class: "n" }, String(items.length))), grid));
  }
}

function renderChanged(main) {
  const ch = M.changes || {};
  const vs = variantsShown();
  const inView = (x) => vs.includes(x.variant) && sceneMatches(byScene.get(x.scene) || { id: x.scene, title: x.title || "", group: x.group || "", path: x.path || "" });
  if (!ch.previous) {
    main.append(el("div", { class: "summary" },
      el("strong", {}, "Nothing to compare yet. "),
      (ch.note || "This run has no previous run to compare with.") +
      " The nightly site compares each run with the night before: screenshots whose pixels changed show up here with before and after, along with new and removed scenes."));
    return;
  }
  const prevClean = /^[0-9a-f]{40}$/.test(ch.previous.commit);
  main.append(el("div", { class: "summary" },
    "Compared with the run of ", el("strong", {}, when(ch.previous.generated)), " (",
    prevClean ? el("a", { href: REPO + "/compare/" + ch.previous.commit + "..." + M.commit }, ch.previous.commitShort + " → " + M.commitShort) : ch.previous.commitShort,
    ", v" + ch.previous.version + "): ",
    el("strong", {}, String(ch.changed.length)), " changed, ",
    el("strong", {}, String(ch.added.length)), " new, ",
    el("strong", {}, String(ch.removed.length)), " removed screenshots.",
    ch.note ? " " + ch.note : ""));

  const changed = ch.changed.filter(inView);
  const added = ch.added.filter(inView);
  const removed = ch.removed.filter(inView);
  if (!changed.length && !added.length && !removed.length) {
    main.append(el("p", { class: "empty" }, ch.changed.length + ch.added.length + ch.removed.length ? "No change matches the filters." : "No screenshot changed since the previous run."));
    return;
  }
  if (changed.length) {
    const grid = el("div", { class: "grid changes" + (changed.every((c) => c.variant.startsWith("phone")) ? " phones" : "") });
    for (const c of changed) {
      const sc = byScene.get(c.scene);
      const shot = sc.shots[c.variant];
      const i = visible.push({ shot, change: c }) - 1;
      grid.append(el("article", { class: "card", id: "changed-" + c.scene + "--" + c.variant },
        el("div", { class: "pair" },
          el("figure", {}, el("figcaption", {}, "Before"), thumbButton(shot, { src: c.before.thumb, w: c.before.thumbWidth, h: c.before.thumbHeight, index: i, badge: false })),
          el("figure", {}, el("figcaption", {}, "After"), thumbButton(shot, { src: shot.thumb, w: shot.thumbWidth, h: shot.thumbHeight, index: i, badge: false }))),
        el("div", { class: "card-body" },
          el("div", { class: "card-title" }, el("strong", {}, sc.title), el("span", { class: "badge changed", title: "Share of pixels that differ" }, pct(c.ratio))),
          el("span", { class: "card-sub" }, label(c.variant) + "  ·  " + sc.group + "  ·  " + sc.id))));
    }
    main.append(el("section", { class: "section", "aria-label": "Changed" }, el("h2", {}, "Changed", el("span", { class: "n" }, String(changed.length))),
      el("p", {}, "Open one to compare: slider, before or after (B toggles)."), grid));
  }
  if (added.length) {
    const grid = el("div", { class: "grid" });
    grid.style.setProperty("--card-min", "220px");
    for (const a of added) {
      const sc = byScene.get(a.scene);
      const shot = sc.shots[a.variant];
      const i = visible.push({ shot }) - 1;
      grid.append(el("article", { class: "card" }, el("div", { class: "strip" }, thumbButton(shot, { src: shot.thumb, w: shot.thumbWidth, h: shot.thumbHeight, index: i })),
        el("div", { class: "card-body" }, el("div", { class: "card-title" }, el("strong", {}, sc.title), el("span", { class: "badge added" }, "New")), el("span", { class: "card-sub" }, sc.group + "  ·  " + sc.id))));
    }
    main.append(el("section", { class: "section", "aria-label": "New" }, el("h2", {}, "New", el("span", { class: "n" }, String(added.length))), grid));
  }
  if (removed.length) {
    const grid = el("div", { class: "grid" });
    grid.style.setProperty("--card-min", "220px");
    for (const r of removed) {
      const shot = { ...r, file: r.file, thumb: r.thumb };
      const i = visible.push({ shot, removed: true }) - 1;
      grid.append(el("article", { class: "card" }, el("div", { class: "strip" }, thumbButton(shot, { src: r.thumb, w: r.thumbWidth, h: r.thumbHeight, index: i })),
        el("div", { class: "card-body" }, el("div", { class: "card-title" }, el("strong", {}, r.title), el("span", { class: "badge removed" }, "Removed")), el("span", { class: "card-sub" }, r.group + "  ·  " + r.scene))));
    }
    main.append(el("section", { class: "section", "aria-label": "Removed" }, el("h2", {}, "Removed", el("span", { class: "n" }, String(removed.length))),
      el("p", {}, "In the previous run, not in this one: the previous screenshots."), grid));
  }
}

function render() {
  save();
  syncControls();
  visible = [];
  const main = $("main");
  main.replaceChildren();
  if (state.view === "changed") renderChanged(main);
  else renderAll(main);
  $("main").style.setProperty("--header-h", $("main").offsetTop + "px");
}

// ---------- Routing: #changed, #<scene>, #<scene>--<variant> ----------
function route() {
  const hash = decodeURIComponent(location.hash.slice(1));
  const view = hash === "changed" || hash.startsWith("changed/") ? "changed" : "all";
  if (view !== state.view || !$("main").firstElementChild || $("main").firstElementChild.classList.contains("empty")) { state.view = view; render(); }
  else syncControls();
  if (!hash || hash === "changed") { if (!lb.hidden) closeLb(false); return; }
  const target = hash.replace(/^changed\//, "");
  const [scene, variant] = target.split("--");
  if (!byScene.has(scene)) return;
  let i = visible.findIndex((x) => x.shot.scene === scene && (!variant || x.shot.variant === variant));
  if (i < 0 && view === "all") {
    // Filtered out: show it anyway.
    state.groups.clear(); state.q = ""; $("q").value = ""; state.failedOnly = false;
    if (variant) { state.device = "all"; state.scheme = "all"; }
    render();
    i = visible.findIndex((x) => x.shot.scene === scene && (!variant || x.shot.variant === variant));
  }
  if (i < 0) return;
  if (variant) openLb(i, false);
  else {
    const card = document.getElementById(scene);
    if (card) { card.scrollIntoView({ block: "start" }); card.classList.add("flash"); setTimeout(() => card.classList.remove("flash"), 1600); }
  }
}

// ---------- Lightbox ----------
const lb = $("lb"), lbImg = $("lbImg"), lbBefore = $("lbBefore"), lbFrame = $("lbFrame"), lbSlider = $("lbSlider");
let current = -1, mode = "slider", returnFocus = null;
function setMode(m) {
  mode = m;
  const item = visible[current];
  const compare = !!(item && item.change);
  for (const b of $("lbCompare").children) b.setAttribute("aria-pressed", String(b.dataset.m === mode));
  lbFrame.classList.toggle("slider", compare && mode === "slider");
  lbFrame.classList.toggle("show-before", compare && mode === "before");
  lbBefore.hidden = !compare || mode === "after";
  lbSlider.hidden = !compare || mode !== "slider";
  lb.classList.toggle("with-slider", !lbSlider.hidden);
}
function openLb(i, push = true) {
  if (!visible.length) return;
  if (lb.hidden) returnFocus = document.activeElement;
  current = (i + visible.length) % visible.length;
  const { shot: s, change, removed } = visible[current];
  // The thumbnail at once, the full image when it has arrived.
  lbImg.src = s.thumb || s.file;
  lbImg.width = s.width || s.thumbWidth || 0;
  lbImg.height = s.height || s.thumbHeight || 0;
  if (s.file && s.file !== s.thumb) {
    const full = new Image();
    full.decoding = "async";
    full.onload = () => { if (visible[current] && visible[current].shot === s) lbImg.src = s.file; };
    full.src = s.file;
  }
  lbImg.alt = s.title + " – " + label(s.variant) + (change ? " (after)" : "");
  if (change) { lbBefore.src = change.before.file; lbBefore.alt = s.title + " (before)"; }
  else lbBefore.removeAttribute("src");
  $("lbCompare").hidden = !change;
  setMode(change ? mode : "after");
  $("lbTitle").textContent = s.title + " — " + label(s.variant) + (removed ? " (removed)" : "");
  $("lbSub").textContent = s.group + " · " + s.scene + (s.path ? " · " + s.path : "") + (change ? " · " + pct(change.ratio) + " of pixels changed" : "") + " · " + (current + 1) + "/" + visible.length;
  $("lbErr").textContent = s.error ? "Failed: " + s.error : "";
  $("lbErr").hidden = !s.error;
  $("lbStage").scrollTop = 0;
  const wasHidden = lb.hidden;
  lb.hidden = false;
  document.body.style.overflow = "hidden";
  if (wasHidden) $("lbClose").focus();
  if (push) {
    const hash = "#" + (state.view === "changed" ? "changed/" : "") + s.scene + "--" + s.variant;
    if (location.hash !== hash) history.replaceState(null, "", hash);
  }
  // The next one ahead of time.
  const next = visible[(current + 1) % visible.length];
  if (next && next.shot.file) new Image().src = next.shot.file;
}
function closeLb(updateHash = true) {
  lb.hidden = true;
  current = -1;
  lbFrame.classList.remove("actual");
  document.body.style.overflow = "";
  if (updateHash) history.replaceState(null, "", state.view === "changed" ? "#changed" : location.pathname + location.search);
  if (returnFocus && document.contains(returnFocus)) returnFocus.focus({ preventScroll: true });
}
$("lbPrev").addEventListener("click", () => openLb(current - 1));
$("lbNext").addEventListener("click", () => openLb(current + 1));
$("lbClose").addEventListener("click", () => closeLb());
$("lbSize").addEventListener("click", () => lbFrame.classList.toggle("actual"));
for (const b of $("lbCompare").children) b.addEventListener("click", () => setMode(b.dataset.m));
lbSlider.addEventListener("input", () => lbFrame.style.setProperty("--cut", lbSlider.value + "%"));
lb.addEventListener("click", (e) => { if (e.target === lb || e.target === $("lbStage")) closeLb(); });

$("theme").addEventListener("click", () => {
  theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
  try { localStorage.setItem("gallery-theme", theme); } catch {}
  applyTheme();
  syncThemeButton();
});
function syncThemeButton() {
  const text = "Theme: " + theme + " (click to change)";
  $("theme").title = text;
  $("theme").setAttribute("aria-label", text);
}
syncThemeButton();

// ---------- Keyboard ----------
document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (!lb.hidden) {
    if (e.key === "Escape") closeLb();
    else if (e.key === "ArrowRight") openLb(current + 1);
    else if (e.key === "ArrowLeft") openLb(current - 1);
    else if (e.key === " ") { e.preventDefault(); lbFrame.classList.toggle("actual"); }
    else if ((e.key === "b" || e.key === "B") && visible[current] && visible[current].change) setMode(mode === "before" ? "after" : "before");
    else if (e.key === "Tab") {
      // Focus stays in the dialog.
      const items = [...lb.querySelectorAll("button, input")].filter((x) => !x.closest("[hidden]") && x.offsetParent);
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    return;
  }
  const typing = document.activeElement && document.activeElement.matches("input, textarea");
  if (e.key === "/" && !typing) { e.preventDefault(); $("q").focus(); return; }
  if (e.key === "Escape" && document.activeElement === $("q")) { $("q").blur(); return; }
  // ←/→ step through the thumbnails once one has the focus.
  const t = document.activeElement && document.activeElement.closest(".thumb[data-i]");
  if (t && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
    const all = [...document.querySelectorAll(".thumb[data-i]")];
    const next = all[all.indexOf(t) + (e.key === "ArrowRight" ? 1 : -1)];
    if (next) { e.preventDefault(); next.focus(); next.scrollIntoView({ block: "nearest" }); }
  }
});

document.addEventListener("DOMContentLoaded", () => {
  loadManifest().then(boot, (error) => {
    $("main").replaceChildren(el("p", { class: "empty" }, "The gallery's data could not be loaded: " + error.message));
    $("meta").textContent = "";
  });
});
