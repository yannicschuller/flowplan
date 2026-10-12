// Function graphs in documents: one or more functions of x drawn as SVG with
// grid, axes and zeros. The block stores what was written ("x² − 2") and an
// optional view; the drawing is made in the browser. Dragging moves the view,
// the buttons and ⌘/Ctrl + scroll zoom. In the editor the functions are
// edited below the graph and redrawn while typing. An entry can also be a
// vector in the plane – "(3; 2)", "(1 | 2) + (3 | 1)" – drawn as an arrow
// from the origin. With a vector in space – "(1 | 2 | 3)" – the graph turns
// 3D: axes x, y, z as drawn in school, the floor grid, dashed guides to the
// floor; dragging turns the view.
import { compile } from "mathjs";
import { functionExpression, vectorValue } from "./math-solve";
import { LOCALE_TAG, tr } from "./locale-tag";

export type PlotFunction = { expr: string; color: string };
export type PlotView = { xMin: number; xMax: number; yMin: number; yMax: number };
// How a 3D graph is looked at: turned around z (yaw) and tilted (pitch), in degrees.
export type PlotCamera = { yaw: number; pitch: number; zoom: number };
export type PlotConfig = { functions: PlotFunction[]; view?: PlotView | null; camera?: PlotCamera | null };
const DEFAULT_CAMERA: PlotCamera = { yaw: -120, pitch: 25, zoom: 1 };

export const PLOT_COLORS = ["#3b3fd8", "#e03131", "#2f9e44", "#f08c00", "#9c36b5", "#1098ad"];
const W = 640,
  H = 380,
  PAD = 8;
const MAX_FUNCTIONS = 6;

export function parsePlot(value: string | null | undefined): PlotConfig {
  try {
    const data = JSON.parse(value || "{}");
    const functions = Array.isArray(data.functions)
      ? data.functions
          .filter((f: unknown) => f && typeof (f as PlotFunction).expr === "string")
          .slice(0, MAX_FUNCTIONS)
          .map((f: PlotFunction, i: number) => ({
            expr: f.expr.slice(0, 200),
            color: /^#[0-9a-f]{6}$/i.test(f.color) ? f.color : PLOT_COLORS[i % PLOT_COLORS.length],
          }))
      : [];
    const v = data.view;
    const view =
      v && [v.xMin, v.xMax, v.yMin, v.yMax].every((n) => Number.isFinite(n)) && v.xMax > v.xMin && v.yMax > v.yMin
        ? { xMin: v.xMin, xMax: v.xMax, yMin: v.yMin, yMax: v.yMax }
        : null;
    const c = data.camera;
    const camera =
      c && [c.yaw, c.pitch, c.zoom].every((n) => Number.isFinite(n)) && c.zoom > 0.05 && c.zoom < 50
        ? { yaw: c.yaw, pitch: Math.max(-89, Math.min(89, c.pitch)), zoom: c.zoom }
        : null;
    return { functions, view, camera };
  } catch {
    return { functions: [] };
  }
}
export const plotJson = (config: PlotConfig) => JSON.stringify(config);

const locale = () => (LOCALE_TAG === "de-DE" ? "de" : "en") as "de" | "en";
type Compiled = ((x: number) => number) | null;
function compileFunction(expr: string): Compiled {
  const written = functionExpression(expr, locale());
  if (!written) return null;
  try {
    const code = compile(written);
    return (x: number) => {
      const y = code.evaluate({ x });
      return typeof y === "number" ? y : NaN;
    };
  } catch {
    return null;
  }
}
// A vector in the plane, or null.
function planeVector(expr: string): [number, number] | null {
  const v = vectorValue(expr, locale());
  return v && v.length === 2 ? [v[0], v[1]] : null;
}
// A vector in the plane or in space, as three coordinates (z = 0 in the plane).
function spaceVector(expr: string): [number, number, number] | null {
  const v = vectorValue(expr, locale());
  return v && (v.length === 2 || v.length === 3) ? [v[0], v[1], v[2] ?? 0] : null;
}
const isSpace = (config: PlotConfig) => config.functions.some((f) => vectorValue(f.expr, locale())?.length === 3);
export const isValidFunction = (expr: string) => !!compileFunction(expr) || !!spaceVector(expr);
// Names in the legend: f, g, h … for functions, a⃗, b⃗, c⃗ … for vectors.
function entryNames(config: PlotConfig) {
  let functions = 0,
    vectors = 0;
  return config.functions.map((f) => (spaceVector(f.expr) ? String.fromCharCode(97 + vectors++) : String.fromCharCode(102 + functions++)));
}

