// Image occlusion (docs/specs/flashcards.md §5.5): masks over a picture in
// a record's document. The picture keeps them as `data-occlusion` – JSON
// `{ v: 1, mode, masks: [{ id, shape, x, y, w, h, points?, group?, label? }] }`
// with positions as proportions of the picture (0–1), so they stay right at
// any size and the picture itself is never rewritten. Each mask, or each
// group of masks, is one card: sub `o:<mask id>` or `g:<group id>` – the
// ids are stable, so the learning state survives moving, resizing and
// relabelling, and a new mask is a new card.
// - mode "hide-all": every mask covers its part, the one asked is
//   highlighted ("Alle verdecken, eine abfragen", Anki's default);
//   "hide-one": only the one asked is covered ("Eine verdecken, Rest
//   sichtbar").
// - Anki's Image Occlusion notes (≥ 23.10) keep their masks in the field
//   "Occlusion" as {{c1::image-occlusion:rect:left=.2:top=.3:width=.1:height=.05:oi=1}}
//   (also ellipse with rx/ry and polygon with points); read and written
//   here for the import and the export.
// Client-safe and pure (tests/study-occlusion.test.ts).
import { Parser } from "htmlparser2";

export const OCCLUSION_MODES = ["hide-all", "hide-one"] as const;
export type OcclusionMode = (typeof OCCLUSION_MODES)[number];
export const OCCLUSION_SHAPES = ["rect", "ellipse", "polygon"] as const;
export type OcclusionShape = (typeof OCCLUSION_SHAPES)[number];
export type OcclusionPoint = [number, number];
export type OcclusionMask = {
  id: string;
  shape: OcclusionShape;
  // The bounding box (of a polygon: of its points).
  x: number;
  y: number;
  w: number;
  h: number;
  points?: OcclusionPoint[];
  group?: string;
  label?: string;
};
export type Occlusion = { v: 1; mode: OcclusionMode; masks: OcclusionMask[] };

export const MAX_MASKS = 100;
export const MAX_POINTS = 64;
export const MAX_LABEL = 200;
// The smallest side of a mask (a click is no mask).
export const MIN_SIZE = 0.005;
// Ids: a UUID or shorter (the card key "o:<id>" stays within 40 characters).
const ID = /^[A-Za-z0-9-]{1,36}$/;

const round = (n: number) => Math.round(n * 10_000) / 10_000;
const unit = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? round(Math.min(1, Math.max(0, n))) : null);
const cleanLabel = (value: unknown) =>
  typeof value === "string"
    ? value
        .replace(/[\u0000-\u001f\u007f]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, MAX_LABEL)
    : "";

// A polygon's bounding box.
export function boundsOf(points: OcclusionPoint[]) {
  const xs = points.map((p) => p[0]),
    ys = points.map((p) => p[1]);
  const x = Math.min(...xs),
    y = Math.min(...ys);
  return { x: round(x), y: round(y), w: round(Math.max(...xs) - x), h: round(Math.max(...ys) - y) };
}

// One mask as stored, or null when it is not one (anything unexpected is
// dropped, positions are kept within the picture).
export function cleanMask(raw: unknown): OcclusionMask | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.id !== "string" || !ID.test(m.id)) return null;
  const shape = OCCLUSION_SHAPES.find((s) => s === m.shape);
  if (!shape) return null;
  const group = typeof m.group === "string" && ID.test(m.group) ? m.group : undefined;
  const label = cleanLabel(m.label);
  const extra = { ...(group ? { group } : {}), ...(label ? { label } : {}) };
  if (shape === "polygon") {
    if (!Array.isArray(m.points)) return null;
    const points = m.points
      .slice(0, MAX_POINTS)
      .map((p) => (Array.isArray(p) ? [unit(p[0]), unit(p[1])] : [null, null]))
      .filter((p): p is OcclusionPoint => p[0] !== null && p[1] !== null);
    if (points.length < 3) return null;
    const box = boundsOf(points);
    if (box.w < MIN_SIZE || box.h < MIN_SIZE) return null;
    return { id: m.id, shape, ...box, points, ...extra };
  }
  const x = unit(m.x),
    y = unit(m.y);
  if (x === null || y === null) return null;
  const w = unit(Math.min(Number(m.w), 1 - x)),
    h = unit(Math.min(Number(m.h), 1 - y));
  if (w === null || h === null || w < MIN_SIZE || h < MIN_SIZE) return null;
  return { id: m.id, shape, x, y, w, h, ...extra };
}

