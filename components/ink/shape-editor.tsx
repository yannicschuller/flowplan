"use client";
// Editing one selected shape (lib/ink/shapes.ts) on its page: handles for
// corners and ends, rotating (snaps to 15°) and resizing (squares and
// circles within 8 %), moving by its body, ends and corners pulled onto
// other shapes' corners. A bar below it changes colour, fill, dashes and
// arrow heads, turns it back into freehand, duplicates or deletes it.
//
// While a handle is dragged nothing re-renders: the shape and handles are
// repainted from a ref once per frame; the change is one undo step at the end.
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, ArrowsLeftRight, CopySimple, LineSegment, PaintBucket, Scribble, Trash } from "@phosphor-icons/react";
import { useLocale, useT } from "../i18n";
import { clientToPage, type PageSize } from "@/lib/ink/coords";
import { pageAnchors, toFreehand, withShape } from "@/lib/ink/geometry";
import type { InkItem, InkStroke } from "@/lib/ink/model";
import { PEN_COLORS } from "@/lib/ink/presets";
import { measure, type RulerUnit } from "@/lib/ink/ruler";
import {
  dragHandle,
  shapeAngle,
  shapeBounds,
  shapeHandles,
  shapePaths,
  shapeVertices,
  type InkShape,
  type InkShapeDash,
  type XY,
} from "@/lib/ink/shapes";
import type { InkEditor } from "./use-ink-editor";

type Drag = { id: string; pointer: number; from: XY; base: InkShape; shape: InkShape };

// "12,4 cm" in the reader's language.
export function formatLength(pt: number, unit: RulerUnit, locale: string) {
  const value = measure(pt, unit);
  return `${value.toLocaleString(locale, { minimumFractionDigits: unit === "in" ? 2 : 1, maximumFractionDigits: unit === "in" ? 2 : 1 })} ${unit}`;
}
export const formatAngle = (deg: number, locale: string) => `${((Math.round(deg * 10) / 10) % 360 || 0).toLocaleString(locale)}°`;

