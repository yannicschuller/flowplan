// Excalidraw and draw.io files as Flowplan whiteboard items. Client-safe and
// free of Node APIs: the server (lib/whiteboard-import-server.ts, the ZIP
// import) uses it, tests use it directly. Nothing is fetched: images only
// come along when the file carries them as data URLs, external ones become
// notes. Every text is plain text (HTML labels lose their markup), every
// number finite and bounded, and the amount of everything is limited.
import type { ShapeKind, WhiteboardItem } from "./whiteboard-model";
import { remapLink } from "./whiteboard-diagram-model";

export type BoardDraft = Omit<WhiteboardItem, "z"> & { z?: number };
export type ImportedImage = { id: string; mime: string; data: Uint8Array };
export type BoardFormat = "excalidraw" | "drawio";
export type ImportedBoard = {
  format: BoardFormat;
  items: BoardDraft[];
  // Embedded pictures; image items point at them as "import:<id>".
  images: ImportedImage[];
  // Elements that could not be shown as they were (became notes or were
  // left out because of the limits).
  replaced: number;
};
export const BOARD_IMPORT_LIMITS = {
  bytes: 20 * 1024 * 1024,
  inflated: 30 * 1024 * 1024,
  elements: 3000,
  xmlNodes: 200_000,
  depth: 200,
  text: 5000,
  points: 1000,
  imageBytes: 10 * 1024 * 1024,
  imagesTotal: 30 * 1024 * 1024,
  images: 100,
  coordinate: 1_000_000,
};
export const IMPORT_IMAGE_PREFIX = "import:";
export class BoardImportError extends Error {}
const fail = (message: string): never => {
  throw new BoardImportError(message);
};

// The format of a file by its name and beginning, or null.
export function boardFormat(name: string, text: string): BoardFormat | null {
  const head = text.slice(0, 2000).replace(/^﻿/, "").trimStart();
  if (/\.excalidraw(\.json)?$/i.test(name)) return "excalidraw";
  if (head.startsWith("{") && /"type"\s*:\s*"excalidraw(\/clipboard)?"/.test(text.slice(0, 5000)))
    return "excalidraw";
  if (/\.drawio$/i.test(name) && head.startsWith("<")) return "drawio";
  if (head.startsWith("<") && /<mxfile[\s>]|<mxGraphModel[\s>]|content="[^"]{0,200}(&lt;|<)mxfile/.test(text.slice(0, 1_000_000)))
    return "drawio";
  return null;
}
export const boardFileName = (name: string) => /\.(excalidraw|drawio)(\.json|\.xml|\.svg)?$/i.test(name);

export async function parseBoardFile(name: string, text: string): Promise<ImportedBoard> {
  if (text.length > BOARD_IMPORT_LIMITS.bytes) fail("Die Datei ist zu groß (höchstens 20 MB).");
  const format = boardFormat(name, text);
  if (format === "excalidraw") return parseExcalidraw(text);
  if (format === "drawio") return parseDrawio(text);
  return fail("Unbekanntes Format. Unterstützt werden Excalidraw (.excalidraw) und draw.io (.drawio, .xml, .svg).");
}

/* ---------- values ---------- */

const num = (value: unknown, fallback = 0) => {
  const n = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n)
    ? Math.max(-BOARD_IMPORT_LIMITS.coordinate, Math.min(BOARD_IMPORT_LIMITS.coordinate, n))
    : fallback;
};
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const round = (value: number) => Math.round(value * 100) / 100;
export function importColor(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim().toLowerCase();
  if (v === "none" || v === "transparent") return "transparent";
  if (/^#[0-9a-f]{3}$|^#[0-9a-f]{6}$|^#[0-9a-f]{8}$/.test(v)) return v;
  if (/^rgba?\(\s*[\d.]+%?\s*,\s*[\d.]+%?\s*,\s*[\d.]+%?\s*(,\s*[\d.]+%?\s*)?\)$/.test(v)) return v;
  if (/^[a-z]{3,20}$/.test(v) && v !== "default" && v !== "inherit") return v;
  return undefined;
}
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export function decodeEntities(text: string) {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : "";
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}
// Plain text for a board item: markup of HTML labels becomes line breaks,
// control characters go, the length is bounded.
export function importText(value: unknown, html = false): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  let text = String(value);
  if (html) {
    text = text
      .slice(0, BOARD_IMPORT_LIMITS.text * 20)
      .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(div|p|li|h[1-6]|tr)\s*>/gi, "\n")
      .replace(/<[^>]*>/g, "");
    text = decodeEntities(text);
  }
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‏‪-‮⁦-⁩]/g, "")
    .replace(/ /g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, BOARD_IMPORT_LIMITS.text);
}