// A view that shows the interesting part: x from −6 to 6 (zeros, vertex,
// a period of sin), y from what the functions do there, outliers cut off.
function autoView(fns: Compiled[], vectors: [number, number][] = []): PlotView {
  if (vectors.length) {
    // Vectors need the same scale on both axes, so angles look right.
    const xs = [0, ...vectors.map((v) => v[0])],
      ys = [0, ...vectors.map((v) => v[1])];
    const base = fns.some(Boolean) ? autoView(fns) : null;
    let xMin = Math.min(...xs, base?.xMin ?? 0),
      xMax = Math.max(...xs, base?.xMax ?? 0),
      yMin = Math.min(...ys, base?.yMin ?? 0),
      yMax = Math.max(...ys, base?.yMax ?? 0);
    const ratio = (W - 2 * PAD) / (H - 2 * PAD);
    const width = Math.max(xMax - xMin, (yMax - yMin) * ratio, 2) * 1.25;
    const cx = (xMin + xMax) / 2,
      cy = (yMin + yMax) / 2;
    return { xMin: cx - width / 2, xMax: cx + width / 2, yMin: cy - width / ratio / 2, yMax: cy + width / ratio / 2 };
  }
  const ys: number[] = [];
  for (const f of fns)
    if (f)
      for (let i = 0; i <= 240; i++) {
        const y = f(-6 + i / 20);
        if (Number.isFinite(y)) ys.push(y);
      }
  if (!ys.length) return { xMin: -6, xMax: 6, yMin: -4, yMax: 4 };
  ys.sort((a, b) => a - b);
  let lo = Math.min(ys[Math.floor(ys.length * 0.02)], 0),
    hi = Math.max(ys[Math.floor(ys.length * 0.98)], 0);
  if (hi - lo < 4) {
    const mid = (hi + lo) / 2;
    lo = Math.min(lo, mid - 2);
    hi = Math.max(hi, mid + 2);
  }
  const margin = (hi - lo) * 0.1;
  return { xMin: -6, xMax: 6, yMin: lo - margin, yMax: hi + margin };
}
// 1, 2 or 5 times a power of ten: about `count` lines across the range.
function step(range: number, count: number) {
  const raw = range / count;
  const power = Math.pow(10, Math.floor(Math.log10(raw)));
  return [1, 2, 5, 10].map((m) => m * power).find((s) => s >= raw) || power * 10;
}
const number = (n: number) => {
  const rounded = Math.abs(n) < 1e-10 ? 0 : n;
  return rounded.toLocaleString(LOCALE_TAG, { maximumFractionDigits: 4 }).replace(/^-/, "−");
};
const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// The small arrow over a vector's name (the fonts have no combining arrow).
const nameArrow = (x: number, y: number, color: string) =>
  `<path class="plot-name-arrow" d="M${x - 4},${y} h8 m-2.5,-2.2 l2.5,2.2 l-2.5,2.2" stroke="${color}"/>`;
