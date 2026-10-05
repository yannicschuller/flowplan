// Function graphs in documents: one or more functions of x drawn as SVG with
// grid, axes and zeros. The block stores what was written ("x² − 2") and an
// optional view; the drawing is made in the browser. Dragging moves the view,
// the buttons and ⌘/Ctrl + scroll zoom. In the editor the functions are
// edited below the graph and redrawn while typing.
import { compile } from "mathjs";
import { functionExpression } from "./math-solve";
import { LOCALE_TAG, tr } from "./locale-tag";

export type PlotFunction = { expr: string; color: string };
export type PlotView = { xMin: number; xMax: number; yMin: number; yMax: number };
export type PlotConfig = { functions: PlotFunction[]; view?: PlotView | null };

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
    return { functions, view };
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
export const isValidFunction = (expr: string) => !!compileFunction(expr);

// A view that shows the interesting part: x from −6 to 6 (zeros, vertex,
// a period of sin), y from what the functions do there, outliers cut off.
function autoView(fns: Compiled[]): PlotView {
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

// The SVG of a graph for a view.
export function plotSvg(config: PlotConfig, view: PlotView, label: string): string {
  const fns = config.functions.map((f) => compileFunction(f.expr));
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
  // Legend.
  config.functions.forEach((f, i) => {
    const valid = !!fns[i];
    parts.push(
      `<g class="plot-legend" transform="translate(${PAD + 10},${PAD + 16 + i * 20})"><rect x="0" y="-9" width="14" height="4" rx="2" fill="${f.color}"/><text x="20" y="-3"${valid ? "" : ' class="plot-invalid"'}>${escape(`${String.fromCharCode(102 + i)}(x) = ${f.expr}`)}</text></g>`,
    );
  });
  return `<svg class="plot-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escape(label)}">${parts.join("")}</svg>`;
}

type MountOptions = {
  editable: boolean;
  // Called with the new configuration while editing (functions or view).
  onChange?: (config: PlotConfig) => void;
};
// Draws the graph into `element` and makes it interactive. Returns update
// (for changes from outside) and destroy.
export function mountPlot(element: HTMLElement, initial: PlotConfig, options: MountOptions) {
  let config: PlotConfig = { functions: initial.functions.slice(), view: initial.view || null };
  element.classList.add("function-plot");
  element.innerHTML = "";
  const stage = document.createElement("div");
  stage.className = "plot-stage";
  const controls = document.createElement("div");
  controls.className = "plot-controls";
  element.append(stage, controls);
  const currentView = () => config.view || autoView(config.functions.map((f) => compileFunction(f.expr)));
  const label = () => tr("Funktionsgraph: ", "Function graph: ") + config.functions.map((f) => f.expr).join(", ");
  const draw = () => {
    stage.innerHTML = plotSvg(config, currentView(), label());
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
      config = { ...config, view: null };
      draw();
      changed();
    }),
  );
  stage.after(zoomBar);

  // Dragging moves the view; ⌘/Ctrl + scroll zooms at the pointer.
  let drag: { x: number; y: number; view: PlotView } | null = null;
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
    drag = { x: event.clientX, y: event.clientY, view: currentView() };
    stage.setPointerCapture(event.pointerId);
    stage.classList.add("dragging");
  });
  stage.addEventListener("pointermove", (event) => {
    if (!drag) return;
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
      const { x, y } = toUnits(event);
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
      name.textContent = `${String.fromCharCode(102 + i)}(x) =`;
      const input = document.createElement("input");
      input.value = f.expr;
      input.maxLength = 200;
      input.spellcheck = false;
      input.setAttribute("aria-label", tr(`Funktion ${String.fromCharCode(102 + i)}`, `Function ${String.fromCharCode(102 + i)}`));
      input.classList.toggle("invalid", !isValidFunction(f.expr));
      input.addEventListener("input", () => {
        config = { ...config, functions: config.functions.map((g, j) => (j === i ? { ...g, expr: input.value } : g)) };
        input.classList.toggle("invalid", !!input.value.trim() && !isValidFunction(input.value));
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
      config = { functions: next.functions.slice(), view: next.view || null };
      if (!typing) renderInputs();
      draw();
    },
    destroy() {
      element.innerHTML = "";
    },
  };
}
