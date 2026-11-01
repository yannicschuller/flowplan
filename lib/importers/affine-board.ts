// The edgeless (whiteboard) side of an AFFiNE document as Flowplan
// whiteboard items. Where things are in AFFiNE (verified against the
// BlockSuite model sources, blocksuite/affine/model/src/elements and
// …/blocks):
// - root block "affine:page" → children "affine:surface" and "affine:note"
//   blocks. Notes carry "xywh" ("[x,y,w,h]"), "background" and
//   "displayMode" ("both", "doc", "edgeless"; older "doc-only" /
//   "edgeless-only"); the first note shown in the document is its text.
// - "affine:surface" → property "elements" (boxed map id → element) and
//   blocks on the canvas as its children ("affine:frame", "affine:image",
//   "affine:edgeless-text", embeds, bookmarks, attachments).
// - elements: shape {shapeType rect|ellipse|diamond|triangle, radius,
//   filled, fillColor, strokeColor, strokeWidth, strokeStyle, text,
//   fontSize, rotate}, connector {source/target {id?, position?}, mode 0
//   straight / 1 orthogonal / 2 curve, front/rearEndpointStyle, stroke,
//   text}, text {text, color, fontSize, textAlign}, brush/highlighter
//   {points [[x, y, pressure?]] relative to xywh, color, lineWidth}, group
//   {children: id → true, title}, mindmap {children: node id → {index,
//   parent?}} whose nodes are shape elements.
// Colours are hex strings, palette variables ("--affine-palette-shape-
// yellow") or {normal} / {light, dark}. Everything else is dropped and
// counted; the document itself appears as a card linking to it.
import { BOARD_IMPORT_LIMITS, IMPORT_IMAGE_PREFIX, imageSignature, importText, normalise, type BoardDraft, type ImportedBoard, type ImportedImage } from "../whiteboard-import";
import type { ShapeKind } from "../whiteboard-model";
import { ct } from "../content-locale";
import { AText, type ABlob, type ABlock } from "./affine-read";

export type BoardContext = {
  blobs: Map<string, ABlob>;
  // The placeholder of an imported page (lib/importers/html.ts pageRef) or
  // null when the document is not part of the import.
  pageRef: (docId: string) => string | null;
  docTitle: (docId: string) => string;
  // Plain text of a block and its children (notes, edgeless text).
  plainText: (blocks: ABlock[]) => string;
};