// The SVG of a graph for a view.
export function plotSvg(config: PlotConfig, view: PlotView, label: string): string {
  const fns = config.functions.map((f) => compileFunction(f.expr));
  const vectors = config.functions.map((f) => planeVector(f.expr));
  const names = entryNames(config);
  const sx = (x: number) => PAD + ((x - view.xMin) / (view.xMax - view.xMin)) * (W - 2 * PAD);
  const sy = (y: number) => PAD + ((view.yMax - y) / (view.yMax - view.yMin)) * (H - 2 * PAD);
  const parts: string[] = [];
  // Grid and labels.
  const dx = step(view.xMax - view.xMin, 10),
    dy = step(view.yMax - view.yMin, 7);
  const axisY = Math.min(Math.max(sy(0), PAD), H - PAD),
    axisX = Math.min(Math.max(sx(0), PAD), W - PAD);
  for (let x = Math.ceil(view.xMin / dx) * dx; x <= view.xMax; x += dx) {
    const px = sx(x);
    parts.push(`<line class="plot-grid" x1="${px}" y1="${PAD}" x2="${px}" y2="${H - PAD}"/>`);
    if (Math.abs(x) > dx / 1e6)
      parts.push(`<text class="plot-tick" x="${px}" y="${Math.min(axisY + 14, H - PAD - 2)}" text-anchor="middle">${number(x)}</text>`);
  }
  for (let y = Math.ceil(view.yMin / dy) * dy; y <= view.yMax; y += dy) {
    const py = sy(y);
    parts.push(`<line class="plot-grid" x1="${PAD}" y1="${py}" x2="${W - PAD}" y2="${py}"/>`);
    if (Math.abs(y) > dy / 1e6)
      parts.push(`<text class="plot-tick" x="${Math.max(axisX - 5, PAD + 24)}" y="${py + 4}" text-anchor="end">${number(y)}</text>`);
  }
  parts.push(`<line class="plot-axis" x1="${PAD}" y1="${axisY}" x2="${W - PAD}" y2="${axisY}"/>`);
  parts.push(`<line class="plot-axis" x1="${axisX}" y1="${PAD}" x2="${axisX}" y2="${H - PAD}"/>`);
  // Curves: sampled, broken where the function jumps or is undefined.
  const samples = 800;
  fns.forEach((f, i) => {
    if (!f) return;
    const color = config.functions[i].color;
    let d = "";
    let previous: number | null = null;
    const zeros: number[] = [];
    let prevX = 0,
      prevY = NaN;
    for (let k = 0; k <= samples; k++) {
      const x = view.xMin + ((view.xMax - view.xMin) * k) / samples;
      const y = f(x);
      if (!Number.isFinite(y) || Math.abs(y) > 1e9) {
        previous = null;
        prevY = NaN;
        continue;
      }
      const py = sy(y);
      const jump = previous !== null && Math.abs(py - previous) > H * 1.5;
      d += `${previous === null || jump ? "M" : "L"}${sx(x).toFixed(1)},${Math.max(-H, Math.min(2 * H, py)).toFixed(1)}`;
      // A zero between two samples: refine by bisection.
      if (Number.isFinite(prevY) && !jump && (y === 0 || prevY * y < 0)) {
        let a = prevX,
          b = x;
        for (let n = 0; n < 50; n++) {
          const m = (a + b) / 2;
          if (f(a) * f(m) <= 0) b = m;
          else a = m;
        }
        if (!zeros.some((z) => Math.abs(z - a) < 1e-6)) zeros.push(y === 0 ? x : a);
      }
      previous = py;
      prevX = x;
      prevY = y;
    }
    parts.push(`<path class="plot-curve" d="${d}" stroke="${color}"/>`);
    for (const z of zeros.slice(0, 20))
      parts.push(
        `<circle class="plot-zero" cx="${sx(z)}" cy="${sy(0)}" r="3.5" stroke="${color}"><title>${tr("Nullstelle", "Zero")} x ≈ ${number(z)}</title></circle>`,
      );
  });
  // Vectors: arrows from the origin, named at the tip.
  vectors.forEach((v, i) => {
    if (!v) return;
    const color = config.functions[i].color;
    const x0 = sx(0),
      y0 = sy(0),
      x1 = sx(v[0]),
      y1 = sy(v[1]);
    const length = Math.hypot(x1 - x0, y1 - y0);
    if (length < 1) {
      parts.push(`<circle cx="${x0}" cy="${y0}" r="3" fill="${color}"/>`);
      return;
    }
    const ux = (x1 - x0) / length,
      uy = (y1 - y0) / length;
    const head = Math.min(12, length * 0.4);
    const bx = x1 - ux * head,
      by = y1 - uy * head;
    const tip = `${x1.toFixed(1)},${y1.toFixed(1)} ${(bx - uy * head * 0.45).toFixed(1)},${(by + ux * head * 0.45).toFixed(1)} ${(bx + uy * head * 0.45).toFixed(1)},${(by - ux * head * 0.45).toFixed(1)}`;
    parts.push(
      `<g class="plot-vector"><title>${escape(`${tr("Vektor", "Vector")} ${names[i]} = (${number(v[0])} | ${number(v[1])})`)}</title><line x1="${x0.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${bx.toFixed(1)}" y2="${by.toFixed(1)}" stroke="${color}"/><polygon points="${tip}" fill="${color}"/><text x="${(x1 + ux * 10 + uy * 8).toFixed(1)}" y="${(y1 + uy * 10 - ux * 8 + 4).toFixed(1)}" fill="${color}" text-anchor="middle">${escape(names[i])}</text>${nameArrow(x1 + ux * 10 + uy * 8, y1 + uy * 10 - ux * 8 - 8, color)}</g>`,
    );
  });
  // Legend.
  config.functions.forEach((f, i) => {
    const vector = vectors[i];
    const valid = !!fns[i] || !!vector;
    const text = vector ? `${names[i]} = ${f.expr}` : `${names[i]}(x) = ${f.expr}`;
    parts.push(
      `<g class="plot-legend" transform="translate(${PAD + 10},${PAD + 16 + i * 20})"><rect x="0" y="-9" width="14" height="4" rx="2" fill="${f.color}"/><text x="20" y="-3"${valid ? "" : ' class="plot-invalid"'}>${escape(text)}</text>${vector ? nameArrow(24, -14, "currentColor") : ""}</g>`,
    );
  });
  return `<svg class="plot-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escape(label)}">${parts.join("")}</svg>`;
}

