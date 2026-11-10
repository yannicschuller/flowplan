"use client";
// Drawing a shape item (lib/ink/shapes.ts) in the ink layer: the outline
// with its dashes and translucent fill, arrow heads solid. The same as the
// SVG export (lib/ink/svg.ts).
import { memo } from "react";
import { lineWidth } from "@/lib/ink/geometry";
import type { InkStroke } from "@/lib/ink/model";
import { dashArray, shapePaths, SHAPE_FILL_OPACITY } from "@/lib/ink/shapes";

export const InkShapeItem = memo(function InkShapeItem({ item }: { item: InkStroke }) {
  const shape = item.shape!;
  const { body, heads, closed } = shapePaths(shape, item.width);
  const width = lineWidth(item);
  const dash = dashArray(shape.dash, width);
  const fill = closed && shape.fill ? shape.fill : "none";
  return (
    <>
      <path
        d={body}
        fill={fill}
        fillOpacity={fill === "none" ? undefined : SHAPE_FILL_OPACITY}
        stroke={item.color}
        strokeWidth={width}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray={dash?.join(" ")}
      />
      {heads && <path d={heads} fill="none" stroke={item.color} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" />}
    </>
  );
});

// The attributes of the one draft path while a shape is drawn (outline and
// heads in one path; the fill shows only on closed shapes).
export function shapeDraft(stroke: InkStroke) {
  const shape = stroke.shape!;
  const { body, heads, closed } = shapePaths(shape, stroke.width);
  const width = lineWidth(stroke);
  return {
    d: body + heads,
    fill: closed && shape.fill ? shape.fill : "none",
    fillOpacity: String(SHAPE_FILL_OPACITY),
    width: String(width),
    dash: dashArray(shape.dash, width)?.join(" ") || "",
  };
}
// Applies a stroke to a draft path element (shapes and plain strokes).
export function paintDraft(el: SVGPathElement, stroke: InkStroke, plain: { d: string; fill: boolean }) {
  if (stroke.shape) {
    const a = shapeDraft(stroke);
    el.setAttribute("d", a.d);
    el.setAttribute("fill", a.fill);
    el.setAttribute("fill-opacity", a.fillOpacity);
    el.setAttribute("stroke", stroke.color);
    el.setAttribute("stroke-width", a.width);
    if (a.dash) el.setAttribute("stroke-dasharray", a.dash);
    else el.removeAttribute("stroke-dasharray");
    return;
  }
  el.removeAttribute("stroke-dasharray");
  el.removeAttribute("fill-opacity");
  el.setAttribute("d", plain.d);
  el.setAttribute("fill", plain.fill ? stroke.color : "none");
  el.setAttribute("stroke", plain.fill ? "none" : stroke.color);
  el.setAttribute("stroke-width", String(lineWidth(stroke)));
}
