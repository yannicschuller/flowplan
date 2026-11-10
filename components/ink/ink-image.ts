"use client";
// Ink items as a picture of just their area: an SVG document (lib/ink/svg.ts)
// and a PNG drawn from it in a canvas. For the system clipboard and for
// handwriting recognition by the instance's AI (components/ink/ai-convert.tsx).
import { itemBounds, unionBox, type Box } from "@/lib/ink/geometry";
import type { InkItem } from "@/lib/ink/model";
import { inkSvgElements } from "@/lib/ink/svg";

const r2 = (n: number) => Math.round(n * 100) / 100;

// The items' area with `pad` page units around it, as an SVG of `scale`
// pixels per page unit.
export function inkAreaSvg(items: InkItem[], { pad = 8, scale = 1, background = "" }: { pad?: number; scale?: number; background?: string } = {}) {
  const bounds = unionBox(items.map(itemBounds));
  if (!bounds) return null;
  const box: Box = { x: bounds.x - pad, y: bounds.y - pad, w: bounds.w + 2 * pad, h: bounds.h + 2 * pad };
  const width = Math.max(1, Math.round(box.w * scale)),
    height = Math.max(1, Math.round(box.h * scale));
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${r2(box.x)} ${r2(box.y)} ${r2(box.w)} ${r2(box.h)}" width="${width}" height="${height}">` +
    (background ? `<rect x="${r2(box.x)}" y="${r2(box.y)}" width="${r2(box.w)}" height="${r2(box.h)}" fill="${background}"/>` : "") +
    inkSvgElements(items) +
    `</svg>`;
  return { svg, box, width, height };
}

// A PNG of the items: about `target` pixels on the long side (between 1
// and 4 pixels per page unit), never more than `maxSide`.
export async function inkAreaPng(
  items: InkItem[],
  { target = 1400, maxSide = 2048, background = "#ffffff", pad = 8 }: { target?: number; maxSide?: number; background?: string; pad?: number } = {},
): Promise<{ blob: Blob; width: number; height: number } | null> {
  const bounds = unionBox(items.map(itemBounds));
  if (!bounds) return null;
  const long = Math.max(bounds.w, bounds.h) + 2 * pad;
  const scale = Math.min(maxSide / long, Math.max(1, Math.min(4, target / long)));
  const area = inkAreaSvg(items, { pad, scale, background });
  if (!area) return null;
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(area.svg)}`;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = area.width;
  canvas.height = area.height;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.drawImage(image, 0, 0, area.width, area.height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  return blob ? { blob, width: area.width, height: area.height } : null;
}

export async function blobBase64(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