// The SVG of a 3D graph: vectors from the origin in space, seen through `camera`.
export function plotSvg3d(config: PlotConfig, camera: PlotCamera, label: string): string {
  const names = entryNames(config);
  const vectors = config.functions.map((f) => spaceVector(f.expr));
  const reach = Math.max(1, ...vectors.flatMap((v) => (v ? v.map(Math.abs) : [])));
  const extent = Math.ceil(reach * 1.15);
  const unit = (Math.min(W, H) * 0.4 * camera.zoom) / extent;
  const yaw = (camera.yaw * Math.PI) / 180,
    pitch = (camera.pitch * Math.PI) / 180;
  // Turned around z, then tilted towards the viewer; orthographic.
  const project = ([x, y, z]: [number, number, number]) => {
    const x1 = x * Math.cos(yaw) - y * Math.sin(yaw),
      y1 = x * Math.sin(yaw) + y * Math.cos(yaw);
    return { x: W / 2 + x1 * unit, y: H / 2 + 20 - (z * Math.cos(pitch) + y1 * Math.sin(pitch)) * unit, depth: y1 * Math.cos(pitch) - z * Math.sin(pitch) };
  };
  const line = (a: [number, number, number], b: [number, number, number], cls: string, color?: string) => {
    const p = project(a),
      q = project(b);
    return `<line class="${cls}" x1="${p.x.toFixed(1)}" y1="${p.y.toFixed(1)}" x2="${q.x.toFixed(1)}" y2="${q.y.toFixed(1)}"${color ? ` stroke="${color}"` : ""}/>`;
  };
  const arrowHead = (from: { x: number; y: number }, to: { x: number; y: number }, size: number, color: string) => {
    const length = Math.hypot(to.x - from.x, to.y - from.y) || 1;
    const ux = (to.x - from.x) / length,
      uy = (to.y - from.y) / length;
    const h = Math.min(size, length * 0.4);
    const bx = to.x - ux * h,
      by = to.y - uy * h;
    return { base: { x: bx, y: by }, points: `${to.x.toFixed(1)},${to.y.toFixed(1)} ${(bx - uy * h * 0.45).toFixed(1)},${(by + ux * h * 0.45).toFixed(1)} ${(bx + uy * h * 0.45).toFixed(1)},${(by - ux * h * 0.45).toFixed(1)}`, ux, uy, color };
  };
  const parts: string[] = [];
  // Floor grid (x–y plane).
  const step = step3d(extent);
  for (let k = -extent; k <= extent + 1e-9; k += step) {
    parts.push(line([k, -extent, 0], [k, extent, 0], "plot-grid"));
    parts.push(line([-extent, k, 0], [extent, k, 0], "plot-grid"));
  }
  // Axes with arrows, names and a few numbers.
  const axes: [string, [number, number, number]][] = [
    ["x", [1, 0, 0]],
    ["y", [0, 1, 0]],
    ["z", [0, 0, 1]],
  ];
  for (const [name, d] of axes) {
    const end: [number, number, number] = [d[0] * (extent + 0.6), d[1] * (extent + 0.6), d[2] * (extent + 0.6)];
    parts.push(line([-d[0] * extent, -d[1] * extent, -d[2] * extent], end, "plot-axis"));
    const head = arrowHead(project([0, 0, 0]), project(end), 9, "");
    parts.push(`<polygon class="plot-axis-head" points="${head.points}"/>`);
    const tip = project(end);
    parts.push(`<text class="plot-axis-name" x="${(tip.x + head.ux * 12).toFixed(1)}" y="${(tip.y + head.uy * 12 + 4).toFixed(1)}" text-anchor="middle">${name}</text>`);
    for (let k = step; k <= extent + 1e-9; k += step) {
      const at = project([d[0] * k, d[1] * k, d[2] * k]);
      parts.push(`<circle class="plot-axis-tick" cx="${at.x.toFixed(1)}" cy="${at.y.toFixed(1)}" r="1.6"/>`);
      if (k === extent || k === step) parts.push(`<text class="plot-tick" x="${(at.x + 8).toFixed(1)}" y="${(at.y + 12).toFixed(1)}">${number(k)}</text>`);
    }
  }
  // Vectors, the far ones first; dashed guides from the tip to the floor.
  const order = vectors
    .map((v, i) => ({ v, i }))
    .filter((e): e is { v: [number, number, number]; i: number } => !!e.v)
    .sort((a, b) => project(b.v).depth - project(a.v).depth);
  for (const { v, i } of order) {
    const color = config.functions[i].color;
    const [x, y, z] = v;
    if (Math.abs(z) > 1e-9) parts.push(line([x, y, 0], v, "plot-guide", color));
    if (Math.abs(x) > 1e-9 && Math.abs(y) > 1e-9) parts.push(line([x, 0, 0], [x, y, 0], "plot-guide", color), line([0, y, 0], [x, y, 0], "plot-guide", color));
    const o = project([0, 0, 0]),
      tip = project(v);
    if (Math.hypot(tip.x - o.x, tip.y - o.y) < 1) {
      parts.push(`<circle cx="${o.x}" cy="${o.y}" r="3" fill="${color}"/>`);
      continue;
    }
    const head = arrowHead(o, tip, 12, color);
    const lx = tip.x + head.ux * 10 + head.uy * 8,
      ly = tip.y + head.uy * 10 - head.ux * 8;
    parts.push(
      `<g class="plot-vector"><title>${escape(`${tr("Vektor", "Vector")} ${names[i]} = (${v.map(number).join(" | ")})`)}</title><line x1="${o.x.toFixed(1)}" y1="${o.y.toFixed(1)}" x2="${head.base.x.toFixed(1)}" y2="${head.base.y.toFixed(1)}" stroke="${color}"/><polygon points="${head.points}" fill="${color}"/><text x="${lx.toFixed(1)}" y="${(ly + 4).toFixed(1)}" fill="${color}" text-anchor="middle">${escape(names[i])}</text>${nameArrow(lx, ly - 8, color)}</g>`,
    );
  }
  // Legend; functions of x are not drawn in space.
  config.functions.forEach((f, i) => {
    const vector = vectors[i];
    const text = vector ? `${names[i]} = ${f.expr}` : `${names[i]}(x) = ${f.expr}`;
    parts.push(
      `<g class="plot-legend" transform="translate(${PAD + 10},${PAD + 16 + i * 20})"><rect x="0" y="-9" width="14" height="4" rx="2" fill="${f.color}"/><text x="20" y="-3"${vector ? "" : ' class="plot-invalid"'}>${escape(text)}${vector ? "" : `<title>${escape(tr("Funktionen werden nur im 2D-Graphen gezeichnet", "Functions are only drawn in a 2D graph"))}</title>`}</text>${vector ? nameArrow(24, -14, "currentColor") : ""}</g>`,
    );
  });
  parts.push(`<text class="plot-hint" x="${W - PAD - 6}" y="${H - PAD - 6}" text-anchor="end">${escape(tr("Ziehen dreht die Ansicht", "Drag to turn the view"))}</text>`);
  return `<svg class="plot-svg plot-3d" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escape(label)}">${parts.join("")}</svg>`;
}
const step3d = (extent: number) => (extent <= 6 ? 1 : extent <= 12 ? 2 : step(extent, 5));

