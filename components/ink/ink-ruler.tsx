"use client";
// The ruler on a page (lib/ink/ruler.ts): a ruler, a set square with a
// protractor (Geodreieck) or a compass, lying on the paper in its real
// scale. Fingers (or the mouse) move it, two fingers turn it (snapping to
// 0/15/30/45/60/90°); the pen draws along its edges (`rulerGuide`, used by
// the ink layer) – a stroke beginning near an edge follows it, with its
// length shown. The compass draws arcs and circles of its radius.
//
// Moving repaints from a ref once per frame; the store (components/ink/
// ink-stores.ts) changes once at the end.
import { forwardRef, useEffect, useMemo, useRef } from "react";
import { useLocale, useT } from "../i18n";
import { clientToPage, type PageSize } from "@/lib/ink/coords";
import { withShape } from "@/lib/ink/geometry";
import type { InkItem, InkStroke } from "@/lib/ink/model";
import {
  anglesBetween,
  angleAt,
  arcPoints,
  compassPoint,
  defaultUnit,
  edgeNear,
  projectOnLine,
  protractorReading,
  raysThrough,
  rulerPoint,
  rulerSize,
  rulerTicks,
  shownAngle,
  snapRadius,
  snapRulerAngle,
  straightSegments,
  unwrapAngle,
  type RulerState,
  type RulerUnit,
  type Segment,
} from "@/lib/ink/ruler";
import { normDeg, type XY } from "@/lib/ink/shapes";
import { palmLikely } from "@/lib/stylus";
import { chosenUnit, setRuler } from "./ink-stores";
import { formatAngle, formatLength } from "./shape-editor";

const MIN_THICKNESS_PX = 76;
// How near an edge (or the compass's circle) a stroke has to begin, on the screen.
const REACH_PX = 26;

// A stroke drawn along the tool: each pen point mapped onto the edge or
// the circle; `label` the measure shown while drawing; `finish` the stroke
// as kept (a full circle becomes a circle shape).
export type InkGuide = { map: (p: XY) => XY[]; label: () => string; finish?: (stroke: InkStroke) => InkStroke };

export function rulerGuide(state: RulerState | null, size: PageSize, scale: number, start: XY, locale: string): InkGuide | null {
  if (!state || Number.isNaN(state.x)) return null;
  const px = (n: number) => n / (scale || 1);
  if (state.mode === "compass") {
    const d = Math.hypot(start.x - state.x, start.y - state.y);
    if (Math.abs(d - state.radius) > px(REACH_PX) * 1.5) return null;
    const first = angleAt(state, start);
    let last = first;
    return {
      map(p) {
        const a = unwrapAngle(last, angleAt(state, p));
        const points = Math.abs(a - last) > 2 ? arcPoints(state, last, a).slice(1) : [compassPoint(state, a)];
        last = a;
        return points;
      },
      label: () => `r ${formatLength(state.radius, state.unit, locale)} · ${formatAngle(Math.min(360, Math.round(Math.abs(last - first))), locale)}`,
      finish(stroke) {
        if (Math.abs(last - first) < 355) return stroke;
        return withShape(stroke, { kind: "ellipse", box: [state.x, state.y, state.radius * 2, state.radius * 2, 0] }, stroke.points[2] ?? 0.5);
      },
    };
  }
  const edge = edgeNear(state, size, start, px(REACH_PX), px(MIN_THICKNESS_PX));
  if (!edge) return null;
  const len = Math.hypot(edge.b.x - edge.a.x, edge.b.y - edge.a.y) || 1;
  const along = (q: XY) => ((q.x - edge.a.x) * (edge.b.x - edge.a.x) + (q.y - edge.a.y) * (edge.b.y - edge.a.y)) / len;
  let min = Infinity,
    max = -Infinity;
  return {
    map(p) {
      const q = projectOnLine(p, edge.a, edge.b);
      const t = along(q);
      min = Math.min(min, t);
      max = Math.max(max, t);
      return [q];
    },
    label: () => formatLength(max - min, state.unit, locale),
  };
}

type Move = {
  pointers: Map<number, XY>;
  base: RulerState;
  anchor: Map<number, XY>;
  kind: "move" | "radius";
  current: RulerState;
};

