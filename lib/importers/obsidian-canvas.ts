// Obsidian canvases (.canvas, JSON Canvas 1.0, https://jsoncanvas.org) as
// Flowplan whiteboards (#667). The file is untrusted: every node and edge is
// checked on its own, unknown fields are ignored, and what cannot be shown
// is left out and named in `problems` – a bad element never fails the
// canvas. Mapping:
// - text nodes → notes; their Markdown becomes the board's rich-text markup
//   (lib/whiteboard-richtext.ts: bold, italic, lists, http(s) links), the
//   rest plain text,
// - file nodes → a card of the page when the file is a note or canvas of
//   the vault, an image (PNG, JPEG, GIF, WebP) carried along, else a note
//   with the file's name,
// - link nodes → a link card (http/https only),
// - group nodes → frames with their label,
// - edges → connectors bound to their nodes, with sides, arrow ends, colour
//   and label.
// Colours: the presets "1"–"6" map to the board palette, hex stays.
import { BOARD_IMPORT_LIMITS, IMPORT_IMAGE_PREFIX, imageSignature, importColor, importText, normalise, type BoardDraft, type ImportedBoard, type ImportedImage } from "../whiteboard-import";
import { ct } from "../content-locale";

export const CANVAS = /\.canvas$/i;

export type CanvasJson = { nodes: unknown[]; edges: unknown[] };
// The canvas as JSON with node and edge lists, or the reason it is not one.
export function readCanvas(data: Buffer): CanvasJson | { error: string } {
  if (data.length > BOARD_IMPORT_LIMITS.bytes) return { error: ct("Canvas zu groß (höchstens 20 MB)", "Canvas too large (at most 20 MB)") };
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.toString("utf8").replace(/^﻿/, "") || "{}");
  } catch {
    return { error: ct("Canvas ist kein gültiges JSON", "Canvas is not valid JSON") };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { error: ct("Canvas ist kein gültiges JSON", "Canvas is not valid JSON") };
  const { nodes, edges } = parsed as { nodes?: unknown; edges?: unknown };
  if ((nodes !== undefined && !Array.isArray(nodes)) || (edges !== undefined && !Array.isArray(edges)))
    return { error: ct("Canvas ist kein gültiges JSON", "Canvas is not valid JSON") };
  return { nodes: (nodes as unknown[]) || [], edges: (edges as unknown[]) || [] };
}

export type CanvasContext = {
  // The pageRef placeholder of a note or canvas of the vault, or null.
  page: (target: string) => string | null;
  // The bytes of another file of the vault, or null.
  file: (target: string) => { name: string; data: Buffer } | null;
};

// Obsidian's presets: red, orange, yellow, green, cyan, purple.
const FILLS: Record<string, string> = { "1": "#ffc9c9", "2": "#ffd8a8", "3": "#fff6b6", "4": "#b2f2bb", "5": "#a5d8ff", "6": "#d0bfff" };
const STROKES: Record<string, string> = { "1": "#e03131", "2": "#f08c00", "3": "#f08c00", "4": "#2f9e44", "5": "#1971c2", "6": "#7048e8" };
const hex = (value: unknown) => {
  const color = importColor(value);
  return color && color.startsWith("#") ? color : undefined;
};
const fillOf = (value: unknown) => (typeof value === "string" ? FILLS[value.trim()] || hex(value) : undefined);
const strokeOf = (value: unknown) => (typeof value === "string" ? STROKES[value.trim()] || hex(value) : undefined);