/* ---------- images ---------- */

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
function base64Bytes(text: string): Uint8Array | null {
  const clean = text.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(clean)) return null;
  try {
    const binary = atob(clean.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}
// The content has to match its type: PNG, JPEG, GIF or WebP only (no SVG,
// which could carry scripts).
function imageSignature(mime: string, b: Uint8Array) {
  if (mime === "image/png") return b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  if (mime === "image/jpeg") return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (mime === "image/gif") return b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38;
  if (mime === "image/webp")
    return b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50;
  return false;
}
class ImageBag {
  images: ImportedImage[] = [];
  total = 0;
  // Returns the image's reference, or null when it cannot come along.
  add(dataUrl: unknown): string | null {
    if (typeof dataUrl !== "string") return null;
    const match = /^data:(image\/[a-z+.-]+)(?:;[a-z-]+=[^;,]*)*(;base64)?,/i.exec(dataUrl.slice(0, 200));
    if (!match) return null;
    const mime = match[1].toLowerCase().replace("image/jpg", "image/jpeg");
    if (!IMAGE_TYPES.has(mime)) return null;
    const payload = dataUrl.slice(match[0].length);
    if (payload.length > (BOARD_IMPORT_LIMITS.imageBytes * 4) / 3 + 16) return null;
    // draw.io writes "data:image/png,<base64>" (";" separates its styles).
    const data = base64Bytes(payload);
    if (!data || !data.length || data.length > BOARD_IMPORT_LIMITS.imageBytes || !imageSignature(mime, data)) return null;
    if (this.images.length >= BOARD_IMPORT_LIMITS.images || this.total + data.length > BOARD_IMPORT_LIMITS.imagesTotal) return null;
    const id = `img${this.images.length + 1}`;
    this.images.push({ id, mime, data });
    this.total += data.length;
    return IMPORT_IMAGE_PREFIX + id;
  }
}

/* ---------- helpers for items ---------- */

const note = (id: string, x: number, y: number, text: string, w = 200, h = 140): BoardDraft => ({
  id,
  type: "sticky",
  x,
  y,
  w: clamp(w, 80, 600),
  h: clamp(h, 60, 600),
  text: text || "?",
  fill: "#e9ecef",
  fontSize: 14,
});
// Positions start at 0/0; the board decides where the content goes.
function normalise(items: BoardDraft[]) {
  let minX = Infinity,
    minY = Infinity;
  for (const item of items) {
    if (item.type === "connector") {
      for (const end of [item.from, item.to])
        if (end && !end.id) {
          minX = Math.min(minX, end.x);
          minY = Math.min(minY, end.y);
        }
      continue;
    }
    minX = Math.min(minX, item.x);
    minY = Math.min(minY, item.y - (item.type === "frame" ? 30 : 0));
  }
  if (!Number.isFinite(minX)) return items;
  return items.map((item) => ({
    ...item,
    // Connectors are placed by their ends.
    x: item.type === "connector" ? 0 : round(item.x - minX),
    y: item.type === "connector" ? 0 : round(item.y - minY),
    ...(item.from ? { from: { ...item.from, x: round(item.from.x - minX), y: round(item.from.y - minY) } } : {}),
    ...(item.to ? { to: { ...item.to, x: round(item.to.x - minX), y: round(item.to.y - minY) } } : {}),
  }));
}
function connectorBox(item: BoardDraft) {
  const a = item.from!,
    b = item.to!;
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

/* ---------- Excalidraw ---------- */

type ExElement = Record<string, unknown> & { id?: unknown; type?: unknown };
export function parseExcalidraw(text: string): ImportedBoard {
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    return fail("Die Excalidraw-Datei ist kein gültiges JSON.");
  }
  const scene = data as { type?: unknown; elements?: unknown; files?: unknown };
  if (!scene || typeof scene !== "object" || !Array.isArray(scene.elements))
    return fail("Die Excalidraw-Datei enthält keine Elemente.");
  if (scene.type !== undefined && scene.type !== "excalidraw" && scene.type !== "excalidraw/clipboard")
    return fail("Die Datei ist keine Excalidraw-Zeichnung.");
  const elements = (scene.elements as unknown[]).filter(
    (e): e is ExElement => !!e && typeof e === "object" && !(e as ExElement).isDeleted && typeof (e as ExElement).type === "string",
  );
  if (elements.length > BOARD_IMPORT_LIMITS.elements)
    fail(`Zu viele Elemente (höchstens ${BOARD_IMPORT_LIMITS.elements}).`);
  const files = (scene.files && typeof scene.files === "object" ? scene.files : {}) as Record<string, { dataURL?: unknown; mimeType?: unknown }>;
  const images = new ImageBag();
  const ids = new Map<string, string>();
  elements.forEach((e, i) => typeof e.id === "string" && ids.set(e.id, `x${i}`));
  const local = (e: ExElement, i: number) => (typeof e.id === "string" && ids.get(e.id)) || `x${i}`;
  const byId = new Map(elements.filter((e) => typeof e.id === "string").map((e) => [e.id as string, e]));
  // Texts bound to a shape or an arrow are that element's label.
  const labels = new Map<string, ExElement>();
  for (const e of elements)
    if (e.type === "text" && typeof e.containerId === "string" && byId.has(e.containerId)) labels.set(e.containerId, e);
  const items: BoardDraft[] = [];
  let replaced = 0;
  const shapeKinds: Record<string, ShapeKind> = { rectangle: "rectangle", ellipse: "ellipse", diamond: "diamond" };
  const shapeIds = new Set<string>();
  elements.forEach((e, i) => {
    if (["rectangle", "ellipse", "diamond", "image", "frame", "magicframe", "text"].includes(e.type as string)) shapeIds.add(local(e, i));
  });
  elements.forEach((e, i) => {
    const id = local(e, i),
      x = num(e.x),
      y = num(e.y),
      w = Math.abs(num(e.width)),
      h = Math.abs(num(e.height)),
      rotation = round((num(e.angle) * 180) / Math.PI) % 360,
      stroke = importColor(e.strokeColor),
      fill = importColor(e.backgroundColor),
      strokeWidth = clamp(num(e.strokeWidth, 2), 0.5, 20),
      dashed = e.strokeStyle === "dashed" || e.strokeStyle === "dotted" ? true : undefined;
    const label = typeof e.id === "string" ? labels.get(e.id) : undefined;
    const labelText = label ? importText(label.text ?? label.originalText) : "";
    const labelStyle = label
      ? {
          fontSize: clamp(num(label.fontSize, 20), 6, 200),
          textColor: importColor(label.strokeColor),
          align: (["left", "center", "right"].includes(label.textAlign as string) ? label.textAlign : undefined) as BoardDraft["align"],
        }
      : {};
    switch (e.type) {
      case "rectangle":
      case "ellipse":
      case "diamond": {
        const rounded = e.type === "rectangle" && !!e.roundness;
        items.push({
          id,
          type: "shape",
          shape: rounded ? "rounded" : shapeKinds[e.type as string],
          x,
          y,
          w: Math.max(1, w),
          h: Math.max(1, h),
          ...(rotation ? { rotation } : {}),
          fill: fill || "transparent",
          stroke: stroke || "#1e1e1e",
          strokeWidth,
          ...(dashed ? { dashed } : {}),
          text: labelText,
          fontSize: 20,
          ...labelStyle,
        });
        return;
      }
      case "text": {
        if (typeof e.containerId === "string" && byId.has(e.containerId)) return;
        items.push({
          id,
          type: "text",
          x,
          y,
          w: Math.max(20, w),
          h: Math.max(16, h),
          ...(rotation ? { rotation } : {}),
          text: importText(e.text ?? e.originalText),
          fontSize: clamp(num(e.fontSize, 20), 6, 200),
          textColor: stroke,
          align: (["left", "center", "right"].includes(e.textAlign as string) ? e.textAlign : "left") as BoardDraft["align"],
        });
        return;
      }
      case "arrow":
      case "line": {
        const points = (Array.isArray(e.points) ? e.points : []).filter(
          (p): p is [number, number] => Array.isArray(p) && p.length >= 2,
        );
        if (points.length < 2) return void replaced++;
        const first = points[0],
          last = points[points.length - 1];
        const end = (binding: unknown, p: [number, number]) => {
          const target = binding && typeof binding === "object" ? (binding as { elementId?: unknown }).elementId : undefined;
          const tid = typeof target === "string" ? ids.get(target) : undefined;
          return { ...(tid && shapeIds.has(tid) ? { id: tid } : {}), x: x + num(p[0]), y: y + num(p[1]) };
        };
        const isArrow = e.type === "arrow";
        items.push({
          id,
          type: "connector",
          x: 0,
          y: 0,
          w: 0,
          h: 0,
          from: end(e.startBinding, first),
          to: end(e.endBinding, last),
          stroke: stroke || "#1e1e1e",
          strokeWidth,
          ...(dashed ? { dashed } : {}),
          route: e.elbowed ? "elbow" : points.length > 2 && e.roundness ? "curved" : "straight",
          endArrow: isArrow && e.endArrowhead !== null,
          ...(isArrow && e.startArrowhead ? { startArrow: true } : {}),
          ...(labelText ? { text: labelText } : {}),
        });
        return;
      }
      case "freedraw": {
        const raw = (Array.isArray(e.points) ? e.points : []).filter(
          (p): p is [number, number] => Array.isArray(p) && p.length >= 2,
        );
        if (!raw.length) return void replaced++;
        const step = Math.ceil(raw.length / BOARD_IMPORT_LIMITS.points);
        const picked = raw.filter((_, k) => k % step === 0 || k === raw.length - 1);
        const pts = picked.map((p) => ({ x: num(p[0]), y: num(p[1]) }));
        const minX = Math.min(...pts.map((p) => p.x)),
          minY = Math.min(...pts.map((p) => p.y)),
          pw = Math.max(1, Math.max(...pts.map((p) => p.x)) - minX),
          ph = Math.max(1, Math.max(...pts.map((p) => p.y)) - minY);
        const pressures = Array.isArray(e.pressures) && e.simulatePressure === false && e.pressures.length === raw.length
          ? (e.pressures as unknown[]).filter((_, k) => k % step === 0 || k === raw.length - 1).map((p) => round(clamp(num(p, 0.5), 0, 1)))
          : undefined;
        items.push({
          id,
          type: "pen",
          x: x + minX,
          y: y + minY,
          w: pw,
          h: ph,
          points: pts.flatMap((p) => [round((p.x - minX) / pw), round((p.y - minY) / ph)]).map((v) => Math.round(v * 10000) / 10000),
          ...(pressures ? { pressures } : {}),
          stroke: stroke || "#1e1e1e",
          strokeWidth,
        });
        return;
      }
      case "image": {
        const file = typeof e.fileId === "string" ? files[e.fileId] : undefined;
        const src = images.add(file?.dataURL);
        if (!src) {
          replaced++;
          items.push(note(id, x, y, "Bild (nicht übernommen)", w, h));
          return;
        }
        items.push({ id, type: "image", x, y, w: Math.max(4, w), h: Math.max(4, h), ...(rotation ? { rotation } : {}), src });
        return;
      }
      case "frame":
      case "magicframe":
        items.push({
          id,
          type: "frame",
          x,
          y,
          w: Math.max(40, w),
          h: Math.max(40, h),
          text: importText(e.name) || "Rahmen",
          fill: "#ffffff",
        });
        return;
      default: {
        // Embeds, iframes and anything newer: a note with what is known.
        replaced++;
        const what = importText(e.link) || importText(e.name) || importText(e.text) || String(e.type).slice(0, 40);
        items.push(note(id, x, y, what, w, h));
      }
    }
  });
  return { format: "excalidraw", items: normalise(items), images: images.images, replaced };
}

/* ---------- XML (draw.io) ---------- */

export type XmlNode = { name: string; attrs: Record<string, string>; children: XmlNode[]; text: string };
const TAG = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/y;
const ATTR = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
// A small, strict XML reader: elements, attributes, text, CDATA. Comments,
// processing instructions and the document type are skipped; entities other
// than the predefined and numeric ones are never expanded.
export function parseXml(source: string): XmlNode {
  const root: XmlNode = { name: "#document", attrs: {}, children: [], text: "" };
  const stack = [root];
  let i = 0,
    count = 0;
  const top = () => stack[stack.length - 1];
  const skipTo = (marker: string, from: number) => {
    const end = source.indexOf(marker, from);
    if (end < 0) fail("Die XML-Datei ist unvollständig.");
    return end + marker.length;
  };
  while (i < source.length) {
    const lt = source.indexOf("<", i);
    if (lt < 0) {
      top().text += decodeEntities(source.slice(i));
      break;
    }
    if (lt > i && top().text.length < BOARD_IMPORT_LIMITS.inflated) top().text += decodeEntities(source.slice(i, lt));
    if (source.startsWith("<!--", lt)) i = skipTo("-->", lt + 4);
    else if (source.startsWith("<![CDATA[", lt)) {
      const end = skipTo("]]>", lt + 9);
      top().text += source.slice(lt + 9, end - 3);
      i = end;
    } else if (source.startsWith("<?", lt)) i = skipTo("?>", lt + 2);
    else if (source.startsWith("<!", lt)) {
      const close = source.indexOf(">", lt),
        bracket = source.indexOf("[", lt);
      i = bracket >= 0 && (close < 0 || bracket < close) ? skipTo("]>", bracket) : skipTo(">", lt);
    } else {
      TAG.lastIndex = lt;
      const m = TAG.exec(source);
      if (!m) return fail("Die XML-Datei ist fehlerhaft.");
      i = TAG.lastIndex;
      if (m[1]) {
        if (stack.length < 2 || top().name !== m[2]) fail("Die XML-Datei ist fehlerhaft.");
        stack.pop();
        continue;
      }
      if (++count > BOARD_IMPORT_LIMITS.xmlNodes) fail("Die Datei enthält zu viele Elemente.");
      const attrs: Record<string, string> = {};
      for (const a of m[3].matchAll(ATTR)) attrs[a[1]] = decodeEntities(a[2] ?? a[3] ?? "");
      const node: XmlNode = { name: m[2], attrs, children: [], text: "" };
      top().children.push(node);
      if (!m[4]) {
        stack.push(node);
        if (stack.length > BOARD_IMPORT_LIMITS.depth) fail("Die XML-Datei ist zu tief verschachtelt.");
      }
    }
  }
  if (stack.length !== 1 || !root.children.length) fail("Die XML-Datei ist fehlerhaft.");
  return root.children[0];
}

async function inflateRaw(data: Uint8Array, max: number) {
  if (typeof DecompressionStream === "undefined") return fail("Komprimierte Diagramme werden hier nicht unterstützt.");
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > max) {
        await reader.cancel().catch(() => {});
        fail("Das entpackte Diagramm ist zu groß.");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof BoardImportError) throw error;
    fail("Das komprimierte Diagramm ist beschädigt.");
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return new TextDecoder().decode(out);
}
// draw.io stores pages compressed: base64 of raw deflate of the
// URI-encoded XML.
export async function inflateDrawio(text: string) {
  const bytes = base64Bytes(text.trim());
  if (!bytes || !bytes.length) return fail("Das komprimierte Diagramm ist beschädigt.");
  const inflated = await inflateRaw(bytes, BOARD_IMPORT_LIMITS.inflated);
  try {
    return decodeURIComponent(inflated);
  } catch {
    return inflated;
  }
}

