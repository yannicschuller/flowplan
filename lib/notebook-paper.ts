// Paper of notebook sheets (lib/notebook.ts): templates, sizes, colours and
// the lines and dots they consist of. Free of React and the DOM: the sheet
// view (SVG), the published page and the PDF export draw the same shapes.
//
// Units are points (1/72 inch) like the ink on top (lib/ink/README.md),
// origin top left, y down.

export const PAPER_TEMPLATES = ["blank", "lined-college", "lined-wide", "grid", "dotted", "cornell", "music"] as const;
export const PAPER_SIZES = ["a4", "letter"] as const;
export const PAPER_ORIENTATIONS = ["portrait", "landscape"] as const;
export const PAPER_COLORS = ["light", "dark"] as const;
export type PaperTemplate = (typeof PAPER_TEMPLATES)[number];
export type PaperSize = (typeof PAPER_SIZES)[number];
export type PaperOrientation = (typeof PAPER_ORIENTATIONS)[number];
export type PaperColor = (typeof PAPER_COLORS)[number];
export type Paper = { template: PaperTemplate; size: PaperSize; orientation: PaperOrientation; color: PaperColor };
// A sheet's own choices; what it leaves out comes from the notebook.
export type PaperOverride = Partial<Paper>;

export const DEFAULT_PAPER: Paper = { template: "lined-college", size: "a4", orientation: "portrait", color: "light" };

export const MM = 72 / 25.4;
// Portrait sizes in points.
export const SHEET_SIZES: Record<PaperSize, { width: number; height: number }> = {
  a4: { width: 595.28, height: 841.89 },
  letter: { width: 612, height: 792 },
};
// Line spacing: college ruled 9/32 in (7.1 mm), wide ruled 11/32 in (8.7 mm).
export const RULING = { college: 20.25, wide: 24.75 };
export const GRID_STEP = 5 * MM;

export function cleanPaper(raw: unknown): PaperOverride {
  const out: PaperOverride = {};
  if (!raw || typeof raw !== "object") return out;
  const value = raw as Record<string, unknown>;
  if (PAPER_TEMPLATES.includes(value.template as PaperTemplate)) out.template = value.template as PaperTemplate;
  if (PAPER_SIZES.includes(value.size as PaperSize)) out.size = value.size as PaperSize;
  if (PAPER_ORIENTATIONS.includes(value.orientation as PaperOrientation)) out.orientation = value.orientation as PaperOrientation;
  if (PAPER_COLORS.includes(value.color as PaperColor)) out.color = value.color as PaperColor;
  return out;
}
export const fullPaper = (raw: unknown): Paper => ({ ...DEFAULT_PAPER, ...cleanPaper(raw) });
// The paper a sheet shows: its own choices over the notebook's.
export const effectivePaper = (defaults: Paper, override: PaperOverride | null | undefined): Paper => ({ ...defaults, ...cleanPaper(override) });

export function paperSize(paper: Pick<Paper, "size" | "orientation">) {
  const base = SHEET_SIZES[paper.size] || SHEET_SIZES.a4;
  return paper.orientation === "landscape" ? { width: base.height, height: base.width } : { ...base };
}

export type PaperShape =
  | { type: "line"; x1: number; y1: number; x2: number; y2: number; width: number; color: string }
  | { type: "dot"; x: number; y: number; r: number; color: string };
export type PaperLayout = { width: number; height: number; background: string; shapes: PaperShape[] };

export const PAPER_TONES = {
  light: { background: "#ffffff", line: "#c9d6e8", margin: "#eaa9a9", grid: "#d9dfe7", dot: "#a9b2be", staff: "#8f98a3", text: "#1f1f1f" },
  dark: { background: "#1f2125", line: "#3c424c", margin: "#6e3f43", grid: "#353a42", dot: "#5d6571", staff: "#6d7581", text: "#f1f3f5" },
} as const;

const r2 = (n: number) => Math.round(n * 100) / 100;
const line = (x1: number, y1: number, x2: number, y2: number, width: number, color: string): PaperShape => ({
  type: "line",
  x1: r2(x1),
  y1: r2(y1),
  x2: r2(x2),
  y2: r2(y2),
  width,
  color,
});

// Horizontal rules from `top` while they stay above `bottom`.
function rules(from: number, to: number, top: number, bottom: number, step: number, color: string) {
  const out: PaperShape[] = [];
  for (let y = top; y <= bottom + 0.01; y += step) out.push(line(from, y, to, y, 0.5, color));
  return out;
}

