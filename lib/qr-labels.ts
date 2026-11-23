// QR codes for pages and records (#448): the address a code holds, and the
// label sheets a database prints – presets of common label sheets, a
// custom layout, where each label sits on the sheet, how the code and the
// text share a label, and the style sheet that prints it at exact sizes.
// All lengths in millimetres. Client-safe and pure.
import { pageLocationHash } from "./page-location";

// The address of a page or a record, as "Copy link" gives it: the
// instance's address (origin and path, never a hash) with the page's hash.
// Only ids – who opens it must be signed in and allowed to see it.
export function itemLink(base: string, target: { pageId: string; rowId?: string }) {
  return `${base.replace(/[#?].*$/, "")}${pageLocationHash({ pageId: target.pageId, ...(target.rowId ? { rowId: target.rowId } : {}) })}`;
}

export type Paper = "a4" | "letter";
export const PAPER_SIZE: Record<Paper, { width: number; height: number }> = {
  a4: { width: 210, height: 297 },
  letter: { width: 215.9, height: 279.4 },
};

export type LabelLayout = {
  paper: Paper;
  columns: number;
  rows: number;
  // One label.
  width: number;
  height: number;
  // From the sheet's top and left edge to the first label.
  marginTop: number;
  marginLeft: number;
  // Between two labels side by side and one above the other.
  gapX: number;
  gapY: number;
};

const INCH = 25.4;
export type LabelPreset = { id: string; name: string; layout: LabelLayout };
// Common sheets: the margins centre the labels on the paper as the makers do.
export const LABEL_PRESETS: readonly LabelPreset[] = [
  { id: "a4-3x8", name: "A4 3 × 8 · 70 × 37 mm", layout: { paper: "a4", columns: 3, rows: 8, width: 70, height: 37, marginTop: 0.5, marginLeft: 0, gapX: 0, gapY: 0 } },
  { id: "a4-3x7", name: "A4 3 × 7 · 70 × 42,3 mm", layout: { paper: "a4", columns: 3, rows: 7, width: 70, height: 42.3, marginTop: 0.45, marginLeft: 0, gapX: 0, gapY: 0 } },
  {
    id: "a4-2x7",
    name: "A4 2 × 7 · 99,1 × 38,1 mm (Avery L7163)",
    layout: { paper: "a4", columns: 2, rows: 7, width: 99.1, height: 38.1, marginTop: 15.15, marginLeft: 4.65, gapX: 2.5, gapY: 0 },
  },
  {
    id: "letter-3x10",
    name: "Letter 3 × 10 · 2.625 × 1 in (Avery 5160)",
    layout: { paper: "letter", columns: 3, rows: 10, width: 2.625 * INCH, height: INCH, marginTop: 0.5 * INCH, marginLeft: 0.1875 * INCH, gapX: 0.125 * INCH, gapY: 0 },
  },
];
export const presetLayout = (id: string) => LABEL_PRESETS.find((p) => p.id === id)?.layout;

// At most this many labels in one print (a few dozen sheets).
export const MAX_LABELS = 1000;
// What a custom layout may be.
export const LABEL_LIMITS = {
  columns: [1, 10],
  rows: [1, 40],
  width: [10, 300],
  height: [10, 300],
  marginTop: [0, 100],
  marginLeft: [0, 100],
  gapX: [0, 50],
  gapY: [0, 50],
} as const satisfies Record<Exclude<keyof LabelLayout, "paper">, readonly [number, number]>;

// Why a layout cannot be printed: a value outside its limits, or labels
// that run past the paper's right or bottom edge (half a millimetre is
// allowed for rounding).
export type LayoutProblem = { kind: "range"; key: keyof typeof LABEL_LIMITS } | { kind: "width" } | { kind: "height" };
export function layoutProblem(layout: LabelLayout): LayoutProblem | null {
  for (const key of Object.keys(LABEL_LIMITS) as (keyof typeof LABEL_LIMITS)[]) {
    const value = layout[key],
      [min, max] = LABEL_LIMITS[key];
    if (!Number.isFinite(value) || value < min || value > max || ((key === "columns" || key === "rows") && !Number.isInteger(value)))
      return { kind: "range", key };
  }
  const paper = PAPER_SIZE[layout.paper];
  if (!paper) return { kind: "range", key: "width" };
  if (layout.marginLeft + layout.columns * layout.width + (layout.columns - 1) * layout.gapX > paper.width + 0.5) return { kind: "width" };
  if (layout.marginTop + layout.rows * layout.height + (layout.rows - 1) * layout.gapY > paper.height + 0.5) return { kind: "height" };
  return null;
}

export const labelsPerSheet = (layout: LabelLayout) => layout.columns * layout.rows;