const PALETTE: Record<string, string> = {
  yellow: "#ffe838",
  orange: "#ffaf38",
  tangerine: "#ff8c38",
  red: "#fc3f55",
  magenta: "#ff38b3",
  pink: "#ff38b3",
  purple: "#b638ff",
  navy: "#3b25cc",
  blue: "#4f90ff",
  green: "#10cb86",
  teal: "#2cc4b8",
  grey: "#929292",
  gray: "#929292",
  white: "#ffffff",
  black: "#000000",
};
export function affineColor(value: unknown): string | undefined {
  if (value && typeof value === "object") {
    const v = value as { normal?: unknown; light?: unknown };
    return affineColor(v.normal ?? v.light);
  }
  if (typeof value !== "string") return undefined;
  const v = value.trim().toLowerCase();
  if (v === "transparent" || v.endsWith("-transparent")) return "transparent";
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  if (/^#[0-9a-f]{3}$/.test(v)) return `#${[...v.slice(1)].map((c) => c + c).join("")}`;
  if (/^#[0-9a-f]{8}$/.test(v)) return v.slice(0, 7);
  // "--affine-palette-shape-yellow", "var(--affine-note-background-blue)"
  const name = Object.keys(PALETTE).find((key) => new RegExp(`(^|[-(])${key}([-)]|$)`).test(v));
  return name ? (v.includes("light") && name !== "white" ? lighten(PALETTE[name]) : PALETTE[name]) : undefined;
}
const lighten = (hex: string) =>
  `#${[1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * 0.4 + 255 * 0.6).toString(16).padStart(2, "0")).join("")}`;

const LIMIT = BOARD_IMPORT_LIMITS.coordinate;
const finite = (value: unknown, fallback = 0) =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(-LIMIT, Math.min(LIMIT, value)) : fallback;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
type Box = { x: number; y: number; w: number; h: number };
export function parseXywh(value: unknown): Box | null {
  let parts: unknown = value;
  if (typeof value === "string") {
    if (value.length > 200) return null;
    try {
      parts = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(parts) || parts.length < 4 || !parts.slice(0, 4).every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  const [x, y, w, h] = parts as number[];
  return { x: finite(x), y: finite(y), w: clamp(Math.abs(w), 0, LIMIT), h: clamp(Math.abs(h), 0, LIMIT) };
}
const textOf = (value: unknown) => importText(value instanceof AText ? value.plain : typeof value === "string" ? value : "");
const order = (value: unknown) => (typeof value === "string" ? value : "");
const safeLink = (url: unknown) => (typeof url === "string" && /^https?:\/\/[^\s]+$/i.test(url) && url.length < 2000 ? url : undefined);

export function noteDisplay(note: ABlock) {
  const mode = String(note.props.displayMode ?? "");
  if (note.props.hidden === true || mode === "edgeless" || mode === "edgeless-only") return "edgeless";
  if (mode === "doc" || mode === "doc-only") return "doc";
  return "both";
}

// What the canvas holds beyond the note with the document's text.
export function edgelessExtras(root: ABlock) {
  const notes = root.children.filter((b) => b.flavour === "affine:note");
  const main = notes.find((n) => noteDisplay(n) !== "edgeless");
  const surface = root.children.find((b) => b.flavour === "affine:surface");
  const elements = surface?.props.elements && typeof surface.props.elements === "object" ? Object.keys(surface.props.elements as object).length : 0;
  const onCanvas = notes.filter((n) => n !== main && noteDisplay(n) !== "doc").length;
  return elements + (surface?.children.length || 0) + onCanvas;
}

export function affineBoard(docId: string, root: ABlock, ctx: BoardContext): ImportedBoard {
  const drafts: (BoardDraft & { order: string })[] = [];
  const images: ImportedImage[] = [];
  const imageIds = new Map<string, string>();
  let imageBytes = 0,
    replaced = 0;
  const boxes = new Map<string, Box>();
  const addImage = (key: unknown) => {
    if (typeof key !== "string") return null;
    if (imageIds.has(key)) return imageIds.get(key)!;
    const blob = ctx.blobs.get(key);
    if (!blob) return null;
    const mime = ["image/png", "image/jpeg", "image/gif", "image/webp"].find((m) => imageSignature(m, blob.head));
    if (!mime || blob.size > BOARD_IMPORT_LIMITS.imageBytes) return null;
    if (images.length >= BOARD_IMPORT_LIMITS.images || imageBytes + blob.size > BOARD_IMPORT_LIMITS.imagesTotal) return null;
    const id = `img${images.length + 1}`;
    images.push({ id, mime, data: new Uint8Array(blob.read()) });
    imageBytes += blob.size;
    imageIds.set(key, IMPORT_IMAGE_PREFIX + id);
    return IMPORT_IMAGE_PREFIX + id;
  };
  const sticky = (id: string, box: Box, text: string, fill = "#e9ecef", sort = "", link?: string) =>
    drafts.push({
      id,
      type: "sticky",
      x: box.x,
      y: box.y,
      w: clamp(box.w || 200, 80, 800),
      h: clamp(box.h || 140, 60, 800),
      text: text || "?",
      fill,
      fontSize: 14,
      order: sort,
      ...(link ? { link } : {}),
    });
  const card = (id: string, box: Box, pageId: string, sort: string) =>
    drafts.push({ id, type: "card", x: box.x, y: box.y, w: clamp(box.w || 280, 200, 800), h: clamp(box.h || 120, 100, 160), pageId, fill: "#e0782c", order: sort });

  // Notes: the document's own note links to the document.
  const notes = root.children.filter((b) => b.flavour === "affine:note");
  const main = notes.find((n) => noteDisplay(n) !== "edgeless");
  const self = ctx.pageRef(docId);
  let cardPlaced = false;
  for (const note of notes) {
    if (noteDisplay(note) === "doc" && note !== main) continue;
    const box = parseXywh(note.props.xywh) || { x: 0, y: 0, w: 450, h: 200 };
    boxes.set(note.id, box);
    if (note === main && self) {
      card(note.id, box, self, order(note.props.index));
      cardPlaced = true;
    } else sticky(note.id, box, importText(ctx.plainText(note.children)) || " ", affineColor(note.props.background) || "#fff6b6", order(note.props.index));
  }

  const surface = root.children.find((b) => b.flavour === "affine:surface");
  // Blocks on the canvas.
  for (const block of surface?.children || []) {
    const box = parseXywh(block.props.xywh);
    if (!box) {
      replaced++;
      continue;
    }
    boxes.set(block.id, box);
    const sort = order(block.props.index);
    switch (block.flavour) {
      case "affine:frame":
        drafts.push({ id: block.id, type: "frame", x: box.x, y: box.y, w: Math.max(40, box.w), h: Math.max(40, box.h), text: textOf(block.props.title) || ct("Rahmen", "Frame"), fill: affineColor(block.props.background) === "transparent" ? "#ffffff" : affineColor(block.props.background) || "#ffffff", order: sort });
        break;
      case "affine:image": {
        const src = addImage(block.props.sourceId);
        if (src) drafts.push({ id: block.id, type: "image", x: box.x, y: box.y, w: Math.max(4, box.w), h: Math.max(4, box.h), src, order: sort, ...(finite(block.props.rotate) ? { rotation: finite(block.props.rotate) } : {}) });
        else {
          replaced++;
          sticky(block.id, box, ct("Bild (nicht übernommen)", "Image (not imported)"), "#e9ecef", sort);
        }
        break;
      }
      case "affine:edgeless-text":
        drafts.push({ id: block.id, type: "text", x: box.x, y: box.y, w: Math.max(20, box.w), h: Math.max(16, box.h), text: importText(ctx.plainText(block.children)) || " ", fontSize: 20, textColor: affineColor(block.props.color), align: "left", order: sort });
        break;
      case "affine:embed-linked-doc":
      case "affine:embed-synced-doc": {
        const target = typeof block.props.pageId === "string" ? ctx.pageRef(block.props.pageId) : null;
        if (target) card(block.id, box, target, sort);
        else {
          replaced++;
          sticky(block.id, box, typeof block.props.pageId === "string" ? ctx.docTitle(block.props.pageId) : "?", "#e9ecef", sort);
        }
        break;
      }
      case "affine:attachment":
        sticky(block.id, box, importText(block.props.name) || ct("Anhang", "Attachment"), "#e9ecef", sort);
        break;
      case "affine:note":
        sticky(block.id, box, importText(ctx.plainText(block.children)) || " ", affineColor(block.props.background) || "#fff6b6", sort);
        break;
      default: {
        const url = safeLink(block.props.url);
        if (url) sticky(block.id, box, importText(block.props.title) || url, "#e9ecef", sort, url);
        else replaced++;
      }
    }
  }

  // Elements of the surface.
  const elements = Object.values((surface?.props.elements as Record<string, Record<string, unknown>>) || {})
    .filter((e) => e && typeof e === "object" && typeof e.id === "string")
    .slice(0, BOARD_IMPORT_LIMITS.elements);
  const groups = new Map<string, string>(); // child → group
  const connectors: Record<string, unknown>[] = [];
  const mindmapLinks: [string, string][] = [];
  for (const e of elements) {
    const id = e.id as string;
    const box = parseXywh(e.xywh);
    const sort = order(e.index);
    const rotation = finite(e.rotate);
    switch (e.type) {
      case "shape": {
        if (!box) {
          replaced++;
          break;
        }
        boxes.set(id, box);
        const kind: ShapeKind =
          e.shapeType === "ellipse" ? "ellipse" : e.shapeType === "diamond" ? "diamond" : e.shapeType === "triangle" ? "triangle" : finite(e.radius) > 0 ? "rounded" : "rectangle";
        drafts.push({
          id,
          type: "shape",
          shape: kind,
          x: box.x,
          y: box.y,
          w: Math.max(1, box.w),
          h: Math.max(1, box.h),
          ...(rotation ? { rotation } : {}),
          fill: e.filled === false ? "transparent" : affineColor(e.fillColor) || "transparent",
          stroke: affineColor(e.strokeColor) || "#1e1e1e",
          strokeWidth: clamp(finite(e.strokeWidth, 2), 1, 20),
          ...(e.strokeStyle === "dash" ? { dashed: true } : {}),
          text: textOf(e.text),
          fontSize: clamp(finite(e.fontSize, 20), 6, 200),
          ...(affineColor(e.color) ? { textColor: affineColor(e.color) } : {}),
          order: sort,
        });
        break;
      }
      case "text": {
        if (!box) {
          replaced++;
          break;
        }
        boxes.set(id, box);
        drafts.push({
          id,
          type: "text",
          x: box.x,
          y: box.y,
          w: Math.max(20, box.w),
          h: Math.max(16, box.h),
          ...(rotation ? { rotation } : {}),
          text: textOf(e.text) || " ",
          fontSize: clamp(finite(e.fontSize, 20), 6, 200),
          textColor: affineColor(e.color),
          align: (["left", "center", "right"].includes(e.textAlign as string) ? e.textAlign : "left") as BoardDraft["align"],
          order: sort,
        });
        break;
      }
      case "brush":
      case "highlighter": {
        const raw = (Array.isArray(e.points) ? e.points : []).filter(
          (p): p is number[] => Array.isArray(p) && typeof p[0] === "number" && typeof p[1] === "number",
        );
        if (!box || raw.length < 2) {
          replaced++;
          break;
        }
        const step = Math.ceil(raw.length / BOARD_IMPORT_LIMITS.points);
        const pts = raw.filter((_, k) => k % step === 0 || k === raw.length - 1).map((p) => ({ x: finite(p[0]), y: finite(p[1]) }));
        const minX = Math.min(...pts.map((p) => p.x)),
          minY = Math.min(...pts.map((p) => p.y));
        const pw = Math.max(1, Math.max(...pts.map((p) => p.x)) - minX),
          ph = Math.max(1, Math.max(...pts.map((p) => p.y)) - minY);
        drafts.push({
          id,
          type: "pen",
          x: box.x + minX,
          y: box.y + minY,
          w: pw,
          h: ph,
          points: pts.flatMap((p) => [(p.x - minX) / pw, (p.y - minY) / ph]).map((v) => Math.round(v * 10000) / 10000),
          stroke: affineColor(e.color) || "#1e1e1e",
          strokeWidth: clamp(finite(e.lineWidth, 4), 1, e.type === "highlighter" ? 40 : 20),
          order: sort,
        });
        break;
      }
      case "connector":
        connectors.push(e);
        break;
      case "group":
        if (e.children && typeof e.children === "object")
          for (const child of Object.keys(e.children as object).slice(0, 5000)) groups.set(child, id);
        break;
      case "mindmap":
        if (e.children && typeof e.children === "object")
          for (const [node, detail] of Object.entries(e.children as Record<string, { parent?: unknown }>).slice(0, 5000))
            if (detail && typeof detail.parent === "string") mindmapLinks.push([detail.parent, node]);
        break;
      default:
        replaced++;
    }
  }
  // Connectors last: their ends need the boxes of what they connect.
  const known = new Set(drafts.filter((d) => d.type !== "pen").map((d) => d.id));
  const end = (raw: unknown) => {
    const c = (raw && typeof raw === "object" ? raw : {}) as { id?: unknown; position?: unknown };
    const pos = Array.isArray(c.position) && typeof c.position[0] === "number" && typeof c.position[1] === "number" ? (c.position as number[]) : null;
    if (typeof c.id === "string" && known.has(c.id) && boxes.has(c.id)) {
      const b = boxes.get(c.id)!;
      // Bound ends keep a position relative to the element (0–1).
      const [px, py] = pos && pos[0] >= 0 && pos[0] <= 1 && pos[1] >= 0 && pos[1] <= 1 ? pos : [0.5, 0.5];
      return { id: c.id, x: b.x + px * b.w, y: b.y + py * b.h };
    }
    return pos ? { x: finite(pos[0]), y: finite(pos[1]) } : null;
  };
  for (const e of connectors) {
    const from = end(e.source),
      to = end(e.target);
    if (!from || !to) {
      replaced++;
      continue;
    }
    const label = textOf(e.text);
    drafts.push({
      id: e.id as string,
      type: "connector",
      x: 0,
      y: 0,
      w: 0,
      h: 0,
      from,
      to,
      stroke: affineColor(e.stroke) || "#1e1e1e",
      strokeWidth: clamp(finite(e.strokeWidth, 2), 1, 20),
      ...(e.strokeStyle === "dash" ? { dashed: true } : {}),
      route: e.mode === 1 ? "elbow" : e.mode === 2 ? "curved" : "straight",
      endArrow: e.rearEndpointStyle !== "None",
      ...(e.frontEndpointStyle && e.frontEndpointStyle !== "None" ? { startArrow: true } : {}),
      ...(label ? { text: label } : {}),
      order: order(e.index),
    });
  }
  for (const [parent, child] of mindmapLinks) {
    const from = end({ id: parent }),
      to = end({ id: child });
    if (from && to)
      drafts.push({ id: `mm-${parent}-${child}`.slice(0, 200), type: "connector", x: 0, y: 0, w: 0, h: 0, from, to, stroke: "#84cfff", strokeWidth: 3, route: "curved", endArrow: false, order: "" });
  }
  // Groups, outermost first.
  const groupId = (id: string) => `a${id.replace(/[^\w-]/g, "").slice(0, 60)}`;
  for (const draft of drafts) {
    const path: string[] = [];
    let current = groups.get(draft.id);
    while (current && path.length < 10 && !path.includes(groupId(current))) {
      path.unshift(groupId(current));
      current = groups.get(current);
    }
    if (path.length) draft.groups = path;
  }
  // Without a note for the text, the card to the document goes top left.
  if (self && !cardPlaced) {
    const xs = [...boxes.values()];
    const x = xs.length ? Math.min(...xs.map((b) => b.x)) : 0,
      y = xs.length ? Math.min(...xs.map((b) => b.y)) - 180 : 0;
    card("affine-doc-card", { x, y, w: 280, h: 120 }, self, "");
  }
  // Frames below, then in AFFiNE's order (fractional index strings).
  const sorted = drafts
    .slice(0, BOARD_IMPORT_LIMITS.elements)
    .sort((a, b) => (a.type === "frame" ? 0 : 1) - (b.type === "frame" ? 0 : 1) || (a.order < b.order ? -1 : a.order > b.order ? 1 : 0))
    .map(({ order: _, ...draft }) => draft as BoardDraft);
  replaced += Math.max(0, drafts.length - BOARD_IMPORT_LIMITS.elements);
  return { format: "affine", items: normalise(sorted), images, replaced };
}