export function ShapeEditor({
  page,
  size,
  scale,
  item,
  items,
  editor,
  unit,
  onHide,
}: {
  page: string;
  size: PageSize;
  scale: number;
  item: InkStroke & { shape: InkShape };
  items: InkItem[];
  editor: InkEditor;
  unit: RulerUnit;
  onHide: (id: string | null) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const svg = useRef<SVGSVGElement>(null);
  const live = useRef<SVGPathElement>(null);
  const liveHeads = useRef<SVGPathElement>(null);
  const outline = useRef<SVGPathElement>(null);
  const readout = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const handleEls = useRef<(SVGGElement | null)[]>([]);
  const stem = useRef<SVGLineElement>(null);
  const drag = useRef<Drag | null>(null);
  const frame = useRef(0);
  const [fillOpen, setFillOpen] = useState(false);
  const px = (n: number) => n / (scale || 1);
  const reach = px(34);
  const shape = item.shape;
  const handles = useMemo(() => shapeHandles(shape, reach), [shape, reach]);
  const paths = shapePaths(shape, item.width);
  const anchors = useMemo(() => pageAnchors(items, item.id), [items, item.id]);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  function paint() {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const d = drag.current;
      if (!d) return;
      const p = shapePaths(d.shape, item.width);
      live.current?.setAttribute("d", p.body);
      liveHeads.current?.setAttribute("d", p.heads);
      outline.current?.setAttribute("d", p.body);
      shapeHandles(d.shape, reach).forEach((h, i) => handleEls.current[i]?.setAttribute("transform", `translate(${h.x} ${h.y})`));
      const rotate = shapeHandles(d.shape, reach).find((h) => h.kind === "rotate");
      if (rotate && stem.current) {
        const c = d.shape.box ? topMiddle(d.shape) : { x: rotate.x, y: rotate.y + reach * 0.6 };
        stem.current.setAttribute("x1", String(c.x));
        stem.current.setAttribute("y1", String(c.y));
        stem.current.setAttribute("x2", String(rotate.x));
        stem.current.setAttribute("y2", String(rotate.y));
      }
      const el = readout.current;
      if (el) {
        el.textContent = describe(d);
        const b = shapeBounds(d.shape, item.width);
        el.style.left = `${((b.x + b.w / 2) / size.width) * 100}%`;
        el.style.top = `calc(${((b.y + b.h) / size.height) * 100}% + 24px)`;
        el.hidden = !el.textContent;
      }
    });
  }
  function describe(d: Drag) {
    const s = d.shape;
    if (d.id === "rotate") return formatAngle(s.box ? s.box[4] : shapeAngle(s), locale);
    if (s.kind === "line") {
      const [a, b] = shapeVertices(s);
      return `${formatLength(Math.hypot(b.x - a.x, b.y - a.y), unit, locale)} · ${formatAngle(lineAngle(a, b), locale)}`;
    }
    if (s.box && d.id.startsWith("c")) return `${formatLength(s.box[2], unit, locale)} × ${formatLength(s.box[3], unit, locale)}`;
    return "";
  }

  function start(id: string) {
    return (e: React.PointerEvent) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
      const rect = svg.current!.getBoundingClientRect();
      drag.current = { id, pointer: e.pointerId, from: clientToPage(e.clientX, e.clientY, rect, size), base: shape, shape };
      setFillOpen(false);
      if (bar.current) bar.current.style.visibility = "hidden";
      onHide(item.id);
      live.current?.setAttribute("visibility", "visible");
      liveHeads.current?.setAttribute("visibility", "visible");
      paint();
    };
  }
  function move(e: React.PointerEvent) {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    e.stopPropagation();
    const rect = svg.current!.getBoundingClientRect();
    const to = clientToPage(e.clientX, e.clientY, rect, size);
    d.shape = dragHandle(d.base, d.id, d.from, to, { snap: !e.altKey, anchors, tolerance: px(12) });
    paint();
  }
  function end(e: React.PointerEvent) {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    e.stopPropagation();
    drag.current = null;
    cancelAnimationFrame(frame.current);
    live.current?.setAttribute("visibility", "hidden");
    liveHeads.current?.setAttribute("visibility", "hidden");
    if (readout.current) readout.current.hidden = true;
    if (bar.current) bar.current.style.visibility = "";
    if (d.shape !== d.base) update((s) => s === d.base ? d.shape : s);
    onHide(null);
  }
  // One undo step: the shape changed (its outline follows).
  function update(fn: (shape: InkShape) => InkShape, patch: Partial<InkStroke> = {}) {
    editor.change(page, (list) => {
      let changed = false;
      const next = list.map((i) => {
        if (i.id !== item.id || i.type !== "pen" || !i.shape) return i;
        const s = fn(i.shape);
        if (s === i.shape && !Object.keys(patch).length) return i;
        changed = true;
        return withShape({ ...i, ...patch }, s, i.points[2] ?? 0.5);
      });
      return changed ? next : list;
    });
  }
  const style = (patch: Partial<InkShape>) =>
    update((s) => {
      const next = { ...s, ...patch };
      for (const key of Object.keys(patch) as (keyof InkShape)[]) if (patch[key] === undefined) delete next[key];
      return next;
    });

  // The shape with its handles (the bar must not cover them).
  const outlineBox = shapeBounds(shape, item.width);
  const ys = handles.filter((h) => h.kind !== "rotate").map((h) => h.y);
  const bounds = { ...outlineBox, y: Math.min(outlineBox.y, ...ys), h: Math.max(outlineBox.y + outlineBox.h, ...ys) - Math.min(outlineBox.y, ...ys) };
  const percent = (v: number, of: number) => `${(v / (of || 1)) * 100}%`;
  const below = bounds.y + bounds.h + px(70) < size.height;
  const closed = shape.kind !== "line";
  const dashes: [InkShapeDash | undefined, string][] = [
    [undefined, t("Durchgezogen", "Solid")],
    ["dash", t("Gestrichelt", "Dashed")],
    ["dot", t("Gepunktet", "Dotted")],
  ];
  const dashIndex = Math.max(0, dashes.findIndex(([d]) => d === shape.dash));
  const nextDash = dashes[(dashIndex + 1) % dashes.length];
  const rotateHandle = handles.find((h) => h.kind === "rotate");
  const top = shape.box ? topMiddle(shape) : rotateHandle ? { x: rotateHandle.x, y: rotateHandle.y + reach * 0.6 } : null;
  return (
    <>
      <svg ref={svg} className="ink-shape-edit" viewBox={`0 0 ${size.width} ${size.height}`} preserveAspectRatio="none" aria-hidden="true">
        <path ref={live} d={paths.body} fill={closed && shape.fill ? shape.fill : "none"} fillOpacity={0.25} stroke={item.color} strokeWidth={Math.max(0.5, item.width)} strokeLinecap="round" strokeLinejoin="round" visibility="hidden" />
        <path ref={liveHeads} d={paths.heads} fill="none" stroke={item.color} strokeWidth={Math.max(0.5, item.width)} strokeLinecap="round" visibility="hidden" />
        <path ref={outline} className="ink-shape-outline" d={paths.body} fill="none" vectorEffect="non-scaling-stroke" />
        {/* The body: dragging it moves the shape. */}
        <path
          className="ink-ui ink-shape-body"
          d={paths.body}
          fill={closed ? "transparent" : "none"}
          stroke="transparent"
          strokeWidth={px(26)}
          onPointerDown={start("move")}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
        />
        {rotateHandle && top && <line ref={stem} className="ink-shape-stem" x1={top.x} y1={top.y} x2={rotateHandle.x} y2={rotateHandle.y} vectorEffect="non-scaling-stroke" />}
        {handles.map((h, i) => (
          <g
            key={h.id}
            ref={(el) => {
              handleEls.current[i] = el;
            }}
            className={`ink-ui ink-shape-handle ${h.kind}`}
            transform={`translate(${h.x} ${h.y})`}
            onPointerDown={start(h.id)}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={end}
          >
            <circle r={px(22)} fill="transparent" />
            <circle className="ink-handle" r={px(h.kind === "rotate" ? 7 : 6.5)} />
          </g>
        ))}
      </svg>
      <div ref={readout} className="ink-measure" hidden />
      <div
        ref={bar}
        className="ink-ui ink-selection-bar ink-shape-bar"
        role="toolbar"
        aria-label={t("Form bearbeiten", "Edit shape")}
        style={{
          left: percent(bounds.x + bounds.w / 2, size.width),
          top: below ? `calc(${percent(bounds.y + bounds.h, size.height)} + 26px)` : `calc(${percent(bounds.y, size.height)} - ${reach * scale + 56}px)`,
        }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {PEN_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            className={`ink-swatch${item.color === c ? " active" : ""}`}
            style={{ "--swatch": c } as React.CSSProperties}
            aria-label={t(`Farbe ${c}`, `Colour ${c}`)}
            aria-pressed={item.color === c}
            onClick={() => update((s) => s, { color: c })}
          />
        ))}
        {closed && (
          <span className="ink-shape-fill-anchor">
            <button type="button" aria-label={t("Füllung", "Fill")} title={t("Füllung", "Fill")} aria-expanded={fillOpen} onClick={() => setFillOpen((o) => !o)}>
              <PaintBucket size={17} weight={shape.fill ? "fill" : "regular"} color={shape.fill && shape.fill !== "#1f1f1f" ? shape.fill : undefined} />
            </button>
            {fillOpen && (
              <span className="ink-selection-bar ink-shape-fills" role="group" aria-label={t("Füllung", "Fill")}>
                <button type="button" className={`ink-swatch ink-swatch-none${!shape.fill ? " active" : ""}`} aria-label={t("Keine Füllung", "No fill")} onClick={() => style({ fill: undefined })} />
                {PEN_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className={`ink-swatch${shape.fill === c ? " active" : ""}`}
                    style={{ "--swatch": c } as React.CSSProperties}
                    aria-label={t(`Füllung ${c}`, `Fill ${c}`)}
                    onClick={() => style({ fill: c })}
                  />
                ))}
              </span>
            )}
          </span>
        )}
        <button type="button" aria-label={t(`Linie: ${nextDash[1]}`, `Line: ${nextDash[1]}`)} title={dashes[dashIndex][1]} onClick={() => style({ dash: nextDash[0] })}>
          <DashIcon dash={shape.dash} />
        </button>
        {shape.kind === "line" && (
          <button
            type="button"
            aria-label={t("Pfeilspitzen", "Arrow heads")}
            title={!shape.arrow ? t("Ohne Pfeil", "No arrow") : shape.arrow === "end" ? t("Pfeil", "Arrow") : t("Doppelpfeil", "Double arrow")}
            onClick={() => style({ arrow: !shape.arrow ? "end" : shape.arrow === "end" ? "both" : undefined })}
          >
            {!shape.arrow ? <LineSegment size={17} /> : shape.arrow === "end" ? <ArrowRight size={17} /> : <ArrowsLeftRight size={17} />}
          </button>
        )}
        <button
          type="button"
          aria-label={t("In Freihand umwandeln", "Convert to freehand")}
          title={t("In Freihand umwandeln", "Convert to freehand")}
          onClick={() => {
            editor.change(page, (list) => list.map((i) => (i.id === item.id && i.type === "pen" ? toFreehand(i) : i)));
            editor.setSelection(null);
          }}
        >
          <Scribble size={17} />
        </button>
        <button type="button" aria-label={t("Duplizieren", "Duplicate")} title={t("Duplizieren", "Duplicate")} onClick={() => editor.duplicateSelection()}>
          <CopySimple size={17} />
        </button>
        <button type="button" aria-label={t("Form löschen", "Delete shape")} title={t("Form löschen", "Delete shape")} onClick={() => editor.deleteSelection()}>
          <Trash size={17} />
        </button>
      </div>
    </>
  );
}

const lineAngle = (a: XY, b: XY) => {
  const d = (Math.atan2(-(b.y - a.y), b.x - a.x) * 180) / Math.PI;
  return Math.round((d < 0 ? d + 360 : d) * 10) / 10;
};
function topMiddle(shape: InkShape): XY {
  const [cx, cy, , h, rot] = shape.box!;
  const r = (rot * Math.PI) / 180;
  return { x: cx + (h / 2) * Math.sin(r), y: cy - (h / 2) * Math.cos(r) };
}

function DashIcon({ dash }: { dash?: InkShapeDash }) {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <line x1="2" y1="9" x2="16" y2="9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray={dash === "dash" ? "4 3" : dash === "dot" ? "0.1 3.5" : undefined} />
    </svg>
  );
}