// The lines and dots of a template on a sheet of `size` (paper size by
// default; imported PDF pages bring their own).
export function paperLayout(paper: Paper, size = paperSize(paper)): PaperLayout {
  const tone = PAPER_TONES[paper.color] || PAPER_TONES.light;
  const { width: w, height: h } = size;
  const shapes: PaperShape[] = [];
  switch (paper.template) {
    case "lined-college":
    case "lined-wide": {
      const step = paper.template === "lined-wide" ? RULING.wide : RULING.college;
      shapes.push(...rules(0, w, 72, h - 36, step, tone.line));
      // The margin on the left.
      shapes.push(line(90, 0, 90, h, 0.75, tone.margin));
      break;
    }
    case "grid": {
      const step = GRID_STEP;
      const ox = (w % step) / 2,
        oy = (h % step) / 2;
      for (let x = ox; x <= w + 0.01; x += step) shapes.push(line(x, 0, x, h, 0.4, tone.grid));
      for (let y = oy; y <= h + 0.01; y += step) shapes.push(line(0, y, w, y, 0.4, tone.grid));
      break;
    }
    case "dotted": {
      const step = GRID_STEP;
      const ox = (w % step) / 2 || step,
        oy = (h % step) / 2 || step;
      for (let y = oy + step; y < h - step / 2; y += step)
        for (let x = ox + step; x < w - step / 2; x += step) shapes.push({ type: "dot", x: r2(x), y: r2(y), r: 0.8, color: tone.dot });
      break;
    }
    case "cornell": {
      // Title band at the top, cue column on the left, summary at the bottom.
      const header = 72,
        summary = h - Math.round(h * 0.18),
        cue = Math.round(w * 0.3);
      shapes.push(...rules(0, w, header + RULING.college, summary - RULING.college / 2, RULING.college, tone.line));
      shapes.push(line(0, header, w, header, 1, tone.staff));
      shapes.push(line(0, summary, w, summary, 1, tone.staff));
      shapes.push(line(cue, header, cue, summary, 1, tone.staff));
      break;
    }
    case "music": {
      const staves = h > w ? 12 : 8;
      const margin = 54,
        slot = (h - margin * 2) / staves;
      const gap = Math.min(5.5, (slot * 0.45) / 4);
      for (let s = 0; s < staves; s++) {
        const top = margin + s * slot + (slot - gap * 4) / 2;
        for (let l = 0; l < 5; l++) shapes.push(line(36, top + l * gap, w - 36, top + l * gap, 0.6, tone.staff));
      }
      break;
    }
    default:
      break;
  }
  return { width: w, height: h, background: tone.background, shapes };
}

// Paper of a drawing block in a document (lib/draw-block-node.ts): no
// margins, the background is the document's (transparent).
export function blockPaperLayout(kind: "blank" | "lined" | "grid", size: { width: number; height: number }): PaperLayout {
  const tone = PAPER_TONES.light;
  const shapes: PaperShape[] = [];
  if (kind === "lined") shapes.push(...rules(0, size.width, RULING.wide, size.height - 4, RULING.wide, tone.line));
  if (kind === "grid") {
    for (let x = GRID_STEP; x < size.width; x += GRID_STEP) shapes.push(line(x, 0, x, size.height, 0.4, tone.grid));
    for (let y = GRID_STEP; y < size.height; y += GRID_STEP) shapes.push(line(0, y, size.width, y, 0.4, tone.grid));
  }
  return { width: size.width, height: size.height, background: "transparent", shapes };
}

// The shapes as SVG elements (sheet view, published page, exports).
export function paperSvg(layout: PaperLayout) {
  let out =
    layout.background === "transparent" ? "" : `<rect x="0" y="0" width="${r2(layout.width)}" height="${r2(layout.height)}" fill="${layout.background}"/>`;
  for (const s of layout.shapes)
    out +=
      s.type === "line"
        ? `<line x1="${s.x1}" y1="${s.y1}" x2="${s.x2}" y2="${s.y2}" stroke="${s.color}" stroke-width="${s.width}"/>`
        : `<circle cx="${s.x}" cy="${s.y}" r="${s.r}" fill="${s.color}"/>`;
  return out;
}

// ---- Order of sheets ----

// `ids` with `id` inserted after `after` (null: at the end).
export function insertAfter(ids: string[], id: string, after: string | null) {
  const list = ids.filter((x) => x !== id);
  const index = after === null ? -1 : list.indexOf(after);
  if (index < 0) return [...list, id];
  return [...list.slice(0, index + 1), id, ...list.slice(index + 1)];
}
// `ids` with `id` moved to position `to` (clamped).
export function moveTo(ids: string[], id: string, to: number) {
  if (!ids.includes(id)) return ids;
  const list = ids.filter((x) => x !== id);
  const index = Math.max(0, Math.min(list.length, Math.round(to)));
  return [...list.slice(0, index), id, ...list.slice(index)];
}
// Whether `next` holds exactly the sheets of `current` (a reorder, nothing lost).
export function sameSheets(current: string[], next: string[]) {
  if (current.length !== next.length || new Set(next).size !== next.length) return false;
  const known = new Set(current);
  return next.every((id) => known.has(id));
}