// The top left corner of a place on the sheet, counted row by row from the
// top left (0 … labelsPerSheet - 1).
export function slotPosition(layout: LabelLayout, slot: number) {
  const column = slot % layout.columns,
    row = Math.floor(slot / layout.columns);
  return { x: round(layout.marginLeft + column * (layout.width + layout.gapX)), y: round(layout.marginTop + row * (layout.height + layout.gapY)) };
}

// The places to skip on a partly used first sheet: 0 up to one less than a sheet.
export const clampSkip = (layout: LabelLayout, skip: number) =>
  Math.max(0, Math.min(labelsPerSheet(layout) - 1, Number.isFinite(skip) ? Math.floor(skip) : 0));

export type LabelPlace = { slot: number; x: number; y: number; record: number };
// The sheets for `count` records (at most MAX_LABELS), the first `skip`
// places of the first sheet left empty: per sheet the places that get a
// label, with the index of their record.
export function labelSheets(layout: LabelLayout, count: number, skip = 0): LabelPlace[][] {
  const per = labelsPerSheet(layout),
    total = Math.max(0, Math.min(MAX_LABELS, Math.floor(count))),
    first = clampSkip(layout, skip);
  const sheets: LabelPlace[][] = [];
  for (let record = 0; record < total; record++) {
    const at = first + record,
      sheet = Math.floor(at / per),
      slot = at % per;
    (sheets[sheet] ||= []).push({ slot, ...slotPosition(layout, slot), record });
  }
  return sheets;
}

// How the code and the text share one label: the code on the left and
// the text beside it, or the code on top and the text below. `lines` is
// the title plus the properties shown.
export type LabelText = "beside" | "below";
export function labelBox(layout: Pick<LabelLayout, "width" | "height">, placement: LabelText, lines: number) {
  const { width: w, height: h } = layout;
  const pad = round(clamp(Math.min(w, h) * 0.06, 1, 3));
  const title = round(clamp(Math.min(h, w) * (placement === "beside" ? 0.09 : 0.07), 2.1, 4.2));
  const detail = round(title * 0.82);
  if (placement === "beside") {
    const code = round(Math.max(0, Math.min(h - 2 * pad, (w - 2 * pad) * 0.5)));
    const x = round(pad + code + pad);
    return { pad, code, codeX: pad, codeY: round((h - code) / 2), text: { x, y: pad, width: round(Math.max(0, w - x - pad)), height: round(h - 2 * pad) }, title, detail };
  }
  const textHeight = round(lines > 0 ? title * 1.25 + Math.max(0, lines - 1) * detail * 1.25 : 0);
  const code = round(Math.max(0, Math.min(w - 2 * pad, h - 2 * pad - textHeight - (lines > 0 ? pad / 2 : 0))));
  const y = round(pad + code + pad / 2);
  return { pad, code, codeX: round((w - code) / 2), codeY: pad, text: { x: pad, y, width: round(w - 2 * pad), height: round(Math.max(0, h - y - pad)) }, title, detail };
}
// Below this a phone's camera hardly reads a code from a label.
export const MIN_CODE_MM = 12;

// The style sheet of the sheets (components/qr-labels.tsx): lengths as
// multiples of --u, which is 1mm in print and a few pixels in the preview.
// With `print` also the paper (@page, no margins, so the browser adds no
// headers) and a page break after each sheet. Numbers only – nothing a
// person typed goes into it.
export function labelSheetCss(layout: LabelLayout, placement: LabelText, lines: number, print: boolean) {
  const u = (mm: number) => `calc(${round(mm)} * var(--u))`;
  const paper = PAPER_SIZE[layout.paper];
  const box = labelBox(layout, placement, lines);
  const rules = [
    `.qrl-page{width:${u(paper.width)};height:${u(paper.height)}}`,
    `.qrl-label{width:${u(layout.width)};height:${u(layout.height)}}`,
    `.qrl-code{left:${u(box.codeX)};top:${u(box.codeY)};width:${u(box.code)};height:${u(box.code)}}`,
    `.qrl-text{left:${u(box.text.x)};top:${u(box.text.y)};width:${u(box.text.width)};height:${u(box.text.height)}${placement === "below" ? ";text-align:center" : ""}}`,
    `.qrl-title{font-size:${u(box.title)}}`,
    `.qrl-detail{font-size:${u(box.detail)}}`,
  ];
  for (let slot = 0; slot < labelsPerSheet(layout); slot++) {
    const { x, y } = slotPosition(layout, slot);
    rules.push(`.qrl-s${slot}{left:${u(x)};top:${u(y)}}`);
  }
  if (print)
    rules.push(
      `@page{size:${paper.width}mm ${paper.height}mm;margin:0}`,
      "@media print{html,body{margin:0!important;padding:0!important;background:#fff!important}.qrl-page{break-after:page}.qrl-page:last-child{break-after:auto}}",
    );
  return rules.join("\n");
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const round = (value: number) => Math.round(value * 100) / 100;
