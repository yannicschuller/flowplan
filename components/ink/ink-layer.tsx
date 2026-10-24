"use client";
// The ink of one page, drawn over any page surface (a PDF page, paper, an
// image): place it in a positioned box the size of the page. Without an
// editor (or with `editing` off) it only shows the ink; with one, it takes
// the pen, mouse and – unless pen-only drawing is on – fingers.
//
// Ink is SVG in page units (viewBox = page size), so it stays sharp at any
// zoom and is never redrawn for a new zoom. Highlighter strokes sit in a
// layer of their own under the ink, multiplied with the page.
//
// Input (lib/stylus.ts): pressure, coalesced points, palm rejection, pen-only
// drawing (fingers scroll and zoom the page), the eraser end of a pen,
// Scribble into the text field, no text selection, callout or page scroll
// while the pen draws. Holding the pen still at the end of a stroke snaps it
// to a line or shape.
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { ArrowsOutSimple, Copy, CopySimple, Trash } from "@phosphor-icons/react";
import { useT } from "../i18n";
import { clientToPage, type PageSize } from "@/lib/ink/coords";
import {
  eraseItems,
  erasePartial,
  flatPoints,
  hitItem,
  heldStill,
  itemBounds,
  lassoItems,
  lineWidth,
  polylinePath,
  snapStroke,
  strokePath,
  transformItems,
  unionBox,
  type Box,
  type Pt,
} from "@/lib/ink/geometry";
import { inkId, type InkDoc, type InkItem, type InkStroke, type InkText } from "@/lib/ink/model";
import { HIGHLIGHTER_OPACITY, PEN_COLORS } from "@/lib/ink/presets";
import {
  drawsWith,
  isEraser,
  notePen,
  notePenActivity,
  palmLikely,
  pushPressure,
  samples,
  stillWriting,
  writingInField,
  type PressureTrack,
} from "@/lib/stylus";
import type { InkEditor } from "./use-ink-editor";

type XY = { x: number; y: number };
// How long the pen rests at the end of a stroke before it snaps (ms).
const HOLD_MS = 550;
const LASER_MS = 700;

type Gesture =
  | { kind: "draw"; pointer: number; type: string; stroke: InkStroke; raw: Pt[]; track: PressureTrack; timed: (XY & { t: number })[]; anchor: XY; snapped: boolean }
  | { kind: "erase"; pointer: number; partial: boolean; items: InkItem[] }
  | { kind: "lasso"; pointer: number; polygon: XY[] }
  | { kind: "move"; pointer: number; start: XY; ids: Set<string>; base: InkItem[] }
  | { kind: "scale"; pointer: number; origin: XY; start: number; ids: Set<string>; base: InkItem[] }
  | { kind: "laser"; pointer: number }
  | { kind: "tap"; pointer: number; client: XY; at: XY }
  | { kind: "pan"; touches: Map<number, XY>; distance: number; zoom: number };

// The ink of a page, back to front: highlighter strokes in one layer, the rest in another.
const InkItems = memo(function InkItems({ items, layer }: { items: InkItem[]; layer: "highlight" | "ink" }) {
  return (
    <>
      {items.map((item) => {
        if (layer === "highlight") {
          if (item.type !== "highlighter") return null;
          const { d } = strokePath(item);
          return (
            <path
              key={item.id}
              d={d}
              fill="none"
              stroke={item.color}
              strokeOpacity={HIGHLIGHTER_OPACITY}
              strokeWidth={item.width}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          );
        }
        if (item.type === "highlighter") return null;
        if (item.type === "text") return <InkTextItem key={item.id} item={item} />;
        const { d, fill } = strokePath(item);
        return fill ? (
          <path key={item.id} d={d} fill={item.color} />
        ) : (
          <path key={item.id} d={d} fill="none" stroke={item.color} strokeWidth={lineWidth(item)} strokeLinecap="round" strokeLinejoin="round" />
        );
      })}
    </>
  );
});
function InkTextItem({ item }: { item: InkText }) {
  return (
    <text
      x={item.x}
      y={item.y + item.size * 0.8}
      fontSize={item.size}
      fill={item.color}
      fontFamily="Helvetica, Arial, sans-serif"
      style={{ whiteSpace: "pre" }}
    >
      {item.text.split("\n").map((line, i) => (
        <tspan key={i} x={item.x} dy={i ? item.size * 1.25 : 0}>
          {line || " "}
        </tspan>
      ))}
    </text>
  );
}

