"use client";
// A shape of a library (lib/whiteboard-shapes-library.ts) on the board: the
// vector drawing as markup (the same the SVG export writes) and its texts.
import { useMemo } from "react";
import type { WhiteboardItem } from "@/lib/whiteboard-model";
import { drawLibraryShape, textAreaStyle, type TextArea } from "@/lib/whiteboard-shapes-library";

export function LibraryShapeView({ item, transform, hideText }: { item: WhiteboardItem; transform: string; hideText?: boolean }) {
  const { lib, w, h, fill, stroke, strokeWidth, text, fontSize, textColor, dashed } = item;
  const drawing = useMemo(
    () => drawLibraryShape({ lib, w, h, fill, stroke, strokeWidth, text, fontSize, textColor, dashed }),
    [lib, w, h, fill, stroke, strokeWidth, text, fontSize, textColor, dashed],
  );
  if (!drawing) return null;
  return (
    <g transform={transform} data-lib={lib}>
      <g dangerouslySetInnerHTML={{ __html: drawing.markup }} />
      {!hideText && drawing.texts.map((area, i) => <TextAreaView key={i} area={area} bold={item.bold} />)}
    </g>
  );
}
export function TextAreaView({ area, bold }: { area: TextArea; bold?: boolean }) {
  const style = textAreaStyle(area, { size: 14, color: "#1f2937", bold });
  const w = Math.max(1, area.w),
    h = Math.max(1, area.h);
  return area.vertical ? (
    <foreignObject x={0} y={0} width={h} height={w} transform={`translate(${area.x} ${area.y + area.h}) rotate(-90)`}>
      <div style={style}>{area.text}</div>
    </foreignObject>
  ) : (
    <foreignObject x={area.x} y={area.y} width={w} height={h}>
      <div style={style}>{area.text}</div>
    </foreignObject>
  );
}
// A small preview for the library panel (lines only, in the text colour).
export function LibraryPreview({ id, w, h, size = 44 }: { id: string; w: number; h: number; size?: number }) {
  const markup = useMemo(() => drawLibraryShape({ lib: id, w, h }, true, (Math.max(w, h) / size) * 1.5)?.markup || "", [id, w, h, size]);
  const pad = Math.max(w, h) * 0.06;
  return (
    <svg width={size} height={size} viewBox={`${-pad} ${-pad} ${w + pad * 2} ${h + pad * 2}`} aria-hidden="true" className="wb-lib-preview">
      <g dangerouslySetInnerHTML={{ __html: markup }} />
    </svg>
  );
}