const LIMIT = BOARD_IMPORT_LIMITS.coordinate;
const coord = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? Math.max(-LIMIT, Math.min(LIMIT, value)) : null);
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const str = (value: unknown, max = 2000) => (typeof value === "string" && value.length <= max ? value : undefined);
const webLink = (value: unknown) => {
  const raw = str(value)?.trim();
  if (!raw || /[\s<>"'`\\]/.test(raw)) return undefined;
  try {
    const url = new URL(raw);
    return (url.protocol === "https:" || url.protocol === "http:") && url.hostname && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
};
const shortName = (value: string) => value.replace(/^.*\//, "").slice(0, 200);

// Obsidian Markdown as the board's rich-text markup: headings bold,
// wikilinks and links to anything but the web as their text, images as
// their description, tasks with a box, HTML as text.
export function canvasText(markdown: string) {
  let fence = false;
  const lines = importText(markdown.slice(0, BOARD_IMPORT_LIMITS.text * 4), true).split("\n");
  const out: string[] = [];
  for (const raw of lines) {
    if (/^\s{0,3}(`{3,}|~{3,})/.test(raw)) {
      fence = !fence;
      continue;
    }
    if (fence) {
      out.push(raw);
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(raw)) continue;
    let line = raw
      .replace(/^\s{0,3}(>\s?)+/, "")
      .replace(/^\[!\w+\][+-]?\s*/, "")
      .replace(/^(\s*)[-*+]\s+\[[xX]\]\s+/, "$1- ☑ ")
      .replace(/^(\s*)[-*+]\s+\[ \]\s+/, "$1- ☐ ");
    const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) line = heading[1] ? `**${heading[1]}**` : "";
    line = line
      .replace(/!?\[\[([^\]\n|]*?)(?:\|([^\]\n]*))?\]\]/g, (_, target: string, label?: string) =>
        label && !/^\d+(x\d+)?$/.test(label) ? label : shortName(target.replace(/[#^].*$/, "")) || target.replace(/^[#^]+/, ""),
      )
      .replace(/!\[([^\]\n]*)\]\([^)\n]*\)/g, "$1")
      .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (whole, label: string, href: string) => (webLink(href) ? `[${label}](${webLink(href)})` : label))
      .replace(/`+([^`]*)`+/g, "$1")
      .replace(/==([^=\n]+)==/g, "$1")
      .replace(/~~([^~\n]+)~~/g, "$1")
      .replace(/(^|\s)%%.*?%%/g, "$1");
    out.push(line);
  }
  return importText(out.join("\n"));
}

type Box = { x: number; y: number; w: number; h: number };
const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
const IMAGE_MIMES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const SIDES = new Set(["top", "right", "bottom", "left"]);

// The board of a canvas; `problems` names what was left out or replaced.
export type CanvasProblem = { kind: "block" | "file"; detail: string };
export function canvasBoard(canvas: CanvasJson, ctx: CanvasContext): { board: ImportedBoard; problems: CanvasProblem[] } {
  const problems: CanvasProblem[] = [];
  const items: BoardDraft[] = [];
  const frames: BoardDraft[] = [];
  const images: ImportedImage[] = [];
  const imageRefs = new Map<string, string>();
  let imageBytes = 0,
    replaced = 0;
  const skip = (detail: string, kind: CanvasProblem["kind"] = "block") => {
    replaced++;
    problems.push({ kind, detail });
  };
  const boxes = new Map<string, Box>();
  const ids = new Map<string, string>();
  const max = BOARD_IMPORT_LIMITS.elements;
  const nodes = canvas.nodes.slice(0, max);
  if (canvas.nodes.length > max)
    skip(ct(`${canvas.nodes.length - max} Elemente über der Grenze von ${max} ausgelassen`, `${canvas.nodes.length - max} elements over the limit of ${max} left out`));

  const image = (name: string, data: Buffer) => {
    if (imageRefs.has(name)) return imageRefs.get(name)!;
    const mime = IMAGE_MIMES.find((m) => imageSignature(m, data));
    if (!mime || data.length > BOARD_IMPORT_LIMITS.imageBytes) return null;
    if (images.length >= BOARD_IMPORT_LIMITS.images || imageBytes + data.length > BOARD_IMPORT_LIMITS.imagesTotal) return null;
    const id = `img${images.length + 1}`;
    images.push({ id, mime, data: new Uint8Array(data) });
    imageBytes += data.length;
    imageRefs.set(name, IMPORT_IMAGE_PREFIX + id);
    return IMPORT_IMAGE_PREFIX + id;
  };
  const sticky = (id: string, box: Box, text: string, fill = "#e9ecef", link?: string): BoardDraft => ({
    id,
    type: "sticky",
    ...box,
    text: text || " ",
    fill,
    fontSize: 14,
    ...(link ? { link } : {}),
  });

  nodes.forEach((raw, i) => {
    const node = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
    const sourceId = str(node.id, 200);
    const x = coord(node.x),
      y = coord(node.y),
      w = coord(node.width),
      h = coord(node.height);
    if (!sourceId || x === null || y === null || w === null || h === null || ids.has(sourceId)) {
      skip(ct("Ungültiges Element ausgelassen", "Invalid element left out"));
      return;
    }
    const id = `c${i}`;
    const box: Box = { x, y, w: clamp(Math.abs(w), 20, LIMIT), h: clamp(Math.abs(h), 20, LIMIT) };
    const fill = fillOf(node.color);
    let item: BoardDraft | null = null;
    switch (node.type) {
      case "text":
        item = sticky(id, box, typeof node.text === "string" ? canvasText(node.text) : "", fill || "#e9ecef");
        break;
      case "file": {
        const target = str(node.file, 1000)?.trim();
        if (!target) break;
        const page = ctx.page(target);
        if (page) {
          item = { id, type: "card", x: box.x, y: box.y, w: clamp(box.w, 200, 800), h: clamp(box.h, 100, 160), pageId: page, fill: strokeOf(node.color) || "#e0782c" };
          break;
        }
        const file = ctx.file(target);
        const src = file && IMAGE.test(file.name) ? image(file.name, file.data) : null;
        if (src) item = { id, type: "image", ...box, src };
        else {
          item = sticky(id, box, `📎 ${shortName(target)}`, fill || "#e9ecef");
          skip(
            file
              ? ct(`Datei „${shortName(target)}“ als Notiz übernommen`, `File “${shortName(target)}” kept as a note`)
              : ct(`Datei „${shortName(target)}“ fehlt im Tresor`, `File “${shortName(target)}” is missing from the vault`),
            "file",
          );
        }
        break;
      }
      case "link": {
        const url = webLink(node.url);
        if (url) {
          const host = new URL(url).hostname.replace(/^www\./, "");
          item = { id, type: "embed", ...box, w: clamp(box.w, 200, 800), h: clamp(box.h, 80, 600), url, preview: { title: host, site: host } };
        } else skip(ct("Link ohne http(s)-Adresse ausgelassen", "Link without an http(s) address left out"));
        break;
      }
      case "group":
        frames.push({
          id,
          type: "frame",
          ...box,
          w: Math.max(40, box.w),
          h: Math.max(40, box.h),
          text: importText(node.label).slice(0, 200) || ct("Gruppe", "Group"),
          fill: fill || "#ffffff",
        });
        boxes.set(sourceId, box);
        ids.set(sourceId, id);
        return;
      default:
        skip(ct(`Element der Art „${String(str(node.type, 40) ?? "?")}“ ausgelassen`, `Element of type “${String(str(node.type, 40) ?? "?")}” left out`));
        return;
    }
    if (!item) {
      skip(ct("Ungültiges Element ausgelassen", "Invalid element left out"));
      return;
    }
    items.push(item);
    boxes.set(sourceId, box);
    ids.set(sourceId, id);
  });

  // Edges between nodes that came along; an end at a side sits in its middle.
  const end = (nodeId: unknown, side: unknown) => {
    const key = str(nodeId, 200);
    const box = key ? boxes.get(key) : undefined;
    if (!key || !box) return null;
    const s = typeof side === "string" && SIDES.has(side) ? side : "";
    return {
      id: ids.get(key)!,
      x: s === "left" ? box.x : s === "right" ? box.x + box.w : box.x + box.w / 2,
      y: s === "top" ? box.y : s === "bottom" ? box.y + box.h : box.y + box.h / 2,
    };
  };
  const room = Math.max(0, max - items.length - frames.length);
  const edges = canvas.edges.slice(0, room);
  if (canvas.edges.length > room)
    skip(ct(`${canvas.edges.length - room} Verbindungen über der Grenze von ${max} ausgelassen`, `${canvas.edges.length - room} connections over the limit of ${max} left out`));
  edges.forEach((raw, i) => {
    const edge = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
    const from = end(edge.fromNode, edge.fromSide),
      to = end(edge.toNode, edge.toSide);
    if (!from || !to) {
      skip(ct("Verbindung ohne ihre Elemente ausgelassen", "Connection without its elements left out"));
      return;
    }
    const label = importText(edge.label).slice(0, 500);
    items.push({
      id: `e${i}`,
      type: "connector",
      x: 0,
      y: 0,
      w: 0,
      h: 0,
      from,
      to,
      stroke: strokeOf(edge.color) || "#1f2937",
      strokeWidth: 2,
      route: "curved",
      // JSON Canvas: no arrow at the start, one at the end unless "none".
      endArrow: edge.toEnd !== "none",
      ...(edge.fromEnd === "arrow" ? { startArrow: true } : {}),
      ...(label ? { text: label } : {}),
    });
  });
  // Frames below everything else, each later one lower (lib/whiteboard-import.ts
  // placeDrafts): the smallest first, so a group inside a group stays on
  // top of it. The rest in the canvas's order.
  frames.sort((a, b) => a.w * a.h - b.w * b.h);
  return { board: { format: "canvas", items: normalise([...frames, ...items]), images, replaced }, problems };
}
