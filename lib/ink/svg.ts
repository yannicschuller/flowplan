// Ink as an SVG document, for read-only places without React: published
// pages, exports (PDF print view, EPUB, Markdown). Drawn like the ink
// layer (components/ink/ink-layer.tsx): highlighter under the ink at 40 %,
// multiplied; pen strokes with pressure as filled outlines.
import { lineWidth, strokePath } from "./geometry";
import type { InkItem } from "./model";
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

export function inkSvgElements(items: InkItem[], { dark = false }: { dark?: boolean } = {}) {
  const color = (c: string) => {
    const value = COLOR.test(c) ? c.toLowerCase() : "#1f1f1f";
    return dark ? DARK_INK[value] || value : value;
  };
  let highlights = "";
  let ink = "";
  for (const item of items) {
    if (item.type === "highlighter") {
      highlights += `<path d="${strokePath(item).d}" fill="none" stroke="${color(item.color)}" stroke-opacity="${HIGHLIGHTER_OPACITY}" stroke-width="${r2(item.width)}" stroke-linecap="round" stroke-linejoin="round"/>`;
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
      ink += `<text x="${r2(item.x)}" y="${r2(item.y + item.size * 0.8)}" font-size="${r2(item.size)}" fill="${color(item.color)}" font-family="Helvetica, Arial, sans-serif" xml:space="preserve">${lines}</text>`;
    }
  }
  return (highlights ? `<g style="mix-blend-mode:multiply">${highlights}</g>` : "") + ink;
}

// A whole picture: optional paper (SVG elements, lib/notebook-paper.ts
// paperSvg) under the ink.
export function inkSvg(items: InkItem[], size: PageSize, { paper = "", title = "", dark = false }: { paper?: string; title?: string; dark?: boolean } = {}) {
  const w = r2(size.width),
    h = r2(size.height);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img"${title ? ` aria-label="${xml(title)}"` : ""}>` +
    (title ? `<title>${xml(title)}</title>` : "") +
    paper +
    inkSvgElements(items, { dark }) +
    `</svg>`
  );
}