// The stored attribute (JSON text or an object) as masks; null when there
// is no mask.
export function parseOcclusion(raw: unknown): Occlusion | null {
  let value = raw;
  if (typeof value === "string") {
    if (!value.trim() || value.length > 200_000) return null;
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object" || !Array.isArray((value as { masks?: unknown }).masks)) return null;
  const v = value as { mode?: unknown; masks: unknown[] };
  const seen = new Set<string>();
  const masks: OcclusionMask[] = [];
  for (const raw of v.masks.slice(0, MAX_MASKS)) {
    const mask = cleanMask(raw);
    if (!mask || seen.has(mask.id)) continue;
    seen.add(mask.id);
    masks.push(mask);
  }
  if (!masks.length) return null;
  return { v: 1, mode: OCCLUSION_MODES.find((m) => m === v.mode) ?? "hide-all", masks };
}
// The attribute as stored: cleaned, or null (the attribute goes).
export function occlusionAttribute(raw: unknown): string | null {
  const parsed = parseOcclusion(raw);
  return parsed ? JSON.stringify(parsed) : null;
}

// The card of a mask: its group's, else its own.
export const maskKey = (mask: Pick<OcclusionMask, "id" | "group">) => (mask.group ? `g:${mask.group}` : `o:${mask.id}`);
export type OcclusionTarget = { key: string; masks: string[]; labels: string[] };
// The cards of one picture in the order of their first mask.
export function occlusionTargets(occlusion: Occlusion): OcclusionTarget[] {
  const out = new Map<string, OcclusionTarget>();
  for (const mask of occlusion.masks) {
    const key = maskKey(mask);
    const target = out.get(key) || { key, masks: [], labels: [] };
    target.masks.push(mask.id);
    if (mask.label && !target.labels.includes(mask.label)) target.labels.push(mask.label);
    out.set(key, target);
  }
  return [...out.values()];
}

// ---- in documents ----

export type OccludedImage = { src: string; alt: string; occlusion: Occlusion };
// The pictures of a document that carry masks, in document order.
export function occludedImages(html: string): OccludedImage[] {
  if (!html || !html.includes("data-occlusion")) return [];
  const out: OccludedImage[] = [];
  const parser = new Parser(
    {
      onopentag(name, attributes) {
        if (name !== "img" || !attributes["data-occlusion"] || !attributes.src) return;
        const occlusion = parseOcclusion(attributes["data-occlusion"]);
        if (occlusion) out.push({ src: attributes.src, alt: attributes.alt || "", occlusion });
      },
    },
    { decodeEntities: true },
  );
  parser.write(html);
  parser.end();
  return out;
}
// The document without its pictures with masks (and their figures with
// caption): what stays is the text around them – shown above the picture
// (the front) or after revealing (the back).
export function withoutOccludedImages(html: string): string {
  if (!html || !html.includes("data-occlusion")) return html || "";
  const cuts: { start: number; end: number }[] = [];
  const figures: { start: number; occluded: boolean }[] = [];
  const parser = new Parser(
    {
      onopentag(name, attributes) {
        if (name === "figure") figures.push({ start: parser.startIndex, occluded: false });
        else if (name === "img" && attributes["data-occlusion"] && parseOcclusion(attributes["data-occlusion"])) {
          const figure = figures.at(-1);
          if (figure) figure.occluded = true;
          else cuts.push({ start: parser.startIndex, end: parser.endIndex + 1 });
        }
      },
      onclosetag(name) {
        if (name !== "figure") return;
        const figure = figures.pop();
        if (figure?.occluded) cuts.push({ start: figure.start, end: parser.endIndex + 1 });
      },
    },
    { decodeEntities: true, recognizeSelfClosing: true },
  );
  parser.write(html);
  parser.end();
  let out = html;
  for (const cut of cuts.sort((a, b) => b.start - a.start)) {
    // A line break right after the picture goes with it.
    const rest = out.slice(cut.end).replace(/^\s*<br\s*\/?>/i, "");
    out = out.slice(0, cut.start) + rest;
  }
  // Paragraphs left empty by the picture go too.
  return out.replace(/<p>\s*<\/p>/g, "").trim();
}

// ---- Anki ----

type AnkiShape = { n: number; shape: OcclusionShape | "text" | string; props: Record<string, string> };
// The shapes of Anki's "Occlusion" field: {{cN::image-occlusion:<shape>:key=value:…}}
// (a colon in a value is escaped as "\:").
export function ankiShapes(field: string): AnkiShape[] {
  const out: AnkiShape[] = [];
  const text = field.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
  for (const m of text.matchAll(/\{\{c(\d{1,3})::image-occlusion:([\s\S]*?)\}\}/g)) {
    const parts = m[2].split(/(?<!\\):/).map((p) => p.replace(/\\:/g, ":").trim());
    const shape = parts.shift() || "";
    const props: Record<string, string> = {};
    for (const part of parts) {
      const at = part.indexOf("=");
      if (at > 0) props[part.slice(0, at).trim()] = part.slice(at + 1).trim();
    }
    out.push({ n: Number(m[1]), shape, props });
  }
  return out;
}
export type AnkiOcclusion = { occlusion: Occlusion | null; numbers: Map<number, string>; skipped: number; pixels: boolean };
// Anki's masks as Flowplan's: one mask per shape, the shapes of one cloze
// number a group (one card, as in Anki), "oi=1" (occlude inactive) on any
// shape makes the picture "hide-all". Anki before 23.12 stored pixels:
// with the picture's `size` they become proportions, without it they are
// skipped (`pixels`). Text shapes and unknown ones are skipped. `numbers`:
// each cloze number's card key (for the learning state).
export function fromAnkiOcclusion(field: string, newId: () => string, size?: { width: number; height: number } | null): AnkiOcclusion {
  const shapes = ankiShapes(field);
  const numbers = new Map<number, string>();
  const num = (value: string | undefined) => (value === undefined || value === "" ? NaN : Number(value));
  const absolute = shapes.some((s) =>
    Object.entries(s.props).some(([k, v]) => ["left", "top", "width", "height", "rx", "ry"].includes(k) && num(v) > 1.0001) ||
    (s.props.points || "").split(/\s+/).some((p) => p.split(",").some((c) => num(c) > 1.0001)),
  );
  const sx = absolute ? (size?.width ?? 0) : 1,
    sy = absolute ? (size?.height ?? 0) : 1;
  if (absolute && !(sx > 0 && sy > 0)) return { occlusion: null, numbers, skipped: shapes.length, pixels: true };
  const byNumber = new Map<number, AnkiShape[]>();
  let skipped = 0;
  for (const s of shapes) {
    if (s.shape !== "rect" && s.shape !== "ellipse" && s.shape !== "polygon") {
      skipped++;
      continue;
    }
    byNumber.set(s.n, [...(byNumber.get(s.n) || []), s]);
  }
  const masks: OcclusionMask[] = [];
  let hideAll = false;
  for (const [n, list] of [...byNumber].sort((a, b) => a[0] - b[0])) {
    const group = list.length > 1 ? newId() : undefined;
    let first: OcclusionMask | null = null;
    for (const s of list) {
      if (s.props.oi === "1") hideAll = true;
      const left = num(s.props.left) / sx,
        top = num(s.props.top) / sy;
      const raw =
        s.shape === "polygon"
          ? {
              id: newId(),
              shape: "polygon",
              points: (s.props.points || "")
                .split(/\s+/)
                .filter(Boolean)
                .map((p) => p.split(",").map(Number))
                .map(([x, y]) => [x / sx, y / sy]),
            }
          : s.shape === "ellipse"
            ? { id: newId(), shape: "ellipse", x: left, y: top, w: (2 * num(s.props.rx)) / sx, h: (2 * num(s.props.ry)) / sy }
            : { id: newId(), shape: "rect", x: left, y: top, w: num(s.props.width) / sx, h: num(s.props.height) / sy };
      const mask = cleanMask({ ...raw, ...(group ? { group } : {}) });
      if (!mask) {
        skipped++;
        continue;
      }
      first ??= mask;
      masks.push(mask);
    }
    if (first) numbers.set(n, maskKey(first));
  }
  // A group of which only one mask is left is that mask's own card.
  const groups = new Map<string, number>();
  for (const m of masks) if (m.group) groups.set(m.group, (groups.get(m.group) || 0) + 1);
  for (const m of masks)
    if (m.group && groups.get(m.group) === 1) {
      const key = maskKey(m);
      delete m.group;
      for (const [n, k] of numbers) if (k === key) numbers.set(n, maskKey(m));
    }
  const limited = masks.slice(0, MAX_MASKS);
  return { occlusion: limited.length ? { v: 1, mode: hideAll ? "hide-all" : "hide-one", masks: limited } : null, numbers, skipped: skipped + masks.length - limited.length, pixels: absolute };
}
// Anki's number format: no leading zero, at most four decimals.
const ankiNumber = (n: number) => String(round(n)).replace(/^0\./, ".");
// The masks as Anki's "Occlusion" field: one cloze number per card (in the
// order of occlusionTargets), "oi=1" for "hide-all".
export function toAnkiOcclusion(occlusion: Occlusion): string {
  const oi = occlusion.mode === "hide-all" ? ":oi=1" : "";
  const byId = new Map(occlusion.masks.map((m) => [m.id, m]));
  return occlusionTargets(occlusion)
    .map((target, i) =>
      target.masks
        .map((id) => {
          const m = byId.get(id)!;
          const body =
            m.shape === "polygon"
              ? `polygon:points=${(m.points || []).map(([x, y]) => `${ankiNumber(x)},${ankiNumber(y)}`).join(" ")}`
              : m.shape === "ellipse"
                ? `ellipse:left=${ankiNumber(m.x)}:top=${ankiNumber(m.y)}:rx=${ankiNumber(m.w / 2)}:ry=${ankiNumber(m.h / 2)}`
                : `rect:left=${ankiNumber(m.x)}:top=${ankiNumber(m.y)}:width=${ankiNumber(m.w)}:height=${ankiNumber(m.h)}`;
          return `{{c${i + 1}::image-occlusion:${body}${oi}}}`;
        })
        .join("<br>"),
    )
    .join("<br>");
}