export function InkRuler({ page, size, scale, state, items }: { page: string; size: PageSize; scale: number; state: RulerState; items: InkItem[] }) {
  const t = useT();
  const locale = useLocale();
  const svg = useRef<SVGSVGElement>(null);
  const group = useRef<SVGGElement>(null);
  const measures = useRef<SVGGElement>(null);
  const arm = useRef<SVGLineElement>(null);
  const knob = useRef<SVGGElement>(null);
  const circle = useRef<SVGCircleElement>(null);
  const label = useRef<HTMLDivElement>(null);
  const angleText = useRef<SVGTextElement>(null);
  const chip = useRef<HTMLElement | null>(null);
  const move = useRef<Move | null>(null);
  const frame = useRef(0);
  const px = (n: number) => n / (scale || 1);
  const placed = !Number.isNaN(state.x);

  // Placed in the middle of the part of the page in view.
  useEffect(() => {
    if (placed || !svg.current) return;
    const rect = svg.current.getBoundingClientRect();
    const left = Math.max(rect.left, 0),
      right = Math.min(rect.right, window.innerWidth);
    const top = Math.max(rect.top, 0),
      bottom = Math.min(rect.bottom, window.innerHeight);
    const centre = clientToPage(right > left ? (left + right) / 2 : rect.left + rect.width / 2, bottom > top ? (top + bottom) / 2 : rect.top + rect.height / 2, rect, size);
    setRuler({ ...state, x: centre.x, y: centre.y, unit: chosenUnit() ?? defaultUnit(size) });
  }, [placed, state, size]);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const { length, thickness } = rulerSize(state, size, px(MIN_THICKNESS_PX));
  const other: RulerUnit = state.unit === "cm" ? "in" : "cm";
  const ticks = useMemo(() => rulerTicks(length, state.unit, scale), [length, state.unit, scale]);
  const otherTicks = useMemo(() => rulerTicks(length, other, scale), [length, other, scale]);
  const halfTicks = useMemo(() => rulerTicks(length / 2, state.unit, scale), [length, state.unit, scale]);
  const segments = useMemo(() => (state.mode === "protractor" ? straightSegments(items) : []), [items, state.mode]);
  const rays = useMemo(() => (state.mode === "protractor" && placed ? raysThrough(segments, state, px(9)) : []), [segments, state, placed, scale]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!placed) return <svg ref={svg} className="ink-ruler-layer" viewBox={`0 0 ${size.width} ${size.height}`} aria-hidden="true" />;

  const transformOf = (s: RulerState) => `translate(${s.x} ${s.y}) rotate(${s.angle})`;
  function paint() {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const m = move.current;
      if (!m) return;
      const s = m.current;
      group.current?.setAttribute("transform", transformOf(s));
      if (angleText.current) angleText.current.textContent = formatAngle(shownAngle(s.angle), locale);
      if (s.mode === "compass") {
        arm.current?.setAttribute("x2", String(s.radius));
        knob.current?.setAttribute("transform", `translate(${s.radius} 0)`);
        circle.current?.setAttribute("r", String(s.radius));
      }
      const el = label.current;
      if (el) {
        const at = s.mode === "compass" ? compassPoint(s, s.angle) : { x: s.x, y: s.y };
        el.textContent = s.mode === "compass" ? `r ${formatLength(s.radius, s.unit, locale)}` : formatAngle(shownAngle(s.angle), locale);
        el.style.left = `${(at.x / size.width) * 100}%`;
        el.style.top = `${(at.y / size.height) * 100}%`;
        el.hidden = false;
      }
    });
  }
  const pagePoint = (e: { clientX: number; clientY: number }) => clientToPage(e.clientX, e.clientY, svg.current!.getBoundingClientRect(), size);

  function down(kind: Move["kind"]) {
    return (e: React.PointerEvent) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      const p = pagePoint(e);
      // The pen at an edge draws along it (the ink layer below takes it).
      if (e.pointerType === "pen" && kind === "move" && rulerGuide(state, size, scale, p, locale)) return;
      e.stopPropagation();
      e.preventDefault();
      if (palmLikely(e)) return;
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
      const m = move.current;
      if (m && m.pointers.size < 2 && m.kind === "move") {
        // A second finger: from here on it turns the tool.
        m.base = m.current;
        m.pointers.set(e.pointerId, p);
        m.anchor = new Map(m.pointers);
        return;
      }
      if (m) return;
      move.current = { pointers: new Map([[e.pointerId, p]]), anchor: new Map([[e.pointerId, p]]), base: state, current: state, kind };
      if (measures.current) measures.current.style.display = "none";
      if (chip.current) chip.current.style.visibility = "hidden";
      paint();
    };
  }
  function moved(e: React.PointerEvent) {
    const m = move.current;
    if (!m || !m.pointers.has(e.pointerId)) return;
    e.stopPropagation();
    const p = pagePoint(e);
    m.pointers.set(e.pointerId, p);
    const b = m.base;
    if (m.kind === "radius") {
      const radius = snapRadius(Math.hypot(p.x - b.x, p.y - b.y), b.unit);
      m.current = { ...b, radius, angle: e.altKey ? angleAt(b, p) : snapRulerAngle(angleAt(b, p), 2) };
    } else if (m.pointers.size === 1) {
      const [id] = m.pointers.keys();
      const a = m.anchor.get(id)!;
      m.current = { ...b, x: b.x + p.x - a.x, y: b.y + p.y - a.y };
    } else {
      const [i, j] = [...m.pointers.keys()];
      const a0 = m.anchor.get(i)!,
        b0 = m.anchor.get(j)!;
      const a1 = m.pointers.get(i)!,
        b1 = m.pointers.get(j)!;
      const turn = angleAt(a0, b0) - angleAt(a1, b1);
      const angle = snapRulerAngle(b.angle - turn);
      const delta = angle - b.angle;
      // Turned about the fingers' middle, which follows them.
      const mid0 = { x: (a0.x + b0.x) / 2, y: (a0.y + b0.y) / 2 },
        mid1 = { x: (a1.x + b1.x) / 2, y: (a1.y + b1.y) / 2 };
      const r = (delta * Math.PI) / 180;
      const dx = b.x - mid0.x,
        dy = b.y - mid0.y;
      m.current = { ...b, angle: normDeg(angle), x: mid1.x + dx * Math.cos(r) - dy * Math.sin(r), y: mid1.y + dx * Math.sin(r) + dy * Math.cos(r) };
    }
    paint();
  }
  function up(e: React.PointerEvent) {
    const m = move.current;
    if (!m || !m.pointers.has(e.pointerId)) return;
    e.stopPropagation();
    m.pointers.delete(e.pointerId);
    if (m.pointers.size) {
      // One finger stays: it moves on from here.
      m.base = m.current;
      m.anchor = new Map(m.pointers);
      return;
    }
    move.current = null;
    cancelAnimationFrame(frame.current);
    if (label.current) label.current.hidden = true;
    if (measures.current) measures.current.style.display = "";
    if (chip.current) chip.current.style.visibility = "";
    let next = m.current;
    // The protractor's zero point snaps onto where two lines cross.
    if (next.mode === "protractor") {
      const hit = crossingNear(segments, next, px(16));
      if (hit) next = { ...next, x: hit.x, y: hit.y };
    }
    setRuler(next);
  }
  const handlers = (kind: Move["kind"]) => ({ onPointerDown: down(kind), onPointerMove: moved, onPointerUp: up, onPointerCancel: up });
  const toggleUnit = (e: React.PointerEvent | React.MouseEvent) => {
    e.stopPropagation();
    setRuler({ ...state, unit: other });
  };
  const font = px(10.5);
  const tickLength = (level: number) => px(level === 3 ? 14 : level === 2 ? 9 : 5);

  return (
    <>
      <svg ref={svg} className="ink-ruler-layer" viewBox={`0 0 ${size.width} ${size.height}`} preserveAspectRatio="none" aria-label={t("Lineal", "Ruler")} role="img">
        <g ref={group} transform={transformOf(state)}>
          {state.mode === "ruler" && (
            <g className="ink-ruler-body" {...handlers("move")}>
              <rect x={-length / 2} y={-thickness / 2} width={length} height={thickness} rx={px(6)} vectorEffect="non-scaling-stroke" />
              {ticks.map((k) => (
                <line key={`a${k.at}`} x1={-length / 2 + k.at} x2={-length / 2 + k.at} y1={-thickness / 2} y2={-thickness / 2 + tickLength(k.level)} className="ink-ruler-tick" vectorEffect="non-scaling-stroke" />
              ))}
              {ticks.map((k) =>
                k.label ? (
                  <text key={`l${k.at}`} x={-length / 2 + k.at} y={-thickness / 2 + tickLength(3) + font * 1.05} fontSize={font} textAnchor="middle" className="ink-ruler-text">
                    {k.label}
                  </text>
                ) : null,
              )}
              {otherTicks.map((k) => (
                <line key={`b${k.at}`} x1={-length / 2 + k.at} x2={-length / 2 + k.at} y1={thickness / 2} y2={thickness / 2 - tickLength(k.level) * 0.8} className="ink-ruler-tick" vectorEffect="non-scaling-stroke" />
              ))}
              {otherTicks.map((k) =>
                k.label ? (
                  <text key={`m${k.at}`} x={-length / 2 + k.at} y={thickness / 2 - tickLength(3) * 0.8 - font * 0.35} fontSize={font * 0.85} textAnchor="middle" className="ink-ruler-text faint">
                    {k.label}
                  </text>
                ) : null,
              )}
              <text ref={angleText} x={0} y={font * 0.4} fontSize={font * 1.25} textAnchor="middle" className="ink-ruler-text strong">
                {formatAngle(shownAngle(state.angle), locale)}
              </text>
            </g>
          )}
          {state.mode === "protractor" && (
            <g className="ink-ruler-body" {...handlers("move")}>
              <path d={`M${-length / 2} 0L${length / 2} 0L0 ${-length / 2}Z`} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
              {halfTicks.flatMap((k) =>
                [1, -1].map((side) => (
                  <line key={`${side}${k.at}`} x1={side * k.at} x2={side * k.at} y1={0} y2={-tickLength(k.level)} className="ink-ruler-tick" vectorEffect="non-scaling-stroke" />
                )),
              )}
              {halfTicks.flatMap((k) =>
                // Not where the degree scale meets the edge.
                k.label && k.at > 0 && k.at < length / 2 - px(14) && Math.abs(k.at - length * 0.31) > px(22)
                  ? [1, -1].map((side) => (
                      <text key={`t${side}${k.at}`} x={side * k.at} y={-tickLength(3) - font * 0.3} fontSize={font} textAnchor="middle" className="ink-ruler-text">
                        {k.label}
                      </text>
                    ))
                  : [],
              )}
              <ProtractorScale radius={length * 0.31} px={px} font={font} scale={scale} />
              <circle r={px(3)} className="ink-ruler-centre" />
              <text ref={angleText} x={0} y={-length * 0.12} fontSize={font * 1.2} textAnchor="middle" className="ink-ruler-text strong">
                {formatAngle(shownAngle(state.angle), locale)}
              </text>
            </g>
          )}
          {state.mode === "compass" && (
            <g className="ink-compass">
              <circle ref={circle} r={state.radius} className="ink-compass-circle" vectorEffect="non-scaling-stroke" />
              <line ref={arm} x1={0} y1={0} x2={state.radius} y2={0} className="ink-compass-arm" vectorEffect="non-scaling-stroke" />
              <line x1={0} y1={0} x2={state.radius} y2={0} stroke="transparent" strokeWidth={px(22)} className="ink-ruler-grab" {...handlers("move")} />
              <g className="ink-ruler-grab" {...handlers("move")}>
                <circle r={px(22)} fill="transparent" />
                <circle r={px(6)} className="ink-compass-needle" />
              </g>
              <g ref={knob} transform={`translate(${state.radius} 0)`} className="ink-ruler-grab" {...handlers("radius")}>
                <circle r={px(22)} fill="transparent" />
                <circle r={px(8)} className="ink-handle" />
              </g>
            </g>
          )}
        </g>
        {state.mode === "protractor" && <Measures ref={measures} rays={rays} state={state} px={px} locale={locale} />}
      </svg>
      {state.mode !== "compass" ? (
        <button
          ref={(el) => {
            chip.current = el;
          }}
          type="button"
          className="ink-ui ink-ruler-unit"
          style={unitButtonStyle(state, size, state.mode === "ruler" ? rulerPoint(state, length / 2 - px(28), 0) : rulerPoint(state, 0, -length * 0.4))}
          aria-label={t(`Einheit: ${state.unit}`, `Unit: ${state.unit}`)}
          title={t("Einheit wechseln", "Change unit")}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={toggleUnit}
        >
          {state.unit}
        </button>
      ) : (
        <div
          ref={(el) => {
            chip.current = el;
          }}
          className="ink-measure ink-ruler-radius" style={unitButtonStyle(state, size, compassPoint(state, state.angle))}>
          r {formatLength(state.radius, state.unit, locale)}
        </div>
      )}
      <div ref={label} className="ink-measure" hidden />
    </>
  );
}
const unitButtonStyle = (_state: RulerState, size: PageSize, at: XY): React.CSSProperties => ({ left: `${(at.x / size.width) * 100}%`, top: `${(at.y / size.height) * 100}%` });

