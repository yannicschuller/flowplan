// Paper drawn small (the paper dialog's tiles and preview, components/notebook/paper.tsx
// PaperSvg `thumb`): at 50 px across a sheet, a 0.5 pt rule is a few
// hundredths of a pixel and vanishes. Lines and dots get a minimum width in
// screen pixels, and the view can show only the top left part of the sheet
// (`crop`: the share of width and height shown) so the ruling stays legible.
import type { PaperLayout } from "./notebook-paper";

export type PaperThumb = { px: number; minStroke?: number; crop?: number };

export function thumbLayout(layout: PaperLayout, { px, minStroke = 0.75, crop = 1 }: PaperThumb) {
  const share = Math.min(1, Math.max(0.1, crop));
  const viewWidth = layout.width * share,
    viewHeight = layout.height * share;
  // Page units per screen pixel at that size.
  const unit = px > 0 ? viewWidth / px : 1;
  const min = minStroke * unit;
  const shapes = layout.shapes.map((s) =>
    s.type === "line" ? { ...s, width: Math.max(s.width, min) } : { ...s, r: Math.max(s.r, min * 0.7) },
  );
  return { layout: { ...layout, shapes }, viewBox: `0 0 ${Math.round(viewWidth * 100) / 100} ${Math.round(viewHeight * 100) / 100}` };
}
