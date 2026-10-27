"use client";
// The minimap (bottom right, switched on in the view actions): every
// element as a small shape and the visible part of the board as a frame.
// A click or a drag moves the view there; arrow keys move it step by step.
import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import { useT } from "../i18n";
import { contentBounds } from "@/lib/whiteboard-geometry";
import type { WhiteboardItem } from "@/lib/whiteboard-model";

type View = { x: number; y: number; zoom: number };
type Rect = { x: number; y: number; w: number; h: number };
const W = 200,
  H = 136;

export function Minimap({
  items,
  byId,
  view,
  viewport,
  onCenter,
  small,
}: {
  items: WhiteboardItem[];
  byId: Map<string, WhiteboardItem>;
  view: View;
  // The visible part of the board, in board coordinates.
  viewport: Rect;
  onCenter: (point: { x: number; y: number }, animate: boolean) => void;
  small?: boolean;
}) {
  const t = useT();
  const ref = useRef<SVGSVGElement>(null);
  const dragging = useRef(false);
  const content = contentBounds(items, byId);
  // The map shows the content and the view, with some room around.
  const minX = Math.min(content?.x ?? viewport.x, viewport.x),
    minY = Math.min(content?.y ?? viewport.y, viewport.y),
    maxX = Math.max(content ? content.x + content.w : viewport.x + viewport.w, viewport.x + viewport.w),
    maxY = Math.max(content ? content.y + content.h : viewport.y + viewport.h, viewport.y + viewport.h);
  const pad = Math.max(maxX - minX, maxY - minY) * 0.05 + 40;
  const world = { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };
  const width = small ? 150 : W,
    height = small ? 100 : H;
  const scale = Math.min(width / world.w, height / world.h);
  const ox = (width - world.w * scale) / 2,
    oy = (height - world.h * scale) / 2;
  const toWorld = (e: PointerEvent) => {
    const rect = ref.current!.getBoundingClientRect();
    return { x: (e.clientX - rect.left - ox) / scale + world.x, y: (e.clientY - rect.top - oy) / scale + world.y };
  };
  const down = (e: PointerEvent<SVGSVGElement>) => {
    e.stopPropagation();
    e.preventDefault();
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    onCenter(toWorld(e), true);
  };
  const move = (e: PointerEvent<SVGSVGElement>) => {
    if (dragging.current) onCenter(toWorld(e), false);
  };
  const key = (e: KeyboardEvent) => {
    const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (!step) return;
    e.preventDefault();
    e.stopPropagation();
    onCenter(
      { x: viewport.x + viewport.w / 2 + step[0] * viewport.w * 0.25, y: viewport.y + viewport.h / 2 + step[1] * viewport.h * 0.25 },
      true,
    );
  };
  const sx = (x: number) => ox + (x - world.x) * scale,
    sy = (y: number) => oy + (y - world.y) * scale;
  return (
    <div className="wb-minimap" onPointerDown={(e) => e.stopPropagation()}>
      <svg
        ref={ref}
        width={width}
        height={height}
        role="slider"
        tabIndex={0}
        aria-label={t("Minikarte: klicken oder ziehen, um dorthin zu gehen; Pfeiltasten verschieben die Ansicht", "Minimap: click or drag to go there; arrow keys move the view")}
        aria-valuenow={Math.round(view.zoom * 100)}
        aria-valuetext={`Zoom ${Math.round(view.zoom * 100)} %`}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={() => (dragging.current = false)}
        onPointerCancel={() => (dragging.current = false)}
        onKeyDown={key}
      >
        {items.map((item) => {
          if (item.type === "connector" || item.type === "comment") return null;
          const fill =
            item.type === "frame"
              ? "var(--wb-mini-frame)"
              : item.type === "sticky"
                ? item.fill || "#fff6b6"
                : item.type === "pen"
                  ? "transparent"
                  : "var(--wb-mini-item)";
          return (
            <rect
              key={item.id}
              x={sx(item.x)}
              y={sy(item.y)}
              width={Math.max(1, item.w * scale)}
              height={Math.max(1, item.h * scale)}
              fill={fill}
              stroke={item.type === "frame" || item.type === "pen" ? "var(--wb-mini-line)" : "none"}
              strokeWidth={0.75}
            />
          );
        })}
        <rect
          className="wb-minimap-view"
          x={sx(viewport.x)}
          y={sy(viewport.y)}
          width={Math.max(2, viewport.w * scale)}
          height={Math.max(2, viewport.h * scale)}
        />
      </svg>
    </div>
  );
}