// The degree scale of the protractor: 0° at the right, 180° at the left.
function ProtractorScale({ radius, px, font, scale }: { radius: number; px: (n: number) => number; font: number; scale: number }) {
  const step = radius * scale * (Math.PI / 180) >= 3 ? 1 : 5;
  const marks = [];
  for (let d = 0; d <= 180; d += step) {
    const r = (d * Math.PI) / 180;
    const len = px(d % 10 === 0 ? 10 : d % 5 === 0 ? 7 : 4);
    const [c, s] = [Math.cos(r), -Math.sin(r)];
    marks.push(<line key={d} x1={c * radius} y1={s * radius} x2={c * (radius - len)} y2={s * (radius - len)} className="ink-ruler-tick" vectorEffect="non-scaling-stroke" />);
    if (d % (radius * scale > 120 ? 10 : 30) === 0 && d >= 20 && d <= 160)
      marks.push(
        <text key={`t${d}`} x={c * (radius - px(10) - font)} y={s * (radius - px(10) - font) + font * 0.35} fontSize={font * 0.9} textAnchor="middle" className="ink-ruler-text">
          {d}
        </text>,
      );
  }
  return (
    <g>
      <path d={`M${radius} 0A${radius} ${radius} 0 0 0 ${-radius} 0`} fill="none" className="ink-ruler-tick" vectorEffect="non-scaling-stroke" />
      <line x1={0} y1={0} x2={0} y2={-radius} className="ink-ruler-tick faint" vectorEffect="non-scaling-stroke" />
      {marks}
    </g>
  );
}

