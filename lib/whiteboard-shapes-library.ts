// Shape libraries for whiteboards: flowchart, BPMN, UML, ERD, org chart,
// network, cloud and wireframe shapes. Every shape is a "shape" item with a
// `lib` id ("flow:decision"); its `shape` is a plain outline for clients
// that do not know the library. The drawings are vector markup computed
// from the item's box and colours (no remote loading, no foreign artwork):
// all icons are drawn here for Flowplan and share its licence (AGPL-3.0).
// Cloud icons are generic (compute, storage, queue …) – no vendor artwork.
//
// The same drawing is used on the board (components/whiteboard/
// library-shape.tsx) and in the SVG export (lib/whiteboard-svg.ts). Texts
// come from the item's text: compartments (UML classes) are separated by a
// line "--", rows (ER entities, lists) are lines, tabs and menu entries are
// separated by "|".
import type { ShapeKind, WhiteboardItem } from "./whiteboard-model";

export type LibrarySetId = "flow" | "bpmn" | "uml" | "erd" | "org" | "net" | "cloud" | "wf";
// i18n-table: 1 – [German, English] names of the sets
export const librarySetNames: Record<LibrarySetId, [string, string]> = {
  flow: ["Flussdiagramm", "Flowchart"],
  bpmn: ["BPMN", "BPMN"],
  uml: ["UML", "UML"],
  erd: ["ER-Diagramm", "ER diagram"],
  org: ["Organigramm", "Org chart"],
  net: ["Netzwerk", "Network"],
  cloud: ["Cloud-Architektur", "Cloud architecture"],
  wf: ["Wireframes", "Wireframes"],
};
export const librarySetOrder: LibrarySetId[] = ["flow", "bpmn", "uml", "erd", "org", "net", "cloud", "wf"];

export type TextArea = {
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  align?: "left" | "center" | "right";
  valign?: "top" | "middle" | "bottom";
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  size?: number;
  color?: string;
  // Rotated by -90° (BPMN pool names).
  vertical?: boolean;
  pad?: number;
};
export type LibraryDrawing = { markup: string; texts: TextArea[] };
type Ctx = {
  w: number;
  h: number;
  fill: string;
  stroke: string;
  sw: number;
  text: string;
  size: number;
  textColor: string;
  dashed: boolean;
  // A second, quieter fill (title bars, placeholders).
  muted: string;
  // Previews in the library panel: no texts, no fixed colours.
  preview: boolean;
};
type ShapeDef = {
  id: string;
  set: LibrarySetId;
  w: number;
  h: number;
  outline: ShapeKind;
  keywords: string;
  fill?: string;
  stroke?: string;
  textColor?: string;
  fontSize?: number;
  // Large shapes that hold others (pools, windows): inserted below the rest.
  container?: boolean;
  draw: (c: Ctx) => LibraryDrawing | string;
};

// ---- markup helpers ----