type Cell = {
  id: string;
  value: string;
  style: Record<string, string>;
  first: string;
  vertex: boolean;
  edge: boolean;
  parent: string;
  source: string;
  target: string;
  geo: { x: number; y: number; w: number; h: number; relative: boolean; points: Record<string, { x: number; y: number }> } | null;
};
function parseStyle(style = "") {
  const out: Record<string, string> = {};
  let first = "";
  style.split(";").forEach((part, i) => {
    if (!part) return;
    const eq = part.indexOf("=");
    if (eq < 0) {
      if (i === 0) first = part;
      out[part] = "1";
    } else out[part.slice(0, eq)] = part.slice(eq + 1);
  });
  return { style: out, first };
}
function cellsOf(model: XmlNode): Cell[] {
  const root = model.children.find((c) => c.name === "root");
  if (!root) return [];
  const cells: Cell[] = [];
  const read = (cell: XmlNode, wrapper?: XmlNode) => {
    const geometry = cell.children.find((c) => c.name === "mxGeometry");
    const points: Record<string, { x: number; y: number }> = {};
    for (const p of geometry?.children || [])
      if (p.name === "mxPoint" && p.attrs.as) points[p.attrs.as] = { x: num(p.attrs.x), y: num(p.attrs.y) };
    const { style, first } = parseStyle(cell.attrs.style);
    cells.push({
      id: wrapper?.attrs.id ?? cell.attrs.id ?? "",
      value: wrapper ? (wrapper.attrs.label ?? "") : (cell.attrs.value ?? ""),
      style,
      first,
      vertex: cell.attrs.vertex === "1",
      edge: cell.attrs.edge === "1",
      parent: cell.attrs.parent ?? "",
      source: cell.attrs.source ?? "",
      target: cell.attrs.target ?? "",
      geo: geometry
        ? {
            x: num(geometry.attrs.x),
            y: num(geometry.attrs.y),
            w: Math.abs(num(geometry.attrs.width)),
            h: Math.abs(num(geometry.attrs.height)),
            relative: geometry.attrs.relative === "1",
            points,
          }
        : null,
    });
  };
  for (const child of root.children) {
    if (child.name === "mxCell") read(child);
    else if (child.name === "UserObject" || child.name === "object") {
      const inner = child.children.find((c) => c.name === "mxCell");
      if (inner) read(inner, child);
    }
  }
  return cells;
}
const DRAWIO_SHAPES: Record<string, ShapeKind> = {
  ellipse: "ellipse",
  doubleellipse: "ellipse",
  rhombus: "diamond",
  triangle: "triangle",
  hexagon: "hexagon",
  parallelogram: "parallelogram",
  cloud: "cloud",
  star: "star",
  singlearrow: "arrow",
  rect: "rectangle",
  rectangle: "rectangle",
  label: "rectangle",
  process: "rectangle",
};
function drawioPage(model: XmlNode, prefix: string, images: ImageBag) {
  const cells = cellsOf(model);
  if (cells.length > BOARD_IMPORT_LIMITS.elements) fail(`Zu viele Elemente (höchstens ${BOARD_IMPORT_LIMITS.elements}).`);
  const byId = new Map(cells.map((c) => [c.id, c]));
  // Children of shapes and groups are positioned relative to them.
  const offsets = new Map<string, { x: number; y: number }>();
  const offset = (id: string, depth = 0): { x: number; y: number } => {
    const known = offsets.get(id);
    if (known) return known;
    const cell = byId.get(id);
    if (!cell || !cell.vertex || !cell.geo || depth > 50) return { x: 0, y: 0 };
    const parent = offset(cell.parent, depth + 1);
    const value = { x: parent.x + cell.geo.x, y: parent.y + cell.geo.y };
    offsets.set(id, value);
    return value;
  };
  const local = (id: string) => `${prefix}${id}`;
  const items: BoardDraft[] = [];
  let replaced = 0;
  const imported = new Set<string>();
  const labels = new Map<string, string[]>();
  for (const cell of cells) {
    if (!cell.vertex || !cell.geo) continue;
    const s = cell.style,
      html = s.html === "1";
    const text = importText(cell.value, html);
    const parent = byId.get(cell.parent);
    // Labels placed on a line belong to that line.
    if (parent?.edge && (cell.first === "edgeLabel" || cell.geo.relative)) {
      if (text) labels.set(parent.id, [...(labels.get(parent.id) || []), text]);
      continue;
    }
    if (cell.first === "group" && !text) continue;
    const at = offset(cell.id);
    const id = local(cell.id);
    const base = {
      id,
      x: at.x,
      y: at.y,
      w: Math.max(1, cell.geo.w),
      h: Math.max(1, cell.geo.h),
      ...(num(s.rotation) ? { rotation: round(num(s.rotation)) % 360 } : {}),
    };
    const fontSize = s.fontSize ? clamp(num(s.fontSize, 12), 6, 200) : 14;
    const textStyle = {
      fontSize,
      ...(num(s.fontStyle) & 1 ? { bold: true } : {}),
      ...(["left", "center", "right"].includes(s.align) ? { align: s.align as BoardDraft["align"] } : {}),
      ...(importColor(s.fontColor) && importColor(s.fontColor) !== "transparent" ? { textColor: importColor(s.fontColor) } : {}),
    };
    const fill = importColor(s.fillColor),
      stroke = importColor(s.strokeColor),
      strokeWidth = s.strokeWidth ? clamp(num(s.strokeWidth, 1), 0.5, 20) : 1,
      dashed = s.dashed === "1" ? { dashed: true } : {};
    const shapeName = (s.shape || cell.first || "").toLowerCase();
    imported.add(cell.id);
    if (cell.first === "text" || shapeName === "text" || (!shapeName && fill === "transparent" && stroke === "transparent")) {
      items.push({ ...base, type: "text", text, ...textStyle, align: textStyle.align || "center" });
    } else if (cell.first === "swimlane" || shapeName === "swimlane" || (s.container === "1" && cells.some((c) => c.parent === cell.id))) {
      items.push({ ...base, type: "frame", text: text || "Rahmen", fill: fill && fill !== "transparent" ? fill : "#ffffff" });
    } else if (shapeName === "image" || cell.first === "image" || s.image) {
      const src = images.add(s.image);
      if (src) items.push({ ...base, type: "image", src });
      else {
        replaced++;
        items.push(note(id, at.x, at.y, text || "Bild (nicht übernommen)", base.w, base.h));
      }
    } else if (shapeName === "note" || shapeName === "mxgraph.basic.note" || cell.first === "note") {
      items.push({ ...base, type: "sticky", text, fill: fill && fill !== "transparent" ? fill : "#fff6b6", ...textStyle });
    } else if (!shapeName || DRAWIO_SHAPES[shapeName]) {
      const kind = DRAWIO_SHAPES[shapeName] || (s.rounded === "1" ? "rounded" : "rectangle");
      items.push({
        ...base,
        type: "shape",
        shape: kind === "rectangle" && s.rounded === "1" ? "rounded" : kind,
        text,
        fill: fill || "#ffffff",
        stroke: stroke || "#000000",
        strokeWidth,
        ...dashed,
        ...textStyle,
      });
    } else {
      // Stencils (mxgraph.aws4.…, UML, BPMN …): a note with the label.
      replaced++;
      items.push(note(id, at.x, at.y, text || shapeName.replace(/^mxgraph\./, "").slice(0, 60), base.w, base.h));
    }
  }
  for (const cell of cells) {
    if (!cell.edge) continue;
    const s = cell.style;
    const parent = offset(cell.parent);
    const point = (name: string) => {
      const p = cell.geo?.points[name];
      return p ? { x: parent.x + p.x, y: parent.y + p.y } : null;
    };
    const centre = (id: string) => {
      const c = byId.get(id);
      if (!c?.geo) return null;
      const at = offset(id);
      return { x: at.x + c.geo.w / 2, y: at.y + c.geo.h / 2 };
    };
    const end = (target: string, name: string) => {
      const p = point(name) || centre(target) || { x: 0, y: 0 };
      return imported.has(target) ? { id: local(target), ...p } : p;
    };
    const from = end(cell.source, "sourcePoint"),
      to = end(cell.target, "targetPoint");
    if (!cell.source && !point("sourcePoint") && !cell.target && !point("targetPoint")) {
      replaced++;
      continue;
    }
    const text = [importText(cell.value, s.html === "1"), ...(labels.get(cell.id) || [])].filter(Boolean).join(" ").slice(0, BOARD_IMPORT_LIMITS.text);
    const stroke = importColor(s.strokeColor);
    items.push({
      id: local(cell.id),
      type: "connector",
      x: 0,
      y: 0,
      w: 0,
      h: 0,
      from,
      to,
      stroke: stroke && stroke !== "transparent" ? stroke : "#000000",
      strokeWidth: s.strokeWidth ? clamp(num(s.strokeWidth, 1), 0.5, 20) : 1,
      ...(s.dashed === "1" ? { dashed: true } : {}),
      route: /orthogonal|elbow|entityRelation|isometric/i.test(s.edgeStyle || "") ? "elbow" : s.curved === "1" ? "curved" : "straight",
      endArrow: s.endArrow !== "none",
      ...(s.startArrow && s.startArrow !== "none" ? { startArrow: true } : {}),
      ...(text ? { text } : {}),
    });
  }
  return { items, replaced };
}
export async function parseDrawio(text: string): Promise<ImportedBoard> {
  let root = parseXml(text.replace(/^﻿/, ""));
  // An SVG exported with "include a copy of my diagram".
  if (root.name === "svg") {
    const content = root.attrs.content;
    if (!content || !/<mxfile|<mxGraphModel/.test(content))
      fail("Dieses SVG enthält kein draw.io-Diagramm.");
    root = parseXml(content);
  }
  let diagrams: { name: string; model: XmlNode }[] = [];
  if (root.name === "mxGraphModel") diagrams = [{ name: "", model: root }];
  else if (root.name === "mxfile") {
    const pages = root.children.filter((c) => c.name === "diagram");
    if (pages.length > 50) fail("Zu viele Seiten im Diagramm (höchstens 50).");
    for (const page of pages) {
      const inline = page.children.find((c) => c.name === "mxGraphModel");
      const model = inline || (page.text.trim() ? parseXml(await inflateDrawio(page.text)) : null);
      if (model && model.name === "mxGraphModel") diagrams.push({ name: importText(page.attrs.name), model });
    }
  } else fail("Die Datei ist kein draw.io-Diagramm.");
  if (!diagrams.length) fail("Das Diagramm ist leer.");
  const images = new ImageBag();
  const items: BoardDraft[] = [];
  let replaced = 0,
    left = 0;
  // Several pages lie side by side, each in a frame named like the page.
  diagrams.forEach(({ name, model }, index) => {
    const page = drawioPage(model, `p${index}-`, images);
    replaced += page.replaced;
    if (items.length + page.items.length > BOARD_IMPORT_LIMITS.elements)
      fail(`Zu viele Elemente (höchstens ${BOARD_IMPORT_LIMITS.elements}).`);
    if (!page.items.length) return;
    const shaped = normalise(page.items);
    const bounds = shaped.reduce(
      (box, item) => {
        const b = item.type === "connector" ? connectorBox(item) : item;
        return { w: Math.max(box.w, b.x + b.w), h: Math.max(box.h, b.y + b.h) };
      },
      { w: 0, h: 0 },
    );
    const pad = diagrams.length > 1 ? 40 : 0;
    const move = (item: BoardDraft): BoardDraft => ({
      ...item,
      x: item.type === "connector" ? 0 : item.x + left + pad,
      y: item.type === "connector" ? 0 : item.y + pad,
      ...(item.from ? { from: { ...item.from, x: item.from.x + left + pad, y: item.from.y + pad } } : {}),
      ...(item.to ? { to: { ...item.to, x: item.to.x + left + pad, y: item.to.y + pad } } : {}),
    });
    if (diagrams.length > 1)
      items.push({
        id: `p${index}-frame`,
        type: "frame",
        x: left,
        y: 0,
        w: bounds.w + pad * 2,
        h: bounds.h + pad * 2,
        text: name || `Seite ${index + 1}`,
        fill: "#ffffff",
      });
    items.push(...shaped.map(move));
    left += bounds.w + pad * 2 + 200;
  });
  return { format: "drawio", items: normalise(items), images: images.images, replaced };
}