export function InkLayer({
  page,
  size,
  editor,
  editing = false,
  doc,
  onPan,
  onZoom,
}: {
  page: string;
  size: PageSize;
  editor?: InkEditor | null;
  editing?: boolean;
  doc?: InkDoc | null;
  // Two fingers while fingers draw (pen-only drawing off): scroll and zoom.
  onPan?: (dx: number, dy: number) => void;
  onZoom?: (factor: number) => void;
}) {
  const t = useT();
  const active = !!editor && editing;
  const stored = (editor ? editor.doc : doc)?.pages[page];
  const items = useMemo(() => stored || [], [stored]);
  const root = useRef<HTMLDivElement>(null);
  const draftInk = useRef<SVGPathElement>(null);
  const draftHighlight = useRef<SVGPathElement>(null);
  const lassoPath = useRef<SVGPathElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const frame = useRef(0);
  // CSS pixels per page unit.
  const [scale, setScale] = useState(1);
  // Items while erasing, moving or resizing (one undo step at the end).
  const [preview, setPreviewState] = useState<InkItem[] | null>(null);
  const previewRef = useRef<InkItem[] | null>(null);
  const setPreview = (next: InkItem[] | null) => {
    previewRef.current = next;
    setPreviewState(next);
  };
  type Typing = { id: string | null; x: number; y: number; size: number; color: string; text: string };
  const [typing, setTypingState] = useState<Typing | null>(null);
  // The field can end twice (Enter, then blur as it goes): only once counts.
  const typingRef = useRef<Typing | null>(null);
  const setTyping = (next: Typing | null) => {
    typingRef.current = next;
    setTypingState(next);
  };
  const [laser, setLaser] = useState<(XY & { t: number })[]>([]);
  const editorRef = useRef(editor);
  editorRef.current = editor;

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const measure = () => setScale(el.clientWidth / (size.width || 1) || 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [size.width]);

  // A pen on the page never scrolls it, selects text or opens the callout;
  // with pen-only drawing off, neither does a finger. pointerdown comes
  // before touchstart, so the gesture already knows what touches.
  const penOnly = editor?.penOnly ?? true;
  useEffect(() => {
    const el = root.current;
    if (!el || !active) return;
    const block = (event: TouchEvent) => {
      if (!event.cancelable || (event.target as Element | null)?.closest?.(".ink-ui")) return;
      const stylus = [...event.touches].some((touch) => (touch as Touch & { touchType?: string }).touchType === "stylus");
      const g = gesture.current;
      // A palm next to the pen (also on another page) does not scroll the pages away under it.
      const palm = palmLikely({ pointerType: "touch" });
      if (stylus || (g && g.kind !== "tap") || !penOnly || palm) event.preventDefault();
    };
    el.addEventListener("touchstart", block, { passive: false });
    el.addEventListener("touchmove", block, { passive: false });
    return () => {
      el.removeEventListener("touchstart", block);
      el.removeEventListener("touchmove", block);
    };
  }, [active, penOnly]);

  // The laser trail fades.
  useEffect(() => {
    if (!laser.length) return;
    const id = requestAnimationFrame(() => setLaser((list) => list.filter((p) => Date.now() - p.t < LASER_MS)));
    return () => cancelAnimationFrame(id);
  }, [laser]);

  useEffect(
    () => () => {
      if (holdTimer.current) clearTimeout(holdTimer.current);
      cancelAnimationFrame(frame.current);
    },
    [],
  );
  // Leaving editing ends what is in progress.
  useEffect(() => {
    if (active) return;
    gesture.current = null;
    setPreview(null);
    setTyping(null);
  }, [active]);

  const toPage = (clientX: number, clientY: number) => clientToPage(clientX, clientY, root.current!.getBoundingClientRect(), size);
  const tolerance = (px: number) => px / scale;

  function drawDraft() {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const g = gesture.current;
      if (g?.kind === "draw") {
        const { d, fill } = strokePath(g.stroke);
        const el = g.stroke.type === "highlighter" ? draftHighlight.current : draftInk.current;
        if (!el) return;
        el.setAttribute("d", d);
        el.setAttribute("fill", fill ? g.stroke.color : "none");
        el.setAttribute("stroke", fill ? "none" : g.stroke.color);
        el.setAttribute("stroke-width", String(lineWidth(g.stroke)));
      } else if (g?.kind === "lasso") lassoPath.current?.setAttribute("d", polylinePath(g.polygon) + (g.polygon.length > 2 ? "Z" : ""));
    });
  }
  function clearDraft() {
    cancelAnimationFrame(frame.current);
    for (const el of [draftInk.current, draftHighlight.current, lassoPath.current]) el?.setAttribute("d", "");
  }
  function armSnap() {
    if (holdTimer.current) clearTimeout(holdTimer.current);
    holdTimer.current = setTimeout(() => {
      const g = gesture.current;
      if (g?.kind !== "draw" || g.snapped || !editorRef.current?.snap) return;
      if (!heldStill(g.timed, Date.now(), HOLD_MS - 50, tolerance(4))) return;
      const snapped = snapStroke(g.stroke);
      if (!snapped) return;
      g.stroke = snapped;
      g.snapped = true;
      drawDraft();
    }, HOLD_MS);
  }
  function eraseWith(g: Extract<Gesture, { kind: "erase" }>, path: XY[]) {
    const radius = tolerance(g.partial ? 10 : 6);
    const next = g.partial ? erasePartial(g.items, path, radius) : eraseItems(g.items, path, radius);
    if (next !== g.items) {
      g.items = next;
      setPreview(next);
    }
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    notePenActivity(e);
    const ed = editor;
    if (!ed || !active || (e.target as Element).closest(".ink-ui")) return;
    if (writingInField(e)) return;
    const running = gesture.current;
    // Fingers drawing (pen-only off): a second finger scrolls and zooms instead.
    if (e.pointerType === "touch" && running && running.kind !== "pan" && "type" in running && running.type === "touch") {
      return startPan(e, running);
    }
    if (running?.kind === "pan" && e.pointerType === "touch") {
      running.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      return;
    }
    // The hand holding the pen, or anything else while a gesture runs.
    if (running) return;
    if (notePen(e)) ed.setPenOnly(true);
    if (e.pointerType === "touch" && palmLikely(e)) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const at = toPage(e.clientX, e.clientY);
    ed.lastPage.current = page;
    const fingerOnly = !drawsWith(e, ed.penOnly);
    // Text is placed with a tap, also by a finger: scrolling stays possible.
    if (ed.tool === "text" && !isEraser(e)) {
      gesture.current = { kind: "tap", pointer: e.pointerId, client: { x: e.clientX, y: e.clientY }, at };
      return;
    }
    if (fingerOnly) return;
    e.preventDefault();
    root.current?.setPointerCapture?.(e.pointerId);
    if (ed.tool === "eraser" || isEraser(e)) {
      const g: Gesture = { kind: "erase", pointer: e.pointerId, partial: ed.eraserMode === "partial" && !isEraser(e), items };
      gesture.current = g;
      eraseWith(g, [at]);
      return;
    }
    if (ed.tool === "laser") {
      gesture.current = { kind: "laser", pointer: e.pointerId };
      setLaser([{ ...at, t: Date.now() }]);
      return;
    }
    if (ed.tool === "lasso") {
      const box = ed.selection?.page === page ? ed.selectionBox : null;
      if (box) {
        const ids = new Set(ed.selection!.ids);
        const handle = { x: box.x + box.w, y: box.y + box.h };
        if (Math.hypot(at.x - handle.x, at.y - handle.y) <= tolerance(16)) {
          const origin = { x: box.x, y: box.y };
          gesture.current = { kind: "scale", pointer: e.pointerId, origin, start: Math.max(1, Math.hypot(at.x - origin.x, at.y - origin.y)), ids, base: items };
          return;
        }
        const pad = tolerance(8);
        if (at.x >= box.x - pad && at.x <= box.x + box.w + pad && at.y >= box.y - pad && at.y <= box.y + box.h + pad) {
          gesture.current = { kind: "move", pointer: e.pointerId, start: at, ids, base: items };
          return;
        }
      }
      ed.setSelection(null);
      gesture.current = { kind: "lasso", pointer: e.pointerId, polygon: [at] };
      return;
    }
    if (ed.tool !== "pen" && ed.tool !== "highlighter") return;
    const track: PressureTrack = { pressures: [], measured: false };
    if (e.pointerType === "pen") pushPressure(track, e.pressure);
    else track.pressures.push(0.5);
    const raw = [{ ...at, p: track.pressures[0] }];
    gesture.current = {
      kind: "draw",
      pointer: e.pointerId,
      type: e.pointerType,
      stroke: { id: inkId(), type: ed.tool, color: ed.style.color, width: ed.style.width, points: flatPoints(raw) },
      raw,
      track,
      timed: [{ ...at, t: Date.now() }],
      anchor: at,
      snapped: false,
    };
    drawDraft();
    armSnap();
  }

  function startPan(e: React.PointerEvent, running: Gesture) {
    // The stroke the first finger began was the start of a scroll.
    clearDraft();
    setPreview(null);
    const touches = new Map<number, XY>();
    if ("pointer" in running) touches.set(running.pointer, lastTouch.current ?? { x: e.clientX, y: e.clientY });
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const [a, b] = [...touches.values()];
    gesture.current = { kind: "pan", touches, distance: Math.hypot(a.x - b.x, a.y - b.y) || 1, zoom: 1 };
  }
  const lastTouch = useRef<XY | null>(null);

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    notePenActivity(e);
    const g = gesture.current;
    if (e.pointerType === "touch") lastTouch.current = { x: e.clientX, y: e.clientY };
    if (!g) return;
    if (g.kind === "pan") {
      const before = g.touches.get(e.pointerId);
      if (!before) return;
      const list = [...g.touches.values()];
      const centre = (pts: XY[]) => ({ x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length });
      const c0 = centre(list);
      g.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const now = [...g.touches.values()];
      const c1 = centre(now);
      onPan?.(c0.x - c1.x, c0.y - c1.y);
      if (now.length >= 2) g.zoom = Math.hypot(now[0].x - now[1].x, now[0].y - now[1].y) / g.distance;
      return;
    }
    if (g.kind === "tap" || g.pointer !== e.pointerId) return;
    e.preventDefault();
    const rect = root.current!.getBoundingClientRect();
    const list = samples(e);
    const pts = list.map((s) => clientToPage(s.clientX, s.clientY, rect, size));
    if (g.kind === "draw") {
      if (g.snapped) return;
      list.forEach((s, i) => {
        if (g.type === "pen") pushPressure(g.track, s.pressure);
        else g.track.pressures.push(0.5);
        g.raw.push({ ...pts[i], p: 0.5 });
      });
      // The pressures of the whole stroke (the first reading fills in the ones before it).
      g.raw.forEach((p, i) => (p.p = g.track.pressures[i] ?? 0.5));
      g.stroke = { ...g.stroke, points: flatPoints(g.raw) };
      const last = pts[pts.length - 1];
      g.timed.push({ ...last, t: Date.now() });
      if (g.timed.length > 200) g.timed.splice(0, g.timed.length - 200);
      if (Math.hypot(last.x - g.anchor.x, last.y - g.anchor.y) > tolerance(4)) {
        g.anchor = last;
        armSnap();
      }
      drawDraft();
    } else if (g.kind === "erase") eraseWith(g, pts);
    else if (g.kind === "lasso") {
      g.polygon.push(...pts);
      drawDraft();
    } else if (g.kind === "move") {
      const p = pts[pts.length - 1];
      setPreview(transformItems(g.base, g.ids, { dx: p.x - g.start.x, dy: p.y - g.start.y }));
    } else if (g.kind === "scale") {
      const p = pts[pts.length - 1];
      const factor = Math.max(0.1, Math.hypot(p.x - g.origin.x, p.y - g.origin.y) / g.start);
      setPreview(transformItems(g.base, g.ids, { scale: factor, ox: g.origin.x, oy: g.origin.y }));
    } else if (g.kind === "laser") {
      const now = Date.now();
      setLaser((trail) => [...trail.filter((p) => now - p.t < LASER_MS), ...pts.map((p) => ({ ...p, t: now }))]);
    }
  }

  function onPointerUp(e: React.PointerEvent<HTMLDivElement>, cancelled = false) {
    const g = gesture.current;
    const ed = editor;
    if (!g || !ed) return;
    if (g.kind === "pan") {
      g.touches.delete(e.pointerId);
      if (g.touches.size) return;
      gesture.current = null;
      if (Math.abs(g.zoom - 1) > 0.15) onZoom?.(g.zoom);
      return;
    }
    if (g.pointer !== e.pointerId) return;
    gesture.current = null;
    if (holdTimer.current) clearTimeout(holdTimer.current);
    if (g.kind === "tap") {
      if (cancelled || Math.hypot(e.clientX - g.client.x, e.clientY - g.client.y) > 10) return;
      openText(g.at);
      return;
    }
    if (g.kind === "draw") {
      clearDraft();
      // A stroke the browser took over (scrolling) was not meant – unless a pen drew it.
      if (cancelled && g.type !== "pen") return;
      const stroke = g.stroke;
      ed.change(page, (list) => [...list, stroke]);
    } else if (g.kind === "erase") {
      setPreview(null);
      if (g.items !== items) ed.change(page, () => g.items);
    } else if (g.kind === "lasso") {
      clearDraft();
      const ids = lassoItems(items, g.polygon);
      ed.setSelection(ids.length ? { page, ids } : null);
    } else if (g.kind === "move" || g.kind === "scale") {
      const current = previewRef.current;
      setPreview(null);
      if (current) ed.change(page, () => current);
    }
  }

  // ---- Text ----
  function openText(at: XY) {
    const ed = editor!;
    const hit = [...items].reverse().find((item): item is InkText => item.type === "text" && hitItem(item, at, tolerance(4)));
    if (hit) setTyping({ id: hit.id, x: hit.x, y: hit.y, size: hit.size, color: hit.color, text: hit.text });
    else setTyping({ id: null, x: at.x, y: at.y - ed.style.width * 0.6, size: ed.style.width, color: ed.style.color, text: "" });
  }
  function commitText() {
    const entry = typingRef.current;
    setTyping(null);
    if (!entry || !editor) return;
    const text = entry.text.replace(/\s+$/, "");
    editor.change(page, (list) => {
      if (entry.id) {
        const current = list.find((i) => i.id === entry.id);
        if (!current) return list;
        if (!text) return list.filter((i) => i.id !== entry.id);
        if (current.type === "text" && current.text === text) return list;
        return list.map((i) => (i.id === entry.id ? { ...(i as InkText), text } : i));
      }
      if (!text) return list;
      return [...list, { id: inkId(), type: "text", color: entry.color, size: entry.size, x: entry.x, y: entry.y, text }];
    });
  }

  const shown = preview ?? items;
  const editingId = typing?.id;
  const visible = editingId ? shown.filter((i) => i.id !== editingId) : shown;
  const selected = editor?.selection?.page === page ? editor.selection : null;
  const selectionBox: Box | null = useMemo(() => {
    if (!selected) return null;
    const ids = new Set(selected.ids);
    return unionBox(shown.filter((i) => ids.has(i.id)).map(itemBounds));
  }, [selected, shown]);
  const showSelection = active && editor?.tool === "lasso" && selectionBox;
  const percent = (v: number, of: number) => `${(v / (of || 1)) * 100}%`;
  const touchAction = !active ? undefined : penOnly ? "pan-x pan-y pinch-zoom" : "none";
  return (
    <div
      ref={root}
      className="ink-layer"
      data-editing={active ? "true" : undefined}
      data-tool={active ? editor?.tool : undefined}
      data-page={page}
      style={{ touchAction }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => onPointerUp(e)}
      onPointerCancel={(e) => onPointerUp(e, true)}
      onContextMenu={active ? (e) => e.preventDefault() : undefined}
    >
      <svg className="ink-highlights" viewBox={`0 0 ${size.width} ${size.height}`} preserveAspectRatio="none" aria-hidden="true">
        <InkItems items={visible} layer="highlight" />
        <path ref={draftHighlight} className="ink-draft" fill="none" strokeOpacity={HIGHLIGHTER_OPACITY} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <svg
        className="ink-strokes"
        viewBox={`0 0 ${size.width} ${size.height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={t(`Anmerkungen auf Seite ${page}`, `Annotations on page ${page}`)}
        data-count={visible.length}
      >
        <InkItems items={visible} layer="ink" />
        <path ref={draftInk} className="ink-draft" strokeLinecap="round" strokeLinejoin="round" />
        <path ref={lassoPath} className="ink-lasso" fill="none" vectorEffect="non-scaling-stroke" />
        {laser.length > 0 && (
          <path
            className="ink-laser"
            d={polylinePath(laser)}
            fill="none"
            strokeWidth={tolerance(6)}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
        {showSelection && (
          <g className="ink-selection">
            <rect
              x={selectionBox.x - tolerance(4)}
              y={selectionBox.y - tolerance(4)}
              width={selectionBox.w + tolerance(8)}
              height={selectionBox.h + tolerance(8)}
              fill="none"
              vectorEffect="non-scaling-stroke"
            />
            <circle cx={selectionBox.x + selectionBox.w} cy={selectionBox.y + selectionBox.h} r={tolerance(8)} className="ink-handle" />
          </g>
        )}
      </svg>
      {showSelection && !preview && editor && (
        <div
          className="ink-ui ink-selection-bar"
          role="toolbar"
          aria-label={t("Auswahl", "Selection")}
          style={{
            left: percent(selectionBox.x, size.width),
            top: selectionBox.y > 60 ? `calc(${percent(selectionBox.y, size.height)} - 48px)` : `calc(${percent(selectionBox.y + selectionBox.h, size.height)} + 10px)`,
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {PEN_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              className="ink-swatch"
              style={{ "--swatch": c } as React.CSSProperties}
              aria-label={t(`Farbe ${c}`, `Colour ${c}`)}
              onClick={() => editor.recolorSelection(c)}
            />
          ))}
          <button type="button" aria-label={t("Kopieren", "Copy")} title={t("Kopieren", "Copy")} onClick={() => editor.copySelection()}>
            <Copy size={17} />
          </button>
          <button type="button" aria-label={t("Duplizieren", "Duplicate")} title={t("Duplizieren", "Duplicate")} onClick={() => editor.duplicateSelection()}>
            <CopySimple size={17} />
          </button>
          <button type="button" aria-label={t("Auswahl löschen", "Delete selection")} title={t("Auswahl löschen", "Delete selection")} onClick={() => editor.deleteSelection()}>
            <Trash size={17} />
          </button>
          <span className="ink-selection-hint" title={t("Am Griff unten rechts ziehen, um die Größe zu ändern", "Drag the handle at the bottom right to resize")}>
            <ArrowsOutSimple size={15} />
          </span>
        </div>
      )}
      {typing && (
        <textarea
          autoFocus
          className="ink-ui ink-text-input"
          aria-label={t("Text auf der Seite", "Text on the page")}
          rows={Math.max(1, typing.text.split("\n").length)}
          style={{
            left: percent(typing.x, size.width),
            top: percent(typing.y, size.height),
            fontSize: typing.size * scale,
            color: typing.color,
          }}
          value={typing.text}
          maxLength={1000}
          onChange={(e) => setTyping({ ...typing, text: e.target.value })}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              commitText();
            }
            if (e.key === "Escape") {
              e.stopPropagation();
              setTyping(null);
            }
          }}
          onBlur={(e) => {
            // Scribble may take the focus away for a moment while writing.
            if (stillWriting()) {
              const field = e.currentTarget;
              setTimeout(() => field.isConnected && field.focus(), 0);
              return;
            }
            commitText();
          }}
        />
      )}
    </div>
  );
}
