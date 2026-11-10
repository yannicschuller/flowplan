// Ink as an SVG document, for read-only places without React: published
// pages, exports (PDF print view, EPUB, Markdown). Drawn like the ink
// layer (components/ink/ink-layer.tsx): highlighter under the ink at 40 %,
// multiplied; pen strokes with pressure as filled outlines. Text names its
// face (lib/ink/fonts.ts) with fallbacks: inside Flowplan's pages the face
// itself shows, an SVG opened elsewhere uses the fallback.
import { lineWidth, strokePath } from "./geometry";
import type { InkImage, InkItem } from "./model";
import { fullBox, imageCentre } from "./image";
import { builtinSticker, stickerSvgElements } from "./stickers";
import { inkFontFamily } from "./fonts";
import { HIGHLIGHTER_OPACITY } from "./presets";
import type { PageSize } from "./coords";

const xml = (text: string) =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
const COLOR = /^#[0-9a-f]{6}$/i;
const r2 = (n: number) => Math.round(n * 100) / 100;

// The default ink colour on dark paper shows light (as on the screen).
export const DARK_INK: Record<string, string> = { "#1f1f1f": "#f1f3f5" };

// A picture or sticker: the whole picture placed where it lies, cut to the
// shown part (a nested <svg> clips without ids), turned around its centre.
// `href` is the address of the file (null: a grey box where it was).
export function imageSvgElement(item: InkImage, href: string | null) {
  const c = imageCentre(item);
  const rotate = item.rotation ? ` transform="rotate(${r2(item.rotation)} ${r2(c.x)} ${r2(c.y)})"` : "";
  const opacity = item.opacity !== undefined && item.opacity < 1 ? ` opacity="${item.opacity}"` : "";
  let body: string;
  if (item.sticker) {
    const sticker = builtinSticker(item.sticker);
    body = sticker
      ? `<svg x="${r2(item.x)}" y="${r2(item.y)}" width="${r2(item.w)}" height="${r2(item.h)}" viewBox="0 0 100 100" preserveAspectRatio="none" overflow="visible">${stickerSvgElements(sticker, item.color)}</svg>`
      : "";
  } else if (href) {
    const full = fullBox(item);
    body =
      `<svg x="${r2(item.x)}" y="${r2(item.y)}" width="${r2(item.w)}" height="${r2(item.h)}" viewBox="${r2(item.x - full.x)} ${r2(item.y - full.y)} ${r2(item.w)} ${r2(item.h)}" preserveAspectRatio="none">` +
      `<image href="${xml(href)}" x="0" y="0" width="${r2(full.w)}" height="${r2(full.h)}" preserveAspectRatio="none"/></svg>`;
  } else body = `<rect x="${r2(item.x)}" y="${r2(item.y)}" width="${r2(item.w)}" height="${r2(item.h)}" fill="#e9ecef" stroke="#adb5bd" stroke-width="1"/>`;
  return body ? `<g${rotate}${opacity}>${body}</g>` : "";
}

// Highlighter strokes lie under the ink in a layer of their own; once a
// picture lies among the items, the strokes above it are drawn in order
// (each multiplied), so they stay visible on the picture.
export function splitHighlights(items: InkItem[]) {
  const first = items.findIndex((i) => i.type === "image");
  return first < 0 ? items.length : first;
}

export function inkSvgElements(items: InkItem[], { dark = false, imageHref }: { dark?: boolean; imageHref?: (file: string) => string | null } = {}) {
  const color = (c: string) => {
    const value = COLOR.test(c) ? c.toLowerCase() : "#1f1f1f";
    return dark ? DARK_INK[value] || value : value;
  };
  let highlights = "";
  let ink = "";
  const under = splitHighlights(items);
  items.forEach((item, index) => {
    if (item.type === "highlighter") {
      const path = `<path d="${strokePath(item).d}" fill="none" stroke="${color(item.color)}" stroke-opacity="${HIGHLIGHTER_OPACITY}" stroke-width="${r2(item.width)}" stroke-linecap="round" stroke-linejoin="round"`;
      if (index < under) highlights += `${path}/>`;
      else ink += `${path} style="mix-blend-mode:multiply"/>`;
    } else if (item.type === "image") {
      ink += imageSvgElement(item, item.file ? (imageHref?.(item.file) ?? null) : null);
    } else if (item.type === "pen") {
      const { d, fill } = strokePath(item);
      ink += fill
        ? `<path d="${d}" fill="${color(item.color)}"/>`
        : `<path d="${d}" fill="none" stroke="${color(item.color)}" stroke-width="${r2(lineWidth(item))}" stroke-linecap="round" stroke-linejoin="round"/>`;
    } else if (item.type === "text") {
      const lines = item.text
        .split("\n")
        .map((line, i) => `<tspan x="${r2(item.x)}" dy="${i ? r2(item.size * 1.25) : 0}">${xml(line) || " "}</tspan>`)
        .join("");
      ink += `<text x="${r2(item.x)}" y="${r2(item.y + item.size * 0.8)}" font-size="${r2(item.size)}" fill="${color(item.color)}" font-family="${xml(inkFontFamily(item.font))}"${item.rotation ? ` transform="rotate(${r2(item.rotation)} ${r2(item.x)} ${r2(item.y)})"` : ""} xml:space="preserve">${lines}</text>`;
    }
  });
  return (highlights ? `<g style="mix-blend-mode:multiply">${highlights}</g>` : "") + ink;
}

// A whole picture: optional paper (SVG elements, lib/notebook-paper.ts
// paperSvg) under the ink.
export function inkSvg(
  items: InkItem[],
  size: PageSize,
  { paper = "", title = "", dark = false, imageHref }: { paper?: string; title?: string; dark?: boolean; imageHref?: (file: string) => string | null } = {},
) {
  const w = r2(size.width),
    h = r2(size.height);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img"${title ? ` aria-label="${xml(title)}"` : ""}>` +
    (title ? `<title>${xml(title)}</title>` : "") +
    paper +
    inkSvgElements(items, { dark, imageHref }) +
    `</svg>`
  );
}