// Board items with fresh ids (connectors follow), shifted by dx/dy, with
// image references resolved: `image` returns the stored address or null
// (the image then becomes a note).
export function placeDrafts(
  drafts: BoardDraft[],
  options: {
    dx?: number;
    dy?: number;
    newId: () => string;
    image?: (ref: string) => string | null;
    // Highest and lowest z on the board: frames go below, the rest above.
    topZ?: number;
    bottomZ?: number;
  },
): (WhiteboardItem & { id: string })[] {
  const dx = options.dx || 0,
    dy = options.dy || 0;
  const ids = new Map(drafts.map((d) => [d.id, options.newId()]));
  let top = Math.max(0, options.topZ || 0),
    bottom = Math.min(0, options.bottomZ || 0);
  return drafts.map((d) => {
    let item: WhiteboardItem = {
      ...d,
      id: ids.get(d.id)!,
      x: d.x + dx,
      y: d.y + dy,
      z: d.type === "frame" ? --bottom : ++top,
    };
    if (d.from) item.from = { ...d.from, x: d.from.x + dx, y: d.from.y + dy, ...(d.from.id ? { id: ids.get(d.from.id) } : {}) };
    if (d.to) item.to = { ...d.to, x: d.to.x + dx, y: d.to.y + dy, ...(d.to.id ? { id: ids.get(d.to.id) } : {}) };
    if (item.from && !item.from.id) delete item.from.id;
    if (item.to && !item.to.id) delete item.to.id;
    // Prototype links to frames placed along point to them.
    item = remapLink(item, ids);
    if (options.image) [item] = resolveImages([item], options.image) as WhiteboardItem[];
    return item as WhiteboardItem & { id: string };
  });
}

// Image items with "import:<id>" get their stored address; without one they
// become a note saying so.
export function resolveImages<T extends BoardDraft>(drafts: T[], image: (ref: string) => string | null): T[] {
  return drafts.map((item) => {
    if (item.type !== "image" || !item.src?.startsWith(IMPORT_IMAGE_PREFIX)) return item;
    const src = image(item.src);
    if (src) return { ...item, src };
    const { src: _, ...rest } = item;
    return { ...rest, type: "sticky", text: "Bild (nicht übernommen)", fill: "#e9ecef", fontSize: 14 } as T;
  });
}