// Angles between the lines through the protractor's zero point.
function MeasuresBase(
  { rays, state, px, locale }: { rays: number[]; state: RulerState; px: (n: number) => number; locale: string },
  ref: React.Ref<SVGGElement>,
) {
  const arcs = anglesBetween(rays).filter((a) => a.sweep > 0.5 && a.sweep < 180);
  const radius = px(34);
  return (
    <g ref={ref} className="ink-ruler-measures">
      {rays.map((r) => {
        const reading = protractorReading(state, r);
        const end = { x: state.x + Math.cos((r * Math.PI) / 180) * px(70), y: state.y + Math.sin((r * Math.PI) / 180) * px(70) };
        return (
          <g key={r}>
            <line x1={state.x} y1={state.y} x2={end.x} y2={end.y} className="ink-ruler-ray" vectorEffect="non-scaling-stroke" />
            {reading !== null && rays.length === 1 && (
              <text x={end.x} y={end.y - px(6)} fontSize={px(12)} textAnchor="middle" className="ink-ruler-text strong">
                {formatAngle(reading, locale)}
              </text>
            )}
          </g>
        );
      })}
      {arcs.slice(0, 4).map((a, i) => {
        const r0 = (a.from * Math.PI) / 180,
          r1 = ((a.from + a.sweep) * Math.PI) / 180,
          mid = ((a.from + a.sweep / 2) * Math.PI) / 180;
        const rr = radius + i * px(4);
        const p0 = { x: state.x + Math.cos(r0) * rr, y: state.y + Math.sin(r0) * rr };
        const p1 = { x: state.x + Math.cos(r1) * rr, y: state.y + Math.sin(r1) * rr };
        return (
          <g key={a.from}>
            <path d={`M${p0.x} ${p0.y}A${rr} ${rr} 0 0 1 ${p1.x} ${p1.y}`} fill="none" className="ink-ruler-arc" vectorEffect="non-scaling-stroke" />
            <text x={state.x + Math.cos(mid) * (rr + px(18))} y={state.y + Math.sin(mid) * (rr + px(18)) + px(4)} fontSize={px(12)} textAnchor="middle" className="ink-ruler-text strong measure">
              {formatAngle(a.sweep, locale)}
            </text>
          </g>
        );
      })}
    </g>
  );
}
const Measures = forwardRef(MeasuresBase);

// Where two straight lines cross near p, if anywhere.
function crossingNear(segments: Segment[], p: XY, reach: number): XY | null {
  const near = segments.filter((s) => Math.hypot(projectOnLine(p, s.a, s.b).x - p.x, projectOnLine(p, s.a, s.b).y - p.y) < reach * 3);
  let best: XY | null = null;
  let distance = reach;
  for (let i = 0; i < near.length; i++)
    for (let j = i + 1; j < near.length; j++) {
      const a = near[i],
        b = near[j];
      const d1 = { x: a.b.x - a.a.x, y: a.b.y - a.a.y },
        d2 = { x: b.b.x - b.a.x, y: b.b.y - b.a.y };
      const cross = d1.x * d2.y - d1.y * d2.x;
      if (Math.abs(cross) < 1e-6) continue;
      const tt = ((b.a.x - a.a.x) * d2.y - (b.a.y - a.a.y) * d2.x) / cross;
      const q = { x: a.a.x + tt * d1.x, y: a.a.y + tt * d1.y };
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d < distance) {
        distance = d;
        best = q;
      }
    }
  return best;
}