type MountOptions = {
  editable: boolean;
  // Called with the new configuration while editing (functions or view).
  onChange?: (config: PlotConfig) => void;
};
// Draws the graph into `element` and makes it interactive. Returns update
// (for changes from outside) and destroy.
export function mountPlot(element: HTMLElement, initial: PlotConfig, options: MountOptions) {
  let config: PlotConfig = { functions: initial.functions.slice(), view: initial.view || null, camera: initial.camera || null };
  const camera = () => config.camera || DEFAULT_CAMERA;
  element.classList.add("function-plot");
  element.innerHTML = "";
  const stage = document.createElement("div");
  stage.className = "plot-stage";
  const controls = document.createElement("div");
  controls.className = "plot-controls";
  element.append(stage, controls);
  const currentView = () =>
    config.view ||
    autoView(
      config.functions.map((f) => compileFunction(f.expr)),
      config.functions.map((f) => planeVector(f.expr)).filter((v): v is [number, number] => !!v),
    );
  const label = () =>
    (config.functions.every((f) => spaceVector(f.expr)) ? tr("Vektoren: ", "Vectors: ") : tr("Funktionsgraph: ", "Function graph: ")) +
    config.functions.map((f) => f.expr).join(", ");
  const draw = () => {
    stage.innerHTML = isSpace(config) ? plotSvg3d(config, camera(), label()) : plotSvg(config, currentView(), label());
  };
  const changed = () => options.onChange?.(config);

  // Zoom and reset buttons.
  const button = (text: string, title: string, action: () => void) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    b.title = title;
    b.setAttribute("aria-label", title);
    b.addEventListener("click", (e) => {
      e.preventDefault();
      action();
    });
    return b;
  };
  const zoom = (factor: number, cx?: number, cy?: number) => {
    if (isSpace(config)) {
      const c = camera();
      config = { ...config, camera: { ...c, zoom: Math.max(0.1, Math.min(20, c.zoom / factor)) } };
      draw();
      changed();
      return;
    }
    const v = currentView();
    const x0 = cx ?? (v.xMin + v.xMax) / 2,
      y0 = cy ?? (v.yMin + v.yMax) / 2;
    config = {
      ...config,
      view: { xMin: x0 + (v.xMin - x0) * factor, xMax: x0 + (v.xMax - x0) * factor, yMin: y0 + (v.yMin - y0) * factor, yMax: y0 + (v.yMax - y0) * factor },
    };
    draw();
    changed();
  };
  const zoomBar = document.createElement("div");
  zoomBar.className = "plot-zoom";
  zoomBar.append(
    button("+", tr("Vergrößern", "Zoom in"), () => zoom(0.7)),
    button("−", tr("Verkleinern", "Zoom out"), () => zoom(1 / 0.7)),
    button("⟲", tr("Ansicht zurücksetzen", "Reset view"), () => {
      config = { ...config, view: null, camera: null };
      draw();
      changed();
    }),
  );
  stage.after(zoomBar);

  // Dragging moves the view; ⌘/Ctrl + scroll zooms at the pointer.
  let drag: { x: number; y: number; view: PlotView; camera: PlotCamera } | null = null;
  const toUnits = (event: PointerEvent | WheelEvent) => {
    const rect = stage.getBoundingClientRect();
    const v = currentView();
    return {
      x: v.xMin + ((event.clientX - rect.left) / rect.width) * (v.xMax - v.xMin),
      y: v.yMax - ((event.clientY - rect.top) / rect.height) * (v.yMax - v.yMin),
      perPixelX: (v.xMax - v.xMin) / rect.width,
      perPixelY: (v.yMax - v.yMin) / rect.height,
    };
  };
  stage.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    drag = { x: event.clientX, y: event.clientY, view: currentView(), camera: camera() };
    stage.setPointerCapture(event.pointerId);
    stage.classList.add("dragging");
  });
  stage.addEventListener("pointermove", (event) => {
    if (!drag) return;
    if (isSpace(config)) {
      // Turning: sideways around z, up and down tilts.
      const yaw = drag.camera.yaw - (event.clientX - drag.x) * 0.5,
        pitch = Math.max(-10, Math.min(89, drag.camera.pitch + (event.clientY - drag.y) * 0.4));
      config = { ...config, camera: { ...drag.camera, yaw: ((yaw % 360) + 540) % 360 - 180, pitch } };
      draw();
      return;
    }
    const { perPixelX, perPixelY } = toUnits(event);
    const mx = (event.clientX - drag.x) * perPixelX,
      my = (event.clientY - drag.y) * perPixelY;
    config = { ...config, view: { xMin: drag.view.xMin - mx, xMax: drag.view.xMax - mx, yMin: drag.view.yMin + my, yMax: drag.view.yMax + my } };
    draw();
  });
  const end = () => {
    if (!drag) return;
    drag = null;
    stage.classList.remove("dragging");
    changed();
  };
  stage.addEventListener("pointerup", end);
  stage.addEventListener("pointercancel", end);
  stage.addEventListener(
    "wheel",
    (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const { x, y } = isSpace(config) ? { x: undefined, y: undefined } : toUnits(event);
      zoom(event.deltaY > 0 ? 1.15 : 1 / 1.15, x, y);
    },
    { passive: false },
  );

  // The functions, edited below the graph.
  const renderInputs = () => {
    controls.innerHTML = "";
    if (!options.editable) return;
    config.functions.forEach((f, i) => {
      const row = document.createElement("div");
      row.className = "plot-function";
      const swatch = document.createElement("span");
      swatch.className = "plot-swatch";
      swatch.style.background = f.color;
      const name = document.createElement("span");
      name.className = "plot-name";
      const named = entryNames(config)[i];
      const setName = (vector: boolean, n: string) => {
        name.textContent = vector ? `${n} =` : `${n}(x) =`;
        name.classList.toggle("vector", vector);
      };
      setName(!!spaceVector(f.expr), named);
      const input = document.createElement("input");
      input.value = f.expr;
      input.maxLength = 200;
      input.spellcheck = false;
      input.placeholder = tr("x² − 2, (3; 2) oder (1; 2; 3)", "x² − 2, (3, 2) or (1, 2, 3)");
      input.setAttribute("aria-label", spaceVector(f.expr) ? tr(`Vektor ${named}`, `Vector ${named}`) : tr(`Funktion ${named}`, `Function ${named}`));
      input.classList.toggle("invalid", !isValidFunction(f.expr));
      input.addEventListener("input", () => {
        config = { ...config, functions: config.functions.map((g, j) => (j === i ? { ...g, expr: input.value } : g)) };
        input.classList.toggle("invalid", !!input.value.trim() && !isValidFunction(input.value));
        setName(!!spaceVector(input.value), entryNames(config)[i]);
        draw();
        changed();
      });
      const remove = button("×", tr("Funktion entfernen", "Remove function"), () => {
        config = { ...config, functions: config.functions.filter((_, j) => j !== i) };
        renderInputs();
        draw();
        changed();
      });
      row.append(swatch, name, input, remove);
      controls.append(row);
    });
    if (config.functions.length < MAX_FUNCTIONS)
      controls.append(
        button(tr("+ Funktion", "+ Function"), tr("Funktion hinzufügen", "Add function"), () => {
          const used = new Set(config.functions.map((f) => f.color));
          config = { ...config, functions: [...config.functions, { expr: "", color: PLOT_COLORS.find((c) => !used.has(c)) || PLOT_COLORS[0] }] };
          renderInputs();
          draw();
          (controls.querySelectorAll("input")[config.functions.length - 1] as HTMLInputElement | undefined)?.focus();
        }),
      );
  };
  renderInputs();
  draw();
  return {
    update(next: PlotConfig) {
      // Changes from elsewhere (another person); an input being typed in keeps its text.
      const typing = element.contains(document.activeElement) && document.activeElement?.tagName === "INPUT";
      config = { functions: next.functions.slice(), view: next.view || null, camera: next.camera || null };
      if (!typing) renderInputs();
      draw();
    },
    destroy() {
      element.innerHTML = "";
    },
  };
}
