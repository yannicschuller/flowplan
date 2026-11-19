// A region of a PDF page cut out in the PDF side panel (#392,
// components/pdf-panel.tsx) on its way into the notebook or document
// beside it: dragged there or put in with "Einfügen". The picture (a PNG
// of the page region) waits here under an id – a drag carries only the id
// (CLIP_TYPE) – and the page or notebook last worked in takes it
// (registerClipTarget). Its caption links back to the PDF page:
// `/api/files/<id>#pdf-page=<n>` opens the side panel at that page
// (components/pdf-viewer.tsx). Free of React.

export const CLIP_TYPE = "application/x-flowplan-pdf-clip";

export type PdfClip = {
  id: string;
  blob: Blob;
  // Size of the picture in pixels, and of the region in PDF points.
  width: number;
  height: number;
  points: { width: number; height: number };
  // The PDF it comes from: its address (a file of the workspace), name, page.
  src: string;
  title: string;
  page: number;
};

const clips = new Map<string, PdfClip>();
let counter = 0;
export function putClip(clip: Omit<PdfClip, "id">): PdfClip {
  const id = `clip-${Date.now().toString(36)}-${++counter}`;
  const stored = { ...clip, id };
  clips.set(id, stored);
  // Only the latest few wait (a drag that never lands does not keep them).
  for (const key of [...clips.keys()].slice(0, -5)) clips.delete(key);
  return stored;
}
export const getClip = (id: string) => clips.get(id) ?? null;

// The file id of a PDF of the workspace (shared links' files have none).
export const pdfFileId = (src: string) => /^\/api\/files\/([0-9a-f-]{36})$/i.exec(src)?.[1]?.toLowerCase() ?? null;
// The link back: the PDF's address with its page. Not the #page=n of PDF
// viewers – "#page=" is Flowplan's own address of a page (lib/app-links.ts),
// which every link handler of the app takes for an in-app link.
export const clipHref = (src: string, page: number) => `${src}#pdf-page=${Math.max(1, Math.floor(page))}`;
// A link to a page of a PDF in Flowplan: its address and page, or null.
export function pdfPageLink(href: string): { src: string; page: number } | null {
  const match = /^(\/api\/(?:files\/[\w-]+|share\/[\w-]+\/files\/[\w-]+))#pdf-page=(\d{1,6})$/.exec(href.trim());
  if (!match) return null;
  const page = Number(match[2]);
  return page >= 1 ? { src: match[1], page } : null;
}
// What a lasso drawn on a page takes: the box around it (PDF points, kept
// on the page) and whether it is a free shape – a stroke that encloses
// little of its box (a quick diagonal drag) takes the whole box. null when
// it is too small to be meant.
export type LassoPoint = { x: number; y: number };
export function lassoRegion(points: readonly LassoPoint[], page: { width: number; height: number }, minimum = 8) {
  if (points.length < 2) return null;
  const xs = points.map((p) => Math.min(page.width, Math.max(0, p.x))),
    ys = points.map((p) => Math.min(page.height, Math.max(0, p.y)));
  const box = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  if (box.w < minimum || box.h < minimum) return null;
  // The shoelace formula: the area the stroke encloses.
  let area = 0;
  for (let i = 0; i < xs.length; i++) {
    const j = (i + 1) % xs.length;
    area += xs[i] * ys[j] - xs[j] * ys[i];
  }
  const freeform = points.length > 3 && Math.abs(area) / 2 >= box.w * box.h * 0.2;
  return { box, freeform, points: freeform ? xs.map((x, i) => ({ x, y: ys[i] })) : [] };
}
// The scale a region is drawn at: sharp (about 1600 px across, 2–6 times
// the points) but within what canvases manage (12 megapixels).
export function clipScale(box: { w: number; h: number }) {
  const wanted = Math.min(6, Math.max(2, 1600 / Math.max(1, box.w)));
  return Math.min(wanted, Math.sqrt(12_000_000 / Math.max(1, box.w * box.h)));
}
// The picture's file name.
export function clipFileName(title: string, page: number) {
  const base = (title || "PDF").replace(/\.pdf$/i, "").replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 80) || "PDF";
  return `${base} – ${page}.png`;
}

// Where a clip can go: the notebook or document being worked in. The one
// touched last (pointer or focus inside it) takes "Einfügen".
export type ClipTarget = {
  id: string;
  // The area it covers on screen (for "touched").
  element: () => HTMLElement | null;
  insert: (clip: PdfClip) => Promise<boolean>;
};
const targets = new Map<string, { target: ClipTarget; at: number }>();
let tick = 0;
const changes = new Set<() => void>();
const changed = () => changes.forEach((listener) => listener());
export function registerClipTarget(target: ClipTarget) {
  targets.set(target.id, { target, at: ++tick });
  changed();
  return () => {
    if (targets.get(target.id)?.target === target) targets.delete(target.id);
    changed();
  };
}
export function touchClipTarget(id: string) {
  const entry = targets.get(id);
  if (entry) entry.at = ++tick;
}
export const onClipTargets = (listener: () => void) => {
  changes.add(listener);
  return () => void changes.delete(listener);
};
// The target that takes "Einfügen": the last touched one still on screen.
export function clipTarget(): ClipTarget | null {
  let best: { target: ClipTarget; at: number } | null = null;
  for (const entry of targets.values()) {
    const el = entry.target.element();
    if (!el?.isConnected) continue;
    if (!best || entry.at > best.at) best = entry;
  }
  return best?.target ?? null;
}
// Marks a target as touched whenever a pointer goes down or focus goes into
// its element; returns the cleanup.
export function trackClipTarget(id: string, element: HTMLElement) {
  const touch = () => touchClipTarget(id);
  element.addEventListener("pointerdown", touch, true);
  element.addEventListener("focusin", touch);
  return () => {
    element.removeEventListener("pointerdown", touch, true);
    element.removeEventListener("focusin", touch);
  };
}