const r = (n: number) => Math.round(n * 100) / 100;
const esc = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
// Only plain colours reach an attribute.
export const safeColor = (value: unknown, fallback: string) =>
  typeof value === "string" && /^(#[0-9a-f]{3,8}|[a-z]{3,20}|rgba?\([\d.,\s%]+\))$/i.test(value) ? value : fallback;
const paint = (c: Ctx, fill = c.fill, extra = "") =>
  `fill="${esc(fill)}" stroke="${esc(c.stroke)}" stroke-width="${r(c.sw)}"${c.dashed ? ' stroke-dasharray="8 6"' : ""} stroke-linejoin="round"${extra}`;
const path = (c: Ctx, d: string, fill = c.fill, extra = "") => `<path d="${d}" ${paint(c, fill, extra)}/>`;
const line = (c: Ctx, d: string, width = c.sw, extra = "") =>
  `<path d="${d}" fill="none" stroke="${esc(c.stroke)}" stroke-width="${r(width)}" stroke-linecap="round" stroke-linejoin="round"${extra}/>`;
const rect = (c: Ctx, x: number, y: number, w: number, h: number, rx = 0, fill = c.fill, extra = "") =>
  `<rect x="${r(x)}" y="${r(y)}" width="${r(Math.max(0, w))}" height="${r(Math.max(0, h))}" rx="${r(rx)}" ${paint(c, fill, extra)}/>`;
const circle = (c: Ctx, cx: number, cy: number, radius: number, fill = c.fill, extra = "") =>
  `<circle cx="${r(cx)}" cy="${r(cy)}" r="${r(Math.max(0, radius))}" ${paint(c, fill, extra)}/>`;
const ellipse = (c: Ctx, cx: number, cy: number, rx: number, ry: number, fill = c.fill) =>
  `<ellipse cx="${r(cx)}" cy="${r(cy)}" rx="${r(Math.max(0, rx))}" ry="${r(Math.max(0, ry))}" ${paint(c, fill)}/>`;
const full = (c: Ctx, extra: Partial<TextArea> = {}): TextArea => ({ x: 0, y: 0, w: c.w, h: c.h, text: c.text, ...extra });
const done = (markup: string, ...texts: TextArea[]): LibraryDrawing => ({ markup, texts });
const lines = (text: string) => text.split("\n");
// Compartments: lines "--" (or "==", "__") between them.
export const compartments = (text: string) => text.split(/\n?^\s*(?:-{2,}|={2,}|_{2,})\s*$\n?/m);
// Items of tabs and menus: "|" or line breaks between them.
const entries = (text: string) =>
  text
    .split(/\||\n/)
    .map((s) => s.trim())
    .filter(Boolean);

// Icon in a 48×48 grid, scaled into a box.
function icon(c: Ctx, box: { x: number; y: number; w: number; h: number }, draw: (k: Ctx) => string) {
  const size = Math.max(1, Math.min(box.w, box.h));
  const k = size / 48;
  const ox = box.x + (box.w - size) / 2,
    oy = box.y + (box.h - size) / 2;
  const inner = { ...c, sw: Math.max(0.5, c.sw / k), dashed: false };
  return `<g transform="translate(${r(ox)} ${r(oy)}) scale(${r(k * 1000) / 1000})">${draw(inner)}</g>`;
}
// Icon above its label (network and cloud shapes).
function iconWithLabel(c: Ctx, draw: (k: Ctx) => string, tile = false): LibraryDrawing {
  const label = c.preview ? 0 : Math.min(30, c.h * 0.3);
  const area = { x: 0, y: 0, w: c.w, h: c.h - label };
  let markup = "";
  if (tile) {
    const size = Math.min(area.w, area.h) * 0.92;
    markup += rect(c, (c.w - size) / 2, (area.h - size) / 2, size, size, size * 0.18, c.fill);
  }
  const pad = tile ? Math.min(area.w, area.h) * 0.2 : Math.min(area.w, area.h) * 0.04;
  markup += icon({ ...c, fill: tile ? "transparent" : c.fill }, { x: pad, y: pad, w: area.w - pad * 2, h: area.h - pad * 2 }, draw);
  return done(markup, { x: -20, y: c.h - label, w: c.w + 40, h: label + 16, text: c.text, valign: "top", pad: 2 });
}
const cylinder = (c: Ctx, x: number, y: number, w: number, h: number, fill = c.fill) => {
  const ry = Math.min(h * 0.15, w * 0.2, 14);
  return (
    path(c, `M ${r(x)} ${r(y + ry)} A ${r(w / 2)} ${r(ry)} 0 0 1 ${r(x + w)} ${r(y + ry)} V ${r(y + h - ry)} A ${r(w / 2)} ${r(ry)} 0 0 1 ${r(x)} ${r(y + h - ry)} Z`, fill) +
    line(c, `M ${r(x)} ${r(y + ry)} A ${r(w / 2)} ${r(ry)} 0 0 0 ${r(x + w)} ${r(y + ry)}`)
  );
};
const diamond = (w: number, h: number, x = 0, y = 0) =>
  `M ${r(x + w / 2)} ${r(y)} L ${r(x + w)} ${r(y + h / 2)} L ${r(x + w / 2)} ${r(y + h)} L ${r(x)} ${r(y + h / 2)} Z`;
const folded = (w: number, h: number, fold: number, x = 0, y = 0) =>
  `M ${r(x)} ${r(y)} H ${r(x + w - fold)} L ${r(x + w)} ${r(y + fold)} V ${r(y + h)} H ${r(x)} Z M ${r(x + w - fold)} ${r(y)} V ${r(y + fold)} H ${r(x + w)}`;
const stick = (c: Ctx, cx: number, top: number, height: number) => {
  const head = height * 0.16;
  const neck = top + head * 2,
    hip = top + height * 0.62;
  return (
    circle(c, cx, top + head, head) +
    line(c, `M ${r(cx)} ${r(neck)} V ${r(hip)} M ${r(cx - height * 0.26)} ${r(top + height * 0.4)} H ${r(cx + height * 0.26)} M ${r(cx)} ${r(hip)} L ${r(cx - height * 0.22)} ${r(top + height)} M ${r(cx)} ${r(hip)} L ${r(cx + height * 0.22)} ${r(top + height)}`)
  );
};
const person = (c: Ctx, cx: number, cy: number, radius: number) =>
  circle(c, cx, cy - radius * 0.32, radius * 0.36, c.fill) +
  path(c, `M ${r(cx - radius * 0.68)} ${r(cy + radius * 0.72)} C ${r(cx - radius * 0.68)} ${r(cy + radius * 0.1)} ${r(cx + radius * 0.68)} ${r(cy + radius * 0.1)} ${r(cx + radius * 0.68)} ${r(cy + radius * 0.72)} Z`, c.fill);

// Text rows with lines between them (ER entities, lists, class members).
function rows(c: Ctx, top: number, items: string[], options: { x?: number; bold?: (s: string) => boolean; separators?: boolean } = {}) {
  const lh = c.size * 1.45 + 6;
  let markup = "";
  const texts: TextArea[] = [];
  items.forEach((text, i) => {
    const y = top + i * lh;
    if (y + lh > c.h + 1) return;
    if (options.separators && i > 0) markup += line(c, `M 0 ${r(y)} H ${r(c.w)}`, Math.max(0.5, c.sw / 2));
    texts.push({ x: options.x ?? 0, y, w: c.w - (options.x ?? 0), h: lh, text, align: "left", valign: "middle", bold: options.bold?.(text), pad: 8 });
  });
  return { markup, texts };
}
function classShape(c: Ctx, rx = 0): LibraryDrawing {
  const parts = compartments(c.text);
  const head = lines(parts[0] || "");
  const lh = c.size * 1.4;
  const headH = Math.min(c.h, Math.max(1, head.length) * lh + 14);
  let markup = rect(c, 0, 0, c.w, c.h, rx);
  const texts: TextArea[] = head.map((text, i) => {
    const stereotype = /^(«|<<)/.test(text.trim());
    return { x: 0, y: 7 + i * lh, w: c.w, h: lh, text, bold: !stereotype, italic: stereotype, size: stereotype ? c.size * 0.9 : c.size, pad: 4 };
  });
  let y = headH;
  const rest = parts.slice(1);
  if (!rest.length && !c.preview) rest.push("");
  rest.forEach((part, i) => {
    markup += line(c, `M 0 ${r(y)} H ${r(c.w)}`);
    const items = part ? lines(part) : [];
    const height = i === rest.length - 1 ? c.h - y : Math.max(items.length, 1) * (c.size * 1.35) + 10;
    texts.push({ x: 0, y: y + 3, w: c.w, h: Math.max(0, height - 3), text: part, align: "left", valign: "top", pad: 8 });
    y += height;
  });
  if (c.preview) markup += line(c, `M 0 ${r(c.h * 0.33)} H ${r(c.w)} M 0 ${r(c.h * 0.66)} H ${r(c.w)}`);
  return { markup, texts };
}
function wfInline(c: Ctx, control: string, textX: number): LibraryDrawing {
  return done(control, { x: textX, y: 0, w: c.w - textX, h: c.h, text: c.text, align: "left", pad: 2 });
}

// ---- the shapes ----

const S = (def: ShapeDef) => def;
const shapes: ShapeDef[] = [
  // Flowchart
  S({ id: "flow:process", set: "flow", w: 160, h: 80, outline: "rectangle", keywords: "process step action schritt aktion prozess", draw: (c) => done(rect(c, 0, 0, c.w, c.h), full(c)) }),
  S({ id: "flow:decision", set: "flow", w: 160, h: 100, outline: "diamond", keywords: "decision condition if entscheidung bedingung verzweigung", draw: (c) => done(path(c, diamond(c.w, c.h)), full(c, { x: c.w * 0.18, y: c.h * 0.18, w: c.w * 0.64, h: c.h * 0.64, pad: 2 })) }),
  S({ id: "flow:terminator", set: "flow", w: 160, h: 64, outline: "rounded", keywords: "start end terminator begin stop anfang ende", draw: (c) => done(rect(c, 0, 0, c.w, c.h, c.h / 2), full(c)) }),
  S({ id: "flow:data", set: "flow", w: 170, h: 80, outline: "parallelogram", keywords: "data input output daten eingabe ausgabe io", draw: (c) => done(path(c, `M ${r(c.w * 0.18)} 0 H ${r(c.w)} L ${r(c.w * 0.82)} ${r(c.h)} H 0 Z`), full(c, { x: c.w * 0.15, w: c.w * 0.7 })) }),
  S({ id: "flow:document", set: "flow", w: 160, h: 90, outline: "rectangle", keywords: "document report dokument bericht", draw: (c) => done(path(c, `M 0 0 H ${r(c.w)} V ${r(c.h * 0.82)} C ${r(c.w * 0.75)} ${r(c.h * 0.66)} ${r(c.w * 0.3)} ${r(c.h * 1.04)} 0 ${r(c.h * 0.86)} Z`), full(c, { h: c.h * 0.8 })) }),
  S({
    id: "flow:multidoc", set: "flow", w: 170, h: 100, outline: "rectangle", keywords: "documents multiple dokumente mehrere",
    draw: (c) => {
      const o = Math.min(10, c.w * 0.06, c.h * 0.08);
      const doc = (x: number, y: number) => path(c, `M ${r(x)} ${r(y)} H ${r(x + c.w - 2 * o)} V ${r(y + (c.h - 2 * o) * 0.82)} C ${r(x + (c.w - 2 * o) * 0.75)} ${r(y + (c.h - 2 * o) * 0.66)} ${r(x + (c.w - 2 * o) * 0.3)} ${r(y + (c.h - 2 * o) * 1.04)} ${r(x)} ${r(y + (c.h - 2 * o) * 0.86)} Z`);
      return done(doc(2 * o, 0) + doc(o, o) + doc(0, 2 * o), { x: 0, y: 2 * o, w: c.w - 2 * o, h: (c.h - 2 * o) * 0.8, text: c.text });
    },
  }),
  S({ id: "flow:predefined", set: "flow", w: 170, h: 80, outline: "rectangle", keywords: "predefined process subroutine unterprogramm vordefiniert", draw: (c) => { const e = Math.min(14, c.w * 0.1); return done(rect(c, 0, 0, c.w, c.h) + line(c, `M ${r(e)} 0 V ${r(c.h)} M ${r(c.w - e)} 0 V ${r(c.h)}`), full(c, { x: e, w: c.w - 2 * e })); } }),
  S({ id: "flow:manual-input", set: "flow", w: 160, h: 80, outline: "rectangle", keywords: "manual input manuelle eingabe", draw: (c) => done(path(c, `M 0 ${r(c.h * 0.3)} L ${r(c.w)} 0 V ${r(c.h)} H 0 Z`), full(c, { y: c.h * 0.2, h: c.h * 0.8 })) }),
  S({ id: "flow:manual-op", set: "flow", w: 160, h: 80, outline: "rectangle", keywords: "manual operation manuelle operation trapez", draw: (c) => done(path(c, `M 0 0 H ${r(c.w)} L ${r(c.w * 0.84)} ${r(c.h)} H ${r(c.w * 0.16)} Z`), full(c, { x: c.w * 0.14, w: c.w * 0.72 })) }),
  S({ id: "flow:database", set: "flow", w: 120, h: 100, outline: "rectangle", keywords: "database storage cylinder datenbank speicher zylinder", draw: (c) => { const ry = Math.min(c.h * 0.15, c.w * 0.2, 14); return done(cylinder(c, 0, 0, c.w, c.h), full(c, { y: ry * 2, h: c.h - ry * 2 })); } }),
  S({ id: "flow:preparation", set: "flow", w: 170, h: 80, outline: "hexagon", keywords: "preparation vorbereitung hexagon sechseck", draw: (c) => done(path(c, `M ${r(c.w * 0.15)} 0 H ${r(c.w * 0.85)} L ${r(c.w)} ${r(c.h / 2)} L ${r(c.w * 0.85)} ${r(c.h)} H ${r(c.w * 0.15)} L 0 ${r(c.h / 2)} Z`), full(c, { x: c.w * 0.12, w: c.w * 0.76 })) }),
  S({ id: "flow:delay", set: "flow", w: 150, h: 80, outline: "rounded", keywords: "delay wait verzögerung warten", draw: (c) => done(path(c, `M 0 0 H ${r(c.w * 0.6)} A ${r(c.w * 0.4)} ${r(c.h / 2)} 0 0 1 ${r(c.w * 0.6)} ${r(c.h)} H 0 Z`), full(c, { w: c.w * 0.85 })) }),
  S({ id: "flow:display", set: "flow", w: 160, h: 80, outline: "rounded", keywords: "display screen anzeige bildschirm", draw: (c) => done(path(c, `M ${r(c.w * 0.16)} 0 H ${r(c.w * 0.82)} A ${r(c.w * 0.18)} ${r(c.h / 2)} 0 0 1 ${r(c.w * 0.82)} ${r(c.h)} H ${r(c.w * 0.16)} L 0 ${r(c.h / 2)} Z`), full(c, { x: c.w * 0.14, w: c.w * 0.7 })) }),
  S({ id: "flow:connector", set: "flow", w: 60, h: 60, outline: "ellipse", keywords: "connector on-page reference verbinder kreis", draw: (c) => done(ellipse(c, c.w / 2, c.h / 2, c.w / 2, c.h / 2), full(c, { pad: 4 })) }),
  S({ id: "flow:offpage", set: "flow", w: 80, h: 80, outline: "rectangle", keywords: "off-page connector reference seitenverbinder", draw: (c) => done(path(c, `M 0 0 H ${r(c.w)} V ${r(c.h * 0.6)} L ${r(c.w / 2)} ${r(c.h)} L 0 ${r(c.h * 0.6)} Z`), full(c, { h: c.h * 0.65, pad: 4 })) }),
  S({ id: "flow:storage", set: "flow", w: 140, h: 90, outline: "rectangle", keywords: "internal storage memory interner speicher", draw: (c) => { const e = Math.min(16, c.w * 0.12, c.h * 0.18); return done(rect(c, 0, 0, c.w, c.h) + line(c, `M ${r(e)} 0 V ${r(c.h)} M 0 ${r(e)} H ${r(c.w)}`), full(c, { x: e, y: e, w: c.w - e, h: c.h - e })); } }),
  S({ id: "flow:merge", set: "flow", w: 90, h: 70, outline: "triangle", keywords: "merge extract zusammenführen dreieck", draw: (c) => done(path(c, `M 0 0 H ${r(c.w)} L ${r(c.w / 2)} ${r(c.h)} Z`), full(c, { x: c.w * 0.2, w: c.w * 0.6, h: c.h * 0.6, pad: 2 })) }),
  S({ id: "flow:loop", set: "flow", w: 160, h: 70, outline: "hexagon", keywords: "loop limit schleife grenze", draw: (c) => done(path(c, `M ${r(c.w * 0.12)} 0 H ${r(c.w * 0.88)} L ${r(c.w)} ${r(c.h * 0.32)} V ${r(c.h)} H 0 V ${r(c.h * 0.32)} Z`), full(c)) }),
  S({ id: "flow:annotation", set: "flow", w: 160, h: 70, outline: "rectangle", keywords: "annotation comment note anmerkung kommentar", draw: (c) => done(`<rect width="${r(c.w)}" height="${r(c.h)}" fill="transparent"/>` + line(c, `M ${r(Math.min(18, c.w * 0.2))} 0 H 0 V ${r(c.h)} H ${r(Math.min(18, c.w * 0.2))}`), full(c, { align: "left", x: 6, w: c.w - 6 })) }),

  // BPMN
  S({ id: "bpmn:start", set: "bpmn", w: 48, h: 48, outline: "ellipse", keywords: "start event startereignis", fill: "#ebfbee", draw: (c) => done(circle(c, c.w / 2, c.h / 2, Math.min(c.w, c.h) / 2 - c.sw / 2), { x: -40, y: c.h + 2, w: c.w + 80, h: 40, text: c.text, valign: "top", pad: 2 }) }),
  S({ id: "bpmn:intermediate", set: "bpmn", w: 48, h: 48, outline: "ellipse", keywords: "intermediate event zwischenereignis", draw: (c) => { const R = Math.min(c.w, c.h) / 2 - c.sw / 2; return done(circle(c, c.w / 2, c.h / 2, R) + circle(c, c.w / 2, c.h / 2, R * 0.8, "none"), { x: -40, y: c.h + 2, w: c.w + 80, h: 40, text: c.text, valign: "top", pad: 2 }); } }),
  S({ id: "bpmn:end", set: "bpmn", w: 48, h: 48, outline: "ellipse", keywords: "end event endereignis", fill: "#fff5f5", draw: (c) => done(circle({ ...c, sw: c.sw * 2.2 }, c.w / 2, c.h / 2, Math.min(c.w, c.h) / 2 - c.sw * 1.1), { x: -40, y: c.h + 2, w: c.w + 80, h: 40, text: c.text, valign: "top", pad: 2 }) }),
  S({
    id: "bpmn:timer", set: "bpmn", w: 48, h: 48, outline: "ellipse", keywords: "timer event zeit zeitereignis uhr clock",
    draw: (c) => { const R = Math.min(c.w, c.h) / 2 - c.sw / 2, cx = c.w / 2, cy = c.h / 2; return done(circle(c, cx, cy, R) + circle(c, cx, cy, R * 0.8, "none") + circle(c, cx, cy, R * 0.6, "none") + line(c, `M ${r(cx)} ${r(cy - R * 0.45)} V ${r(cy)} L ${r(cx + R * 0.3)} ${r(cy + R * 0.15)}`, Math.max(1, c.sw * 0.75)), { x: -40, y: c.h + 2, w: c.w + 80, h: 40, text: c.text, valign: "top", pad: 2 }); },
  }),
  S({
    id: "bpmn:message", set: "bpmn", w: 48, h: 48, outline: "ellipse", keywords: "message event nachricht nachrichtenereignis mail",
    draw: (c) => { const R = Math.min(c.w, c.h) / 2 - c.sw / 2, cx = c.w / 2, cy = c.h / 2, ew = R * 0.9, eh = R * 0.62; return done(circle(c, cx, cy, R) + circle(c, cx, cy, R * 0.8, "none") + rect(c, cx - ew / 2, cy - eh / 2, ew, eh, 0, c.fill) + line(c, `M ${r(cx - ew / 2)} ${r(cy - eh / 2)} L ${r(cx)} ${r(cy + eh * 0.1)} L ${r(cx + ew / 2)} ${r(cy - eh / 2)}`, Math.max(1, c.sw * 0.75)), { x: -40, y: c.h + 2, w: c.w + 80, h: 40, text: c.text, valign: "top", pad: 2 }); },
  }),
  S({ id: "bpmn:task", set: "bpmn", w: 160, h: 80, outline: "rounded", keywords: "task activity aufgabe aktivität", draw: (c) => done(rect(c, 0, 0, c.w, c.h, Math.min(12, c.h / 4)), full(c)) }),
  S({
    id: "bpmn:subprocess", set: "bpmn", w: 160, h: 90, outline: "rounded", keywords: "subprocess collapsed teilprozess unterprozess",
    draw: (c) => { const m = Math.min(14, c.h * 0.2), x = c.w / 2 - m / 2, y = c.h - m - 4; return done(rect(c, 0, 0, c.w, c.h, Math.min(12, c.h / 4)) + rect(c, x, y, m, m, 0, c.fill) + line(c, `M ${r(x + m / 2)} ${r(y + 3)} V ${r(y + m - 3)} M ${r(x + 3)} ${r(y + m / 2)} H ${r(x + m - 3)}`, Math.max(1, c.sw * 0.75)), full(c, { h: c.h - m - 4 })); },
  }),
  S({
    id: "bpmn:user-task", set: "bpmn", w: 160, h: 80, outline: "rounded", keywords: "user task human benutzeraufgabe person",
    draw: (c) => done(rect(c, 0, 0, c.w, c.h, Math.min(12, c.h / 4)) + icon({ ...c }, { x: 6, y: 6, w: 20, h: 20 }, (k) => person(k, 24, 24, 20)), full(c, { x: 10, w: c.w - 20 })),
  }),
  S({
    id: "bpmn:service-task", set: "bpmn", w: 160, h: 80, outline: "rounded", keywords: "service task automatic dienst automatisch zahnrad gear",
    draw: (c) => done(rect(c, 0, 0, c.w, c.h, Math.min(12, c.h / 4)) + icon(c, { x: 6, y: 6, w: 20, h: 20 }, (k) => circle(k, 24, 24, 9, "none") + line(k, "M 24 6 V 12 M 24 36 V 42 M 6 24 H 12 M 36 24 H 42 M 11 11 L 15 15 M 33 33 L 37 37 M 37 11 L 33 15 M 15 33 L 11 37")), full(c, { x: 10, w: c.w - 20 })),
  }),
  S({ id: "bpmn:gateway-x", set: "bpmn", w: 60, h: 60, outline: "diamond", keywords: "exclusive gateway xor exklusives gateway entscheidung", fill: "#fff9db", draw: (c) => done(path(c, diamond(c.w, c.h)) + line(c, `M ${r(c.w * 0.36)} ${r(c.h * 0.36)} L ${r(c.w * 0.64)} ${r(c.h * 0.64)} M ${r(c.w * 0.64)} ${r(c.h * 0.36)} L ${r(c.w * 0.36)} ${r(c.h * 0.64)}`, c.sw * 1.5), { x: -50, y: c.h + 2, w: c.w + 100, h: 40, text: c.text, valign: "top", pad: 2 }) }),
  S({ id: "bpmn:gateway-plus", set: "bpmn", w: 60, h: 60, outline: "diamond", keywords: "parallel gateway and paralleles gateway", fill: "#fff9db", draw: (c) => done(path(c, diamond(c.w, c.h)) + line(c, `M ${r(c.w / 2)} ${r(c.h * 0.3)} V ${r(c.h * 0.7)} M ${r(c.w * 0.3)} ${r(c.h / 2)} H ${r(c.w * 0.7)}`, c.sw * 1.5), { x: -50, y: c.h + 2, w: c.w + 100, h: 40, text: c.text, valign: "top", pad: 2 }) }),
  S({ id: "bpmn:gateway-o", set: "bpmn", w: 60, h: 60, outline: "diamond", keywords: "inclusive gateway or inklusives gateway oder", fill: "#fff9db", draw: (c) => done(path(c, diamond(c.w, c.h)) + circle(c, c.w / 2, c.h / 2, Math.min(c.w, c.h) * 0.2, "none"), { x: -50, y: c.h + 2, w: c.w + 100, h: 40, text: c.text, valign: "top", pad: 2 }) }),
  S({ id: "bpmn:data-object", set: "bpmn", w: 50, h: 64, outline: "rectangle", keywords: "data object datenobjekt dokument", draw: (c) => done(path(c, folded(c.w, c.h, Math.min(14, c.w * 0.3))), { x: -40, y: c.h + 2, w: c.w + 80, h: 40, text: c.text, valign: "top", pad: 2 }) }),
  S({ id: "bpmn:data-store", set: "bpmn", w: 64, h: 60, outline: "rectangle", keywords: "data store datenspeicher datenbank", draw: (c) => done(cylinder(c, 0, 0, c.w, c.h), { x: -40, y: c.h + 2, w: c.w + 80, h: 40, text: c.text, valign: "top", pad: 2 }) }),
  S({
    id: "bpmn:pool", set: "bpmn", w: 720, h: 220, outline: "rectangle", container: true, keywords: "pool participant teilnehmer schwimmbahn",
    draw: (c) => { const band = Math.min(34, c.w * 0.2); return done(rect(c, 0, 0, c.w, c.h) + line(c, `M ${r(band)} 0 V ${r(c.h)}`), { x: 0, y: 0, w: band, h: c.h, text: c.text, vertical: true, bold: true, pad: 4 }); },
  }),
  S({
    id: "bpmn:lane", set: "bpmn", w: 686, h: 140, outline: "rectangle", container: true, keywords: "lane swimlane bahn schwimmbahn",
    draw: (c) => { const band = Math.min(30, c.w * 0.2); return done(rect(c, 0, 0, c.w, c.h, 0, c.fill) + rect(c, 0, 0, band, c.h, 0, c.muted), { x: 0, y: 0, w: band, h: c.h, text: c.text, vertical: true, pad: 4 }); },
  }),
  S({ id: "bpmn:group", set: "bpmn", w: 300, h: 200, outline: "rounded", container: true, fill: "transparent", keywords: "group gruppe", draw: (c) => done(rect({ ...c, dashed: true }, 0, 0, c.w, c.h, 12), full(c, { h: 32, align: "left", valign: "top", pad: 8 })) }),

  // UML
  S({ id: "uml:class", set: "uml", w: 200, h: 140, outline: "rectangle", fontSize: 14, keywords: "class klasse attributes methods", draw: (c) => classShape(c) }),
  S({ id: "uml:interface", set: "uml", w: 200, h: 120, outline: "rectangle", fontSize: 14, keywords: "interface schnittstelle", draw: (c) => classShape(c) }),
  S({ id: "uml:enum", set: "uml", w: 180, h: 120, outline: "rectangle", fontSize: 14, keywords: "enum enumeration aufzählung", draw: (c) => classShape(c) }),
  S({ id: "uml:actor", set: "uml", w: 60, h: 110, outline: "rectangle", fill: "transparent", keywords: "actor user akteur person", draw: (c) => { const label = c.preview ? 0 : Math.min(24, c.h * 0.24); return done(`<rect width="${r(c.w)}" height="${r(c.h)}" fill="transparent"/>` + stick({ ...c, fill: c.preview ? "transparent" : "#ffffff" }, c.w / 2, c.sw, c.h - label - c.sw * 2), { x: -40, y: c.h - label, w: c.w + 80, h: label + 14, text: c.text, valign: "top", pad: 0 }); } }),
  S({ id: "uml:usecase", set: "uml", w: 170, h: 80, outline: "ellipse", keywords: "use case anwendungsfall", draw: (c) => done(ellipse(c, c.w / 2, c.h / 2, c.w / 2, c.h / 2), full(c, { x: c.w * 0.12, w: c.w * 0.76 })) }),
  S({
    id: "uml:component", set: "uml", w: 180, h: 80, outline: "rectangle", keywords: "component komponente modul",
    draw: (c) => { const x = c.w - 26, y = 8; return done(rect(c, 0, 0, c.w, c.h) + rect(c, x, y, 16, 20, 0, c.fill) + rect(c, x - 5, y + 4, 10, 4, 0, c.fill) + rect(c, x - 5, y + 12, 10, 4, 0, c.fill), full(c, { w: c.w - 30, x: 4 })); },
  }),
  S({
    id: "uml:package", set: "uml", w: 280, h: 180, outline: "rectangle", container: true, keywords: "package paket namespace ordner",
    draw: (c) => { const tw = Math.min(c.w * 0.45, 140), th = Math.min(24, c.h * 0.2); return done(rect(c, 0, 0, tw, th) + rect(c, 0, th, c.w, c.h - th), { x: 0, y: th, w: c.w, h: 30, text: c.text, align: "left", valign: "top", bold: true, pad: 8 }); },
  }),
  S({ id: "uml:note", set: "uml", w: 170, h: 90, outline: "rectangle", fill: "#fff9db", keywords: "note comment notiz kommentar anmerkung", draw: (c) => done(path(c, folded(c.w, c.h, Math.min(16, c.w * 0.2, c.h * 0.3))), full(c, { align: "left", valign: "top", w: c.w - 12 })) }),
  S({
    id: "uml:lifeline", set: "uml", w: 140, h: 360, outline: "rectangle", keywords: "lifeline sequence participant lebenslinie sequenz teilnehmer",
    draw: (c) => { const head = Math.min(48, c.h * 0.3); return done(`<rect width="${r(c.w)}" height="${r(c.h)}" fill="transparent"/>` + line(c, `M ${r(c.w / 2)} ${r(head)} V ${r(c.h)}`, c.sw, ' stroke-dasharray="6 5"') + rect(c, 0, 0, c.w, head, 4), full(c, { h: head })); },
  }),
  S({
    id: "uml:lifeline-actor", set: "uml", w: 140, h: 360, outline: "rectangle", fill: "transparent", keywords: "actor lifeline sequence akteur lebenslinie",
    draw: (c) => { const fig = Math.min(64, c.h * 0.25), label = 22; return done(`<rect width="${r(c.w)}" height="${r(c.h)}" fill="transparent"/>` + stick({ ...c, fill: c.preview ? "transparent" : "#ffffff" }, c.w / 2, 2, fig - 4) + line(c, `M ${r(c.w / 2)} ${r(fig + label + 4)} V ${r(c.h)}`, c.sw, ' stroke-dasharray="6 5"'), { x: -20, y: fig, w: c.w + 40, h: label, text: c.text, pad: 0 }); },
  }),
  S({ id: "uml:activation", set: "uml", w: 16, h: 100, outline: "rectangle", keywords: "activation execution aktivierung ausführung", draw: (c) => done(rect(c, 0, 0, c.w, c.h)) }),
  S({ id: "uml:start", set: "uml", w: 36, h: 36, outline: "ellipse", keywords: "initial start node startknoten anfang", draw: (c) => done(circle(c, c.w / 2, c.h / 2, Math.min(c.w, c.h) / 2 - c.sw / 2, c.stroke)) }),
  S({ id: "uml:end", set: "uml", w: 36, h: 36, outline: "ellipse", keywords: "final end node endknoten ende", draw: (c) => { const R = Math.min(c.w, c.h) / 2 - c.sw / 2; return done(circle(c, c.w / 2, c.h / 2, R, c.preview ? "transparent" : "#ffffff") + circle(c, c.w / 2, c.h / 2, R * 0.62, c.stroke)); } }),
  S({ id: "uml:state", set: "uml", w: 160, h: 70, outline: "rounded", keywords: "state zustand activity aktivität", draw: (c) => done(rect(c, 0, 0, c.w, c.h, Math.min(16, c.h / 3)), full(c)) }),
  S({ id: "uml:merge", set: "uml", w: 40, h: 40, outline: "diamond", keywords: "merge decision choice verzweigung zusammenführung", draw: (c) => done(path(c, diamond(c.w, c.h)), { x: -40, y: c.h + 2, w: c.w + 80, h: 36, text: c.text, valign: "top", pad: 0 }) }),
  S({ id: "uml:fork", set: "uml", w: 160, h: 10, outline: "rectangle", keywords: "fork join bar gabelung vereinigung", draw: (c) => done(rect(c, 0, 0, c.w, c.h, 2, c.stroke)) }),
  S({
    id: "uml:node", set: "uml", w: 180, h: 110, outline: "rectangle", keywords: "node device server knoten gerät",
    draw: (c) => { const d = Math.min(14, c.w * 0.1, c.h * 0.15); return done(path(c, `M 0 ${r(d)} L ${r(d)} 0 H ${r(c.w)} V ${r(c.h - d)} L ${r(c.w - d)} ${r(c.h)} H 0 Z`) + line(c, `M 0 ${r(d)} H ${r(c.w - d)} L ${r(c.w)} 0 M ${r(c.w - d)} ${r(d)} V ${r(c.h)}`), full(c, { y: d, w: c.w - d, h: c.h - d })); },
  }),
  S({
    id: "uml:fragment", set: "uml", w: 400, h: 200, outline: "rectangle", container: true, fill: "transparent", keywords: "fragment loop alt opt combined kombiniertes fragment schleife",
    draw: (c) => {
      const label = lines(c.text)[0] || "";
      const tw = Math.min(c.w * 0.7, Math.max(48, label.length * c.size * 0.58 + 26)),
        th = Math.min(26, c.h * 0.3);
      return done(rect(c, 0, 0, c.w, c.h, 0, c.fill) + path(c, `M 0 0 H ${r(tw)} V ${r(th - 8)} L ${r(tw - 8)} ${r(th)} H 0 Z`, c.preview ? "transparent" : "#ffffff"), { x: 0, y: 0, w: tw - 6, h: th, text: label, align: "left", bold: true, pad: 6, size: c.size * 0.9 });
    },
  }),

  // ER diagrams
  S({
    id: "erd:entity", set: "erd", w: 200, h: 150, outline: "rectangle", fontSize: 14, keywords: "entity table tabelle entität attribute",
    draw: (c) => {
      const all = lines(c.text);
      const head = c.size * 1.45 + 12;
      const body = rows(c, head, all.slice(1), { separators: true, bold: (s) => /\bPK\b/.test(s) });
      return {
        markup: rect(c, 0, 0, c.w, c.h, 4) + rect(c, 0, 0, c.w, head, 4, c.muted) + line(c, `M 0 ${r(head)} H ${r(c.w)}`) + body.markup,
        texts: [{ x: 0, y: 0, w: c.w, h: head, text: all[0] || "", bold: true, pad: 4 }, ...body.texts],
      };
    },
  }),
  S({ id: "erd:weak-entity", set: "erd", w: 170, h: 70, outline: "rectangle", keywords: "weak entity schwache entität", draw: (c) => done(rect(c, 0, 0, c.w, c.h) + rect(c, 5, 5, c.w - 10, c.h - 10, 0, "none"), full(c)) }),
  S({ id: "erd:relationship", set: "erd", w: 150, h: 90, outline: "diamond", keywords: "relationship beziehung raute", draw: (c) => done(path(c, diamond(c.w, c.h)), full(c, { x: c.w * 0.18, y: c.h * 0.18, w: c.w * 0.64, h: c.h * 0.64, pad: 2 })) }),
  S({ id: "erd:attribute", set: "erd", w: 140, h: 64, outline: "ellipse", keywords: "attribute attribut eigenschaft", draw: (c) => done(ellipse(c, c.w / 2, c.h / 2, c.w / 2, c.h / 2), full(c, { x: c.w * 0.1, w: c.w * 0.8 })) }),
  S({ id: "erd:key-attribute", set: "erd", w: 140, h: 64, outline: "ellipse", keywords: "key attribute primary schlüsselattribut primärschlüssel", draw: (c) => done(ellipse(c, c.w / 2, c.h / 2, c.w / 2, c.h / 2), full(c, { x: c.w * 0.1, w: c.w * 0.8, underline: true })) }),
  S({ id: "erd:multivalued", set: "erd", w: 140, h: 64, outline: "ellipse", keywords: "multivalued attribute mehrwertiges attribut", draw: (c) => done(ellipse(c, c.w / 2, c.h / 2, c.w / 2, c.h / 2) + ellipse(c, c.w / 2, c.h / 2, c.w / 2 - 5, c.h / 2 - 5, "none"), full(c, { x: c.w * 0.12, w: c.w * 0.76 })) }),

  // Org chart
  S({
    id: "org:person", set: "org", w: 240, h: 84, outline: "rounded", keywords: "person employee card mitarbeiter karte rolle role",
    draw: (c) => {
      const R = Math.min(c.h * 0.34, 28),
        cx = 12 + R;
      const all = lines(c.text);
      return {
        markup: rect(c, 0, 0, c.w, c.h, 10) + circle(c, cx, c.h / 2, R, c.muted) + person({ ...c, sw: Math.max(1, c.sw * 0.75) }, cx, c.h / 2, R * 0.9),
        texts: [
          { x: cx + R + 6, y: 0, w: c.w - cx - R - 10, h: c.h / 2 + 2, text: all[0] || "", align: "left", valign: "bottom", bold: true, pad: 2 },
          { x: cx + R + 6, y: c.h / 2 + 2, w: c.w - cx - R - 10, h: c.h / 2 - 2, text: all.slice(1).join("\n"), align: "left", valign: "top", pad: 2, size: c.size * 0.88, color: "#868e96" },
        ],
      };
    },
  }),
  S({ id: "org:team", set: "org", w: 220, h: 80, outline: "rounded", keywords: "team department abteilung bereich", draw: (c) => done(rect(c, 0, 0, c.w, c.h, 10) + `<path d="M 0 10 Q 0 0 10 0 H ${r(c.w - 10)} Q ${r(c.w)} 0 ${r(c.w)} 10 V 8 H 0 Z" fill="${esc(c.stroke)}"/>`, full(c, { y: 8, h: c.h - 8, bold: true })) }),
  S({
    id: "org:vacancy", set: "org", w: 240, h: 84, outline: "rounded", keywords: "vacancy open position offene stelle",
    draw: (c) => { const R = Math.min(c.h * 0.34, 28), cx = 12 + R; return done(rect({ ...c, dashed: true }, 0, 0, c.w, c.h, 10) + circle({ ...c, dashed: true }, cx, c.h / 2, R, "none") + `<text x="${r(cx)}" y="${r(c.h / 2 + R * 0.35)}" text-anchor="middle" font-size="${r(R)}" font-family="system-ui,sans-serif" fill="${esc(c.stroke)}">?</text>`, { x: cx + R + 6, y: 0, w: c.w - cx - R - 10, h: c.h, text: c.text, align: "left", pad: 2 }); },
  }),

  // Network
  S({ id: "net:server", set: "net", w: 100, h: 110, outline: "rectangle", fill: "#ffffff", keywords: "server rack host", draw: (c) => iconWithLabel(c, (k) => rect(k, 9, 3, 30, 42, 3) + line(k, "M 9 17 H 39 M 9 31 H 39 M 22 10 H 33 M 22 24 H 33 M 22 38 H 33") + circle(k, 15, 10, 1.8, k.stroke) + circle(k, 15, 24, 1.8, k.stroke) + circle(k, 15, 38, 1.8, k.stroke)) }),
  S({ id: "net:database", set: "net", w: 100, h: 110, outline: "rectangle", keywords: "database datenbank sql", draw: (c) => iconWithLabel(c, (k) => cylinder(k, 9, 4, 30, 40) + line(k, "M 9 18 A 15 4.5 0 0 0 39 18 M 9 30 A 15 4.5 0 0 0 39 30")) }),
  S({ id: "net:cloud", set: "net", w: 110, h: 100, outline: "cloud", keywords: "cloud internet wolke", draw: (c) => iconWithLabel(c, (k) => path(k, "M 13 38 C 5 38 3 28 10 25 C 9 16 19 12 24 17 C 27 9 40 10 40 20 C 47 21 47 38 38 38 Z")) }),
  S({ id: "net:firewall", set: "net", w: 100, h: 110, outline: "rectangle", keywords: "firewall security sicherheit brandmauer", draw: (c) => iconWithLabel(c, (k) => rect(k, 5, 8, 38, 32, 2) + line(k, "M 5 16 H 43 M 5 24 H 43 M 5 32 H 43 M 18 8 V 16 M 30 8 V 16 M 12 16 V 24 M 24 16 V 24 M 36 16 V 24 M 18 24 V 32 M 30 24 V 32 M 12 32 V 40 M 24 32 V 40 M 36 32 V 40")) }),
  S({ id: "net:router", set: "net", w: 100, h: 110, outline: "ellipse", keywords: "router gateway", draw: (c) => iconWithLabel(c, (k) => circle(k, 24, 24, 19) + line(k, "M 12 24 H 36 M 16 20 L 12 24 L 16 28 M 32 20 L 36 24 L 32 28 M 24 12 V 36 M 20 16 L 24 12 L 28 16 M 20 32 L 24 36 L 28 32")) }),
  S({ id: "net:switch", set: "net", w: 100, h: 100, outline: "rectangle", keywords: "switch hub verteiler", draw: (c) => iconWithLabel(c, (k) => rect(k, 4, 13, 40, 22, 4) + line(k, "M 12 20 H 34 M 30 17 L 34 20 L 30 23 M 36 28 H 14 M 18 25 L 14 28 L 18 31")) }),
  S({ id: "net:laptop", set: "net", w: 100, h: 100, outline: "rectangle", keywords: "laptop notebook computer rechner", draw: (c) => iconWithLabel(c, (k) => rect(k, 9, 9, 30, 21, 2) + path(k, "M 4 33 H 44 L 41 38 H 7 Z")) }),
  S({ id: "net:desktop", set: "net", w: 100, h: 100, outline: "rectangle", keywords: "desktop pc computer workstation arbeitsplatz monitor", draw: (c) => iconWithLabel(c, (k) => rect(k, 6, 6, 36, 25, 2) + path(k, "M 20 31 L 18 39 H 30 L 28 31") + line(k, "M 14 41 H 34")) }),
  S({ id: "net:phone", set: "net", w: 100, h: 110, outline: "rectangle", keywords: "phone smartphone mobile handy telefon", draw: (c) => iconWithLabel(c, (k) => rect(k, 15, 4, 18, 40, 4) + line(k, "M 21 39 H 27")) }),
  S({ id: "net:tablet", set: "net", w: 100, h: 110, outline: "rectangle", keywords: "tablet ipad", draw: (c) => iconWithLabel(c, (k) => rect(k, 9, 5, 30, 38, 4) + circle(k, 24, 39, 1.4, k.stroke)) }),
  S({ id: "net:user", set: "net", w: 100, h: 100, outline: "ellipse", keywords: "user person client benutzer nutzer", draw: (c) => iconWithLabel(c, (k) => person(k, 24, 24, 20)) }),
  S({ id: "net:wifi", set: "net", w: 100, h: 100, outline: "rectangle", keywords: "wifi wlan access point wireless funk", draw: (c) => iconWithLabel(c, (k) => line(k, "M 8 20 C 17 11 31 11 40 20 M 13 26 C 19 20 29 20 35 26 M 18 32 C 21 29 27 29 30 32") + circle(k, 24, 37, 2.5, k.stroke)) }),
  S({ id: "net:printer", set: "net", w: 100, h: 100, outline: "rectangle", keywords: "printer drucker", draw: (c) => iconWithLabel(c, (k) => rect(k, 14, 6, 20, 12, 1) + rect(k, 6, 17, 36, 16, 3) + rect(k, 14, 28, 20, 14, 1)) }),
  S({ id: "net:globe", set: "net", w: 100, h: 100, outline: "ellipse", keywords: "internet globe web www welt", draw: (c) => iconWithLabel(c, (k) => circle(k, 24, 24, 19) + line(k, "M 5 24 H 43 M 24 5 C 14 14 14 34 24 43 M 24 5 C 34 14 34 34 24 43 M 9 14 H 39 M 9 34 H 39")) }),

  // Cloud (generic)
  S({ id: "cloud:compute", set: "cloud", w: 100, h: 110, outline: "rounded", fill: "#e7f5ff", stroke: "#1971c2", keywords: "compute virtual machine vm instance rechenleistung server", draw: (c) => iconWithLabel(c, (k) => rect(k, 14, 14, 20, 20, 2, "none") + rect(k, 19, 19, 10, 10, 1, "none") + line(k, "M 19 8 V 14 M 24 8 V 14 M 29 8 V 14 M 19 34 V 40 M 24 34 V 40 M 29 34 V 40 M 8 19 H 14 M 8 24 H 14 M 8 29 H 14 M 34 19 H 40 M 34 24 H 40 M 34 29 H 40"), true) }),
  S({ id: "cloud:storage", set: "cloud", w: 100, h: 110, outline: "rounded", fill: "#ebfbee", stroke: "#2f9e44", keywords: "object storage bucket blob speicher", draw: (c) => iconWithLabel(c, (k) => path(k, "M 11 15 L 15 38 C 17 41 31 41 33 38 L 37 15", "none") + ellipse(k, 24, 15, 13, 4.5, "none"), true) }),
  S({ id: "cloud:database", set: "cloud", w: 100, h: 110, outline: "rounded", fill: "#f3f0ff", stroke: "#7048e8", keywords: "managed database datenbank sql nosql", draw: (c) => iconWithLabel(c, (k) => cylinder({ ...k }, 12, 8, 24, 32, "none") + line(k, "M 12 19 A 12 3.6 0 0 0 36 19 M 12 29 A 12 3.6 0 0 0 36 29"), true) }),
  S({ id: "cloud:queue", set: "cloud", w: 100, h: 110, outline: "rounded", fill: "#fff4e6", stroke: "#e8590c", keywords: "queue message warteschlange nachrichten", draw: (c) => iconWithLabel(c, (k) => rect(k, 8, 16, 8, 16, 1, "none") + rect(k, 19, 16, 8, 16, 1, "none") + rect(k, 30, 16, 8, 16, 1, "none") + line(k, "M 4 38 H 42 M 38 35 L 42 38 L 38 41"), true) }),
  S({ id: "cloud:function", set: "cloud", w: 100, h: 110, outline: "rounded", fill: "#fff9db", stroke: "#e67700", keywords: "function serverless lambda funktion", draw: (c) => iconWithLabel(c, (k) => line(k, "M 15 10 C 21 10 22 12 24 18 L 33 38 M 24 23 L 15 38", k.sw * 1.4), true) }),
  S({ id: "cloud:cdn", set: "cloud", w: 100, h: 110, outline: "rounded", fill: "#e3fafc", stroke: "#0c8599", keywords: "cdn content delivery edge auslieferung", draw: (c) => iconWithLabel(c, (k) => circle(k, 24, 24, 11, "none") + line(k, "M 13 24 H 35 M 24 13 C 19 18 19 30 24 35 M 24 13 C 29 18 29 30 24 35 M 9 9 L 16 16 M 39 9 L 32 16 M 9 39 L 16 32 M 39 39 L 32 32") + circle(k, 8, 8, 2.5, k.stroke) + circle(k, 40, 8, 2.5, k.stroke) + circle(k, 8, 40, 2.5, k.stroke) + circle(k, 40, 40, 2.5, k.stroke), true) }),
  S({ id: "cloud:loadbalancer", set: "cloud", w: 100, h: 110, outline: "rounded", fill: "#e7f5ff", stroke: "#1864ab", keywords: "load balancer lastverteilung verteiler", draw: (c) => iconWithLabel(c, (k) => circle(k, 12, 24, 5, "none") + circle(k, 36, 11, 4, "none") + circle(k, 36, 24, 4, "none") + circle(k, 36, 37, 4, "none") + line(k, "M 17 24 H 32 M 16 21 L 32 12 M 16 27 L 32 36"), true) }),
  S({ id: "cloud:container", set: "cloud", w: 100, h: 110, outline: "rounded", fill: "#e6fcf5", stroke: "#087f5b", keywords: "container docker kubernetes pod", draw: (c) => iconWithLabel(c, (k) => path(k, "M 24 8 L 38 15 V 33 L 24 40 L 10 33 V 15 Z M 10 15 L 24 22 L 38 15 M 24 22 V 40", "none"), true) }),
  S({ id: "cloud:gateway", set: "cloud", w: 100, h: 110, outline: "rounded", fill: "#f8f0fc", stroke: "#9c36b5", keywords: "api gateway schnittstelle endpoint", draw: (c) => iconWithLabel(c, (k) => line(k, "M 17 14 L 9 24 L 17 34 M 31 14 L 39 24 L 31 34 M 21 36 L 27 12"), true) }),
  S({ id: "cloud:cache", set: "cloud", w: 100, h: 110, outline: "rounded", fill: "#fff5f5", stroke: "#c92a2a", keywords: "cache redis memory zwischenspeicher", draw: (c) => iconWithLabel(c, (k) => path(k, "M 27 6 L 14 26 H 24 L 21 42 L 35 20 H 25 Z", "none"), true) }),
  S({ id: "cloud:monitoring", set: "cloud", w: 100, h: 110, outline: "rounded", fill: "#f4fce3", stroke: "#5c940d", keywords: "monitoring metrics logs überwachung metriken", draw: (c) => iconWithLabel(c, (k) => line(k, "M 8 8 V 40 H 40 M 12 32 L 20 22 L 27 27 L 38 13"), true) }),
  S({ id: "cloud:secrets", set: "cloud", w: 100, h: 110, outline: "rounded", fill: "#fff9db", stroke: "#a87b00", keywords: "secrets key vault schlüssel geheimnisse", draw: (c) => iconWithLabel(c, (k) => circle(k, 17, 24, 7, "none") + line(k, "M 24 24 H 40 M 34 24 V 30 M 39 24 V 29"), true) }),
  S({ id: "cloud:network", set: "cloud", w: 100, h: 110, outline: "rounded", fill: "#edf2ff", stroke: "#3b5bdb", keywords: "virtual network vpc subnet netzwerk", draw: (c) => iconWithLabel(c, (k) => line(k, "M 24 12 L 12 34 H 36 Z") + circle(k, 24, 12, 4.5, "#ffffff") + circle(k, 12, 34, 4.5, "#ffffff") + circle(k, 36, 34, 4.5, "#ffffff"), true) }),
  S({ id: "cloud:events", set: "cloud", w: 100, h: 110, outline: "rounded", fill: "#fff0f6", stroke: "#c2255c", keywords: "events topic pub sub bus ereignisse", draw: (c) => iconWithLabel(c, (k) => circle(k, 24, 24, 4, k.stroke) + line(k, "M 15 15 C 10 20 10 28 15 33 M 33 15 C 38 20 38 28 33 33 M 10 10 C 2 18 2 30 10 38 M 38 10 C 46 18 46 30 38 38"), true) }),

  // Wireframes (low fidelity)
  S({
    id: "wf:browser", set: "wf", w: 640, h: 420, outline: "rectangle", container: true, stroke: "#495057", keywords: "browser window website fenster webseite",
    draw: (c) => { const bar = Math.min(34, c.h * 0.2); return done(rect(c, 0, 0, c.w, c.h, 8) + rect(c, 0, 0, c.w, bar, 8, c.muted) + line(c, `M 0 ${r(bar)} H ${r(c.w)}`) + circle(c, 14, bar / 2, 4, "none") + circle(c, 28, bar / 2, 4, "none") + circle(c, 42, bar / 2, 4, "none") + rect(c, 60, 7, Math.max(0, c.w - 72), Math.max(0, bar - 14), (bar - 14) / 2, c.preview ? "transparent" : "#ffffff"), { x: 66, y: 7, w: Math.max(0, c.w - 82), h: Math.max(0, bar - 14), text: c.text, align: "left", pad: 2, size: c.size * 0.85, color: "#868e96" }); },
  }),
  S({
    id: "wf:phone", set: "wf", w: 300, h: 600, outline: "rounded", container: true, stroke: "#495057", keywords: "phone mobile smartphone handy app",
    draw: (c) => { const rr = Math.min(36, c.w * 0.14); return done(rect(c, 0, 0, c.w, c.h, rr) + rect(c, 10, 34, c.w - 20, c.h - 62, 4, "none") + rect(c, c.w / 2 - 34, 12, 68, 12, 6, c.stroke) + rect(c, c.w / 2 - 40, c.h - 18, 80, 5, 2.5, c.stroke), { x: 10, y: 34, w: c.w - 20, h: 34, text: c.text, bold: true, pad: 6 }); },
  }),
  S({ id: "wf:tablet", set: "wf", w: 560, h: 420, outline: "rounded", container: true, stroke: "#495057", keywords: "tablet ipad", draw: (c) => done(rect(c, 0, 0, c.w, c.h, 22) + rect(c, 16, 16, c.w - 32, c.h - 32, 4, "none"), { x: 16, y: 16, w: c.w - 32, h: 34, text: c.text, bold: true, pad: 6 }) }),
  S({
    id: "wf:modal", set: "wf", w: 360, h: 220, outline: "rectangle", container: true, stroke: "#495057", keywords: "modal dialog popup fenster",
    draw: (c) => { const bar = Math.min(40, c.h * 0.3); return done(rect(c, 0, 0, c.w, c.h, 8) + line(c, `M 0 ${r(bar)} H ${r(c.w)} M ${r(c.w - 26)} ${r(bar / 2 - 6)} l 12 12 M ${r(c.w - 14)} ${r(bar / 2 - 6)} l -12 12`), { x: 0, y: 0, w: c.w - 34, h: bar, text: c.text, align: "left", bold: true, pad: 12 }); },
  }),
  S({ id: "wf:button", set: "wf", w: 120, h: 40, outline: "rounded", fill: "#e9ecef", stroke: "#495057", keywords: "button schaltfläche knopf", draw: (c) => done(rect(c, 0, 0, c.w, c.h, 8), full(c, { pad: 4 })) }),
  S({ id: "wf:button-primary", set: "wf", w: 120, h: 40, outline: "rounded", fill: "#495057", stroke: "#495057", textColor: "#ffffff", keywords: "primary button hauptschaltfläche", draw: (c) => done(rect(c, 0, 0, c.w, c.h, 8), full(c, { pad: 4, bold: true })) }),
  S({ id: "wf:input", set: "wf", w: 240, h: 40, outline: "rectangle", stroke: "#868e96", textColor: "#868e96", keywords: "input text field eingabefeld textfeld", draw: (c) => done(rect(c, 0, 0, c.w, c.h, 6), full(c, { align: "left", pad: 10 })) }),
  S({ id: "wf:search", set: "wf", w: 240, h: 40, outline: "rounded", stroke: "#868e96", textColor: "#868e96", keywords: "search suche suchfeld", draw: (c) => done(rect(c, 0, 0, c.w, c.h, c.h / 2) + circle(c, 18, c.h / 2 - 2, 6, "none") + line(c, `M 22 ${r(c.h / 2 + 2)} L 27 ${r(c.h / 2 + 7)}`), { x: 32, y: 0, w: c.w - 40, h: c.h, text: c.text, align: "left", pad: 2 }) }),
  S({ id: "wf:textarea", set: "wf", w: 260, h: 110, outline: "rectangle", stroke: "#868e96", textColor: "#868e96", keywords: "textarea multiline text area mehrzeilig", draw: (c) => done(rect(c, 0, 0, c.w, c.h, 6) + line(c, `M ${r(c.w - 12)} ${r(c.h - 4)} L ${r(c.w - 4)} ${r(c.h - 12)}`, 1), full(c, { align: "left", valign: "top", pad: 10 })) }),
  S({ id: "wf:checkbox", set: "wf", w: 180, h: 28, outline: "rectangle", fill: "transparent", stroke: "#495057", keywords: "checkbox check kontrollkästchen häkchen", draw: (c) => wfInline(c, `<rect width="${r(c.w)}" height="${r(c.h)}" fill="transparent"/>` + rect(c, 2, c.h / 2 - 8, 16, 16, 3, c.preview ? "transparent" : "#ffffff") + line(c, `M 6 ${r(c.h / 2)} L 9 ${r(c.h / 2 + 4)} L 15 ${r(c.h / 2 - 4)}`), 26) }),
  S({ id: "wf:radio", set: "wf", w: 180, h: 28, outline: "rectangle", fill: "transparent", stroke: "#495057", keywords: "radio option auswahl", draw: (c) => wfInline(c, `<rect width="${r(c.w)}" height="${r(c.h)}" fill="transparent"/>` + circle(c, 10, c.h / 2, 8, c.preview ? "transparent" : "#ffffff") + circle(c, 10, c.h / 2, 3.5, c.stroke), 26) }),
  S({ id: "wf:toggle", set: "wf", w: 190, h: 28, outline: "rectangle", fill: "transparent", stroke: "#495057", keywords: "toggle switch schalter umschalter", draw: (c) => wfInline(c, `<rect width="${r(c.w)}" height="${r(c.h)}" fill="transparent"/>` + rect(c, 2, c.h / 2 - 10, 38, 20, 10, c.stroke) + circle(c, 30, c.h / 2, 7, "#ffffff"), 48) }),
  S({ id: "wf:dropdown", set: "wf", w: 220, h: 40, outline: "rectangle", stroke: "#868e96", keywords: "dropdown select auswahlliste menü", draw: (c) => done(rect(c, 0, 0, c.w, c.h, 6) + line(c, `M ${r(c.w - 24)} ${r(c.h / 2 - 3)} L ${r(c.w - 18)} ${r(c.h / 2 + 3)} L ${r(c.w - 12)} ${r(c.h / 2 - 3)}`), { x: 0, y: 0, w: c.w - 30, h: c.h, text: c.text, align: "left", pad: 10 }) }),
  S({
    id: "wf:tabs", set: "wf", w: 360, h: 40, outline: "rectangle", fill: "transparent", stroke: "#495057", keywords: "tabs reiter registerkarten",
    draw: (c) => {
      const list = entries(c.text);
      const n = Math.max(1, c.preview ? 3 : list.length);
      const tw = c.w / n;
      let markup = `<rect width="${r(c.w)}" height="${r(c.h)}" fill="transparent"/>` + line(c, `M 0 ${r(c.h)} H ${r(c.w)}`, Math.max(1, c.sw / 2));
      markup += line(c, `M 4 ${r(c.h - 1)} H ${r(tw - 4)}`, c.sw * 1.6);
      return { markup, texts: list.map((text, i) => ({ x: i * tw, y: 0, w: tw, h: c.h, text, bold: i === 0, pad: 2 })) };
    },
  }),
  S({
    id: "wf:navbar", set: "wf", w: 600, h: 48, outline: "rectangle", stroke: "#495057", keywords: "navigation bar navbar header menü kopfzeile",
    draw: (c) => {
      const list = entries(c.text);
      const markup = rect(c, 0, 0, c.w, c.h, 0, c.muted) + rect(c, 12, c.h / 2 - 9, 18, 18, 4, c.stroke);
      const rest = list.slice(1);
      const slot = rest.length ? Math.min(110, (c.w * 0.6) / rest.length) : 0;
      return {
        markup,
        texts: [
          { x: 36, y: 0, w: c.w * 0.35, h: c.h, text: list[0] || "", align: "left" as const, bold: true, pad: 2 },
          ...rest.map((text, i) => ({ x: c.w - (rest.length - i) * slot - 8, y: 0, w: slot, h: c.h, text, pad: 2 })),
        ],
      };
    },
  }),
  S({
    id: "wf:card", set: "wf", w: 240, h: 260, outline: "rounded", stroke: "#868e96", keywords: "card karte teaser",
    draw: (c) => {
      const img = c.h * 0.48;
      const all = lines(c.text);
      return {
        markup: rect(c, 0, 0, c.w, c.h, 10) + `<path d="M 10 0 H ${r(c.w - 10)} Q ${r(c.w)} 0 ${r(c.w)} 10 V ${r(img)} H 0 V 10 Q 0 0 10 0 Z" fill="${esc(c.muted)}" stroke="none"/>` + line(c, `M ${r(c.w * 0.3)} ${r(img * 0.75)} L ${r(c.w * 0.45)} ${r(img * 0.45)} L ${r(c.w * 0.58)} ${r(img * 0.65)} L ${r(c.w * 0.66)} ${r(img * 0.55)} L ${r(c.w * 0.76)} ${r(img * 0.75)} Z`, 1.5) + line(c, `M 0 ${r(img)} H ${r(c.w)}`, 1),
        texts: [
          { x: 0, y: img + 6, w: c.w, h: 30, text: all[0] || "", align: "left", bold: true, pad: 10 },
          { x: 0, y: img + 34, w: c.w, h: Math.max(0, c.h - img - 40), text: all.slice(1).join("\n"), align: "left", valign: "top", pad: 10, size: c.size * 0.9, color: "#868e96" },
        ],
      };
    },
  }),
  S({
    id: "wf:list", set: "wf", w: 260, h: 160, outline: "rectangle", stroke: "#868e96", keywords: "list liste einträge items",
    draw: (c) => {
      const items = c.preview ? ["", "", ""] : lines(c.text);
      const lh = c.size * 1.45 + 6;
      let markup = rect(c, 0, 0, c.w, c.h, 6);
      items.forEach((_, i) => {
        const y = i * lh;
        if (y + lh > c.h + 1) return;
        if (i) markup += line(c, `M 0 ${r(y)} H ${r(c.w)}`, 1);
        markup += circle(c, 14, y + lh / 2, 3, c.stroke);
      });
      return { markup, texts: rows(c, 0, items, { x: 20 }).texts };
    },
  }),
  S({ id: "wf:image", set: "wf", w: 200, h: 140, outline: "rectangle", fill: "#f1f3f5", stroke: "#868e96", keywords: "image picture placeholder bild platzhalter foto", draw: (c) => done(rect(c, 0, 0, c.w, c.h, 4) + line(c, `M 0 0 L ${r(c.w)} ${r(c.h)} M ${r(c.w)} 0 L 0 ${r(c.h)}`, 1)) }),
  S({ id: "wf:avatar", set: "wf", w: 56, h: 56, outline: "ellipse", fill: "#f1f3f5", stroke: "#868e96", keywords: "avatar profile profil person", draw: (c) => { const R = Math.min(c.w, c.h) / 2; return done(circle(c, c.w / 2, c.h / 2, R - c.sw / 2) + person({ ...c, sw: Math.max(1, c.sw * 0.8) }, c.w / 2, c.h / 2 + R * 0.08, R * 0.8)); } }),
  S({ id: "wf:icon", set: "wf", w: 40, h: 40, outline: "rounded", fill: "transparent", stroke: "#868e96", keywords: "icon symbol placeholder platzhalter", draw: (c) => { const s = Math.min(c.w, c.h); return done(rect({ ...c, dashed: true }, 1, 1, c.w - 2, c.h - 2, s * 0.2) + circle(c, c.w / 2, c.h / 2, s * 0.2, "none") + line(c, `M ${r(c.w / 2)} ${r(c.h / 2 - s * 0.32)} V ${r(c.h / 2 - s * 0.2)} M ${r(c.w / 2)} ${r(c.h / 2 + s * 0.2)} V ${r(c.h / 2 + s * 0.32)}`, 1)); } }),
  S({
    id: "wf:text-block", set: "wf", w: 260, h: 90, outline: "rectangle", fill: "transparent", stroke: "#ced4da", keywords: "text paragraph lorem absatz textblock",
    draw: (c) => {
      if (c.text.trim()) return done(`<rect width="${r(c.w)}" height="${r(c.h)}" fill="transparent"/>`, full(c, { align: "left", valign: "top", pad: 2, color: "#495057" }));
      let markup = `<rect width="${r(c.w)}" height="${r(c.h)}" fill="transparent"/>`;
      for (let y = 4, i = 0; y + 10 <= c.h; y += 18, i++) markup += rect({ ...c, sw: 0 }, 0, y, c.w * (i % 3 === 2 ? 0.6 : 1), 10, 5, "#dee2e6");
      return done(markup);
    },
  }),
  S({ id: "wf:heading", set: "wf", w: 300, h: 44, outline: "rectangle", fill: "transparent", stroke: "#495057", fontSize: 26, keywords: "heading title überschrift titel", draw: (c) => done(`<rect width="${r(c.w)}" height="${r(c.h)}" fill="transparent"/>`, full(c, { align: "left", bold: true, pad: 2 })) }),
  S({ id: "wf:slider", set: "wf", w: 220, h: 28, outline: "rectangle", fill: "transparent", stroke: "#495057", keywords: "slider range regler schieberegler", draw: (c) => done(`<rect width="${r(c.w)}" height="${r(c.h)}" fill="transparent"/>` + line(c, `M 8 ${r(c.h / 2)} H ${r(c.w - 8)}`, 2) + line(c, `M 8 ${r(c.h / 2)} H ${r(c.w * 0.45)}`, 4) + circle(c, c.w * 0.45, c.h / 2, 8, "#ffffff")) }),
  S({ id: "wf:progress", set: "wf", w: 220, h: 16, outline: "rounded", fill: "#e9ecef", stroke: "#868e96", keywords: "progress bar fortschritt ladebalken", draw: (c) => done(rect(c, 0, 0, c.w, c.h, c.h / 2) + rect({ ...c, sw: 0 }, 0, 0, c.w * 0.6, c.h, c.h / 2, c.stroke)) }),
];

// i18n-table: 1 – [German, English] names of the library shapes
const shapeNames: Record<string, [string, string]> = {
  "flow:process": ["Prozess", "Process"],
  "flow:decision": ["Entscheidung", "Decision"],
  "flow:terminator": ["Start/Ende", "Start/end"],
  "flow:data": ["Daten (Ein-/Ausgabe)", "Data (input/output)"],
  "flow:document": ["Dokument", "Document"],
  "flow:multidoc": ["Mehrere Dokumente", "Multiple documents"],
  "flow:predefined": ["Vordefinierter Prozess", "Predefined process"],
  "flow:manual-input": ["Manuelle Eingabe", "Manual input"],
  "flow:manual-op": ["Manuelle Operation", "Manual operation"],
  "flow:database": ["Datenbank", "Database"],
  "flow:preparation": ["Vorbereitung", "Preparation"],
  "flow:delay": ["Verzögerung", "Delay"],
  "flow:display": ["Anzeige", "Display"],
  "flow:connector": ["Verbindungsstelle", "Connector||flowchart"],
  "flow:offpage": ["Seitenverbinder", "Off-page connector"],
  "flow:storage": ["Interner Speicher", "Internal storage"],
  "flow:merge": ["Zusammenführung", "Merge"],
  "flow:loop": ["Schleifengrenze", "Loop limit"],
  "flow:annotation": ["Anmerkung", "Annotation"],
  "bpmn:start": ["Startereignis", "Start event"],
  "bpmn:intermediate": ["Zwischenereignis", "Intermediate event"],
  "bpmn:end": ["Endereignis", "End event"],
  "bpmn:timer": ["Zeitereignis", "Timer event"],
  "bpmn:message": ["Nachrichtenereignis", "Message event"],
  "bpmn:task": ["Aufgabe", "Task"],
  "bpmn:subprocess": ["Teilprozess", "Subprocess"],
  "bpmn:user-task": ["Benutzeraufgabe", "User task"],
  "bpmn:service-task": ["Serviceaufgabe", "Service task"],
  "bpmn:gateway-x": ["Exklusives Gateway", "Exclusive gateway"],
  "bpmn:gateway-plus": ["Paralleles Gateway", "Parallel gateway"],
  "bpmn:gateway-o": ["Inklusives Gateway", "Inclusive gateway"],
  "bpmn:data-object": ["Datenobjekt", "Data object"],
  "bpmn:data-store": ["Datenspeicher", "Data store"],
  "bpmn:pool": ["Pool", "Pool"],
  "bpmn:lane": ["Lane", "Lane"],
  "bpmn:group": ["Gruppe", "Group"],
  "uml:class": ["Klasse", "Class"],
  "uml:interface": ["Schnittstelle", "Interface"],
  "uml:enum": ["Aufzählung", "Enumeration"],
  "uml:actor": ["Akteur", "Actor"],
  "uml:usecase": ["Anwendungsfall", "Use case"],
  "uml:component": ["Komponente", "Component"],
  "uml:package": ["Paket", "Package"],
  "uml:note": ["Notiz", "Note"],
  "uml:lifeline": ["Lebenslinie", "Lifeline"],
  "uml:lifeline-actor": ["Lebenslinie (Akteur)", "Lifeline (actor)"],
  "uml:activation": ["Aktivierung", "Activation"],
  "uml:start": ["Startknoten", "Initial node"],
  "uml:end": ["Endknoten", "Final node"],
  "uml:state": ["Zustand", "State"],
  "uml:merge": ["Verzweigung", "Decision node"],
  "uml:fork": ["Gabelung", "Fork"],
  "uml:node": ["Knoten", "Node"],
  "uml:fragment": ["Kombiniertes Fragment", "Combined fragment"],
  "erd:entity": ["Entität", "Entity"],
  "erd:weak-entity": ["Schwache Entität", "Weak entity"],
  "erd:relationship": ["Beziehung", "Relationship"],
  "erd:attribute": ["Attribut", "Attribute"],
  "erd:key-attribute": ["Schlüsselattribut", "Key attribute"],
  "erd:multivalued": ["Mehrwertiges Attribut", "Multivalued attribute"],
  "org:person": ["Person", "Person"],
  "org:team": ["Team", "Team"],
  "org:vacancy": ["Offene Stelle", "Open position"],
  "net:server": ["Server", "Server"],
  "net:database": ["Datenbankserver", "Database server"],
  "net:cloud": ["Internet (Wolke)", "Internet (cloud)"],
  "net:firewall": ["Firewall", "Firewall"],
  "net:router": ["Router", "Router"],
  "net:switch": ["Switch", "Switch||network"],
  "net:laptop": ["Laptop", "Laptop"],
  "net:desktop": ["Arbeitsplatz", "Workstation"],
  "net:phone": ["Smartphone", "Smartphone"],
  "net:tablet": ["Tablet", "Tablet"],
  "net:user": ["Benutzer", "User"],
  "net:wifi": ["WLAN-Zugangspunkt", "Wi-Fi access point"],
  "net:printer": ["Drucker", "Printer"],
  "net:globe": ["Web", "Web"],
  "cloud:compute": ["Rechenleistung", "Compute"],
  "cloud:storage": ["Objektspeicher", "Object storage"],
  "cloud:database": ["Verwaltete Datenbank", "Managed database"],
  "cloud:queue": ["Warteschlange", "Queue"],
  "cloud:function": ["Funktion", "Function"],
  "cloud:cdn": ["CDN", "CDN"],
  "cloud:loadbalancer": ["Lastverteiler", "Load balancer"],
  "cloud:container": ["Container", "Container"],
  "cloud:gateway": ["API-Gateway", "API gateway"],
  "cloud:cache": ["Cache", "Cache"],
  "cloud:monitoring": ["Überwachung", "Monitoring"],
  "cloud:secrets": ["Geheimnisse", "Secrets"],
  "cloud:network": ["Virtuelles Netzwerk", "Virtual network"],
  "cloud:events": ["Ereignisse", "Events"],
  "wf:browser": ["Browserfenster", "Browser window"],
  "wf:phone": ["Smartphone-Rahmen", "Phone frame"],
  "wf:tablet": ["Tablet-Rahmen", "Tablet frame"],
  "wf:modal": ["Dialog", "Dialog"],
  "wf:button": ["Schaltfläche", "Button"],
  "wf:button-primary": ["Hauptschaltfläche", "Primary button"],
  "wf:input": ["Eingabefeld", "Input field"],
  "wf:search": ["Suchfeld", "Search field"],
  "wf:textarea": ["Mehrzeiliges Feld", "Text area"],
  "wf:checkbox": ["Kontrollkästchen", "Checkbox"],
  "wf:radio": ["Optionsfeld", "Radio button"],
  "wf:toggle": ["Schalter", "Toggle"],
  "wf:dropdown": ["Auswahlliste", "Dropdown"],
  "wf:tabs": ["Reiter", "Tabs"],
  "wf:navbar": ["Navigationsleiste", "Navigation bar"],
  "wf:card": ["Karte", "Card"],
  "wf:list": ["Liste", "List"],
  "wf:image": ["Bildplatzhalter", "Image placeholder"],
  "wf:avatar": ["Avatar", "Avatar"],
  "wf:icon": ["Symbolplatzhalter", "Icon placeholder"],
  "wf:text-block": ["Textblock", "Text block"],
  "wf:heading": ["Überschrift", "Heading"],
  "wf:slider": ["Schieberegler", "Slider"],
  "wf:progress": ["Fortschrittsbalken", "Progress bar"],
};
// i18n-table: 1 – [German, English] texts new shapes start with
const shapeTexts: Record<string, [string, string]> = {
  "flow:process": ["Prozess", "Process"],
  "flow:decision": ["Entscheidung?", "Decision?"],
  "flow:terminator": ["Start", "Start"],
  "flow:data": ["Daten", "Data"],
  "flow:document": ["Dokument", "Document"],
  "flow:multidoc": ["Dokumente", "Documents"],
  "flow:predefined": ["Unterprozess", "Subprocess"],
  "flow:manual-input": ["Eingabe", "Input"],
  "flow:manual-op": ["Manueller Schritt", "Manual step"],
  "flow:database": ["Datenbank", "Database"],
  "flow:preparation": ["Vorbereitung", "Preparation"],
  "flow:delay": ["Warten", "Wait"],
  "flow:display": ["Anzeige", "Display"],
  "flow:connector": ["A", "A"],
  "flow:offpage": ["1", "1"],
  "bpmn:task": ["Aufgabe", "Task"],
  "bpmn:subprocess": ["Teilprozess", "Subprocess"],
  "bpmn:user-task": ["Prüfen", "Review"],
  "bpmn:service-task": ["Senden", "Send"],
  "bpmn:pool": ["Organisation", "Organisation"],
  "bpmn:lane": ["Rolle", "Role"],
  "bpmn:group": ["Gruppe", "Group"],
  "uml:class": ["Kunde\n--\n- name: String\n- email: String\n--\n+ bestellen(): Bestellung", "Customer\n--\n- name: String\n- email: String\n--\n+ order(): Order"],
  "uml:interface": ["«interface»\nZahlbar\n--\n+ bezahlen(betrag: Zahl)", "«interface»\nPayable\n--\n+ pay(amount: Number)"],
  "uml:enum": ["«enumeration»\nStatus\n--\nOFFEN\nERLEDIGT", "«enumeration»\nStatus\n--\nOPEN\nDONE"],
  "uml:actor": ["Akteur", "Actor"],
  "uml:usecase": ["Anwendungsfall", "Use case"],
  "uml:component": ["Komponente", "Component"],
  "uml:package": ["Paket", "Package"],
  "uml:note": ["Notiz", "Note"],
  "uml:lifeline": ["Teilnehmer", "Participant"],
  "uml:lifeline-actor": ["Akteur", "Actor"],
  "uml:state": ["Zustand", "State"],
  "uml:node": ["«device»\nServer", "«device»\nServer"],
  "uml:fragment": ["loop", "loop"],
  "erd:entity": ["Kunde\nid PK\nname\nemail\nadresse_id FK", "Customer\nid PK\nname\nemail\naddress_id FK"],
  "erd:weak-entity": ["Position", "Line item"],
  "erd:relationship": ["hat", "has"],
  "erd:attribute": ["Attribut", "Attribute"],
  "erd:key-attribute": ["ID", "ID"],
  "erd:multivalued": ["Telefon", "Phone"],
  "org:person": ["Vorname Nachname\nRolle", "First Last\nRole"],
  "org:team": ["Team", "Team"],
  "org:vacancy": ["Offene Stelle", "Open position"],
  "net:server": ["Server", "Server"],
  "net:database": ["Datenbank", "Database"],
  "net:cloud": ["Internet", "Internet"],
  "net:firewall": ["Firewall", "Firewall"],
  "net:router": ["Router", "Router"],
  "net:switch": ["Switch", "Switch||network"],
  "net:laptop": ["Laptop", "Laptop"],
  "net:desktop": ["Arbeitsplatz", "Workstation"],
  "net:phone": ["Smartphone", "Smartphone"],
  "net:tablet": ["Tablet", "Tablet"],
  "net:user": ["Benutzer", "User"],
  "net:wifi": ["WLAN", "Wi-Fi"],
  "net:printer": ["Drucker", "Printer"],
  "net:globe": ["Web", "Web"],
  "cloud:compute": ["Rechenleistung", "Compute"],
  "cloud:storage": ["Speicher", "Storage"],
  "cloud:database": ["Datenbank", "Database"],
  "cloud:queue": ["Warteschlange", "Queue"],
  "cloud:function": ["Funktion", "Function"],
  "cloud:cdn": ["CDN", "CDN"],
  "cloud:loadbalancer": ["Lastverteiler", "Load balancer"],
  "cloud:container": ["Container", "Container"],
  "cloud:gateway": ["API-Gateway", "API gateway"],
  "cloud:cache": ["Cache", "Cache"],
  "cloud:monitoring": ["Überwachung", "Monitoring"],
  "cloud:secrets": ["Geheimnisse", "Secrets"],
  "cloud:network": ["Netzwerk", "Network"],
  "cloud:events": ["Ereignisse", "Events"],
  "wf:browser": ["https://beispiel.de", "https://example.com"],
  "wf:phone": ["App", "App"],
  "wf:modal": ["Titel", "Title"],
  "wf:button": ["Schaltfläche", "Button"],
  "wf:button-primary": ["Speichern", "Save"],
  "wf:input": ["E-Mail-Adresse", "Email address"],
  "wf:search": ["Suchen …", "Search …"],
  "wf:textarea": ["Nachricht …", "Message …"],
  "wf:checkbox": ["Angemeldet bleiben", "Remember me"],
  "wf:radio": ["Option", "Option"],
  "wf:toggle": ["Benachrichtigungen", "Notifications"],
  "wf:dropdown": ["Auswählen", "Choose"],
  "wf:tabs": ["Übersicht | Details | Verlauf", "Overview | Details | History"],
  "wf:navbar": ["Logo | Start | Produkte | Kontakt", "Logo | Home | Products | Contact"],
  "wf:card": ["Titel\nKurze Beschreibung", "Title\nShort description"],
  "wf:list": ["Erster Eintrag\nZweiter Eintrag\nDritter Eintrag", "First item\nSecond item\nThird item"],
  "wf:heading": ["Überschrift", "Heading"],
};

const byId = new Map(shapes.map((s) => [s.id, s]));
export type LibraryShapeInfo = {
  id: string;
  set: LibrarySetId;
  name: [string, string];
  keywords: string;
  w: number;
  h: number;
  container: boolean;
};
export const libraryShapes: LibraryShapeInfo[] = shapes.map((s) => ({
  id: s.id,
  set: s.set,
  name: shapeNames[s.id] || [s.id, s.id],
  keywords: s.keywords,
  w: s.w,
  h: s.h,
  container: !!s.container,
}));
export const isLibraryShape = (id: unknown): id is string => typeof id === "string" && byId.has(id);
export const isContainerShape = (id: unknown) => typeof id === "string" && !!byId.get(id)?.container;

// The drawing of a library shape item; null when the id is unknown (the
// item is then drawn as its plain outline).
export function drawLibraryShape(item: Pick<WhiteboardItem, "lib" | "w" | "h" | "fill" | "stroke" | "strokeWidth" | "text" | "fontSize" | "textColor" | "dashed">, preview = false, previewStroke = 1.6): LibraryDrawing | null {
  const def = item.lib ? byId.get(item.lib) : undefined;
  if (!def) return null;
  const finite = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
  const c: Ctx = {
    w: Math.max(1, finite(item.w, def.w)),
    h: Math.max(1, finite(item.h, def.h)),
    fill: preview ? "transparent" : safeColor(item.fill, def.fill || "#ffffff"),
    stroke: preview ? "currentColor" : safeColor(item.stroke, def.stroke || "#1f2937"),
    sw: preview ? previewStroke : Math.max(0.5, Math.min(12, finite(item.strokeWidth, 2))),
    text: preview ? "" : String(item.text ?? ""),
    size: Math.max(6, Math.min(96, finite(item.fontSize, def.fontSize || 14))),
    textColor: safeColor(item.textColor, def.textColor || "#1f2937"),
    dashed: !!item.dashed,
    muted: preview ? "transparent" : "#f1f3f5",
    preview,
  };
  const drawn = def.draw(c);
  const result = typeof drawn === "string" ? { markup: drawn, texts: [] } : drawn;
  return {
    // A transparent box first: the whole shape can be grabbed.
    markup: `<rect width="${r(c.w)}" height="${r(c.h)}" fill="transparent" stroke="none"/>` + result.markup,
    texts: preview ? [] : result.texts.filter((t) => t.text).map((t) => ({ size: c.size, color: c.textColor, ...t })),
  };
}

// A new library shape as a draft (local id "n"), in the given language.
export function libraryDraft(id: string, t: (de: string, en: string) => string) {
  const def = byId.get(id);
  if (!def) return null;
  const text = shapeTexts[id];
  return {
    id: "n",
    type: "shape" as const,
    shape: def.outline,
    lib: id,
    x: 0,
    y: 0,
    w: def.w,
    h: def.h,
    text: text ? t(text[0], text[1]) : "",
    fill: def.fill || "#ffffff",
    stroke: def.stroke || "#1f2937",
    strokeWidth: 2,
    ...(def.textColor ? { textColor: def.textColor } : {}),
    fontSize: def.fontSize || 14,
  };
}
// Library shapes whose names or keywords contain every word of the query.
export function searchLibrary(query: string, t: (de: string, en: string) => string, set?: LibrarySetId | null) {
  const fold = (s: string) => s.toLocaleLowerCase("de").normalize("NFD").replace(/[̀-ͯ]/g, "");
  const words = fold(query).split(/\s+/).filter(Boolean);
  return libraryShapes.filter((s) => {
    if (set && s.set !== set) return false;
    if (!words.length) return true;
    const names = librarySetNames[s.set];
    const hay = fold([s.name[0], s.name[1], t(s.name[0], s.name[1]), s.keywords, names[0], names[1], t(names[0], names[1])].join(" "));
    return words.every((w) => hay.includes(w));
  });
}

// Styles of a text area: React style keys; `cssText` writes them for SVG.
export function textAreaStyle(area: TextArea, base: { size: number; color: string; bold?: boolean }) {
  const valign = area.valign || "middle";
  return {
    width: "100%",
    height: "100%",
    display: "flex",
    flexDirection: "column" as const,
    justifyContent: valign === "top" ? "flex-start" : valign === "bottom" ? "flex-end" : "center",
    overflow: "hidden",
    whiteSpace: "pre-wrap" as const,
    wordBreak: "break-word" as const,
    lineHeight: 1.3,
    boxSizing: "border-box" as const,
    fontFamily: "system-ui,-apple-system,'Segoe UI',sans-serif",
    padding: `${area.pad ?? 6}px`,
    fontSize: `${area.size ?? base.size}px`,
    fontWeight: (area.bold ?? base.bold) ? 700 : 400,
    fontStyle: area.italic ? "italic" : "normal",
    textDecoration: area.underline ? "underline" : "none",
    textAlign: area.align || "center",
    color: safeColor(area.color, base.color),
  };
}
export function cssText(style: Record<string, string | number>) {
  return Object.entries(style)
    .map(([key, value]) => `${key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}:${value}`)
    .join(";");
}
// The whole drawing as SVG markup (export), texts as foreignObject.
export function libraryShapeSvg(item: Parameters<typeof drawLibraryShape>[0] & { bold?: boolean }): string | null {
  const drawing = drawLibraryShape(item);
  if (!drawing) return null;
  const texts = drawing.texts
    .map((area) => {
      const style = cssText(textAreaStyle(area, { size: 14, color: "#1f2937", bold: item.bold }));
      const box = area.vertical
        ? `x="0" y="0" width="${r(Math.max(1, area.h))}" height="${r(Math.max(1, area.w))}" transform="translate(${r(area.x)} ${r(area.y + area.h)}) rotate(-90)"`
        : `x="${r(area.x)}" y="${r(area.y)}" width="${r(Math.max(1, area.w))}" height="${r(Math.max(1, area.h))}"`;
      return `<foreignObject ${box}><div xmlns="http://www.w3.org/1999/xhtml" style="${esc(style)}">${area.text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</div></foreignObject>`;
    })
    .join("");
  return drawing.markup + texts;
}
