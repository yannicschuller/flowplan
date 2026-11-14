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
// to an editable shape (lib/ink/shapes.ts); the shape tool draws them; the
// ruler, set square and compass (ink-ruler.tsx) guide strokes along them.
import { memo, useEffect, useId, useMemo, useRef, useState } from "react";
import { useT } from "../i18n";
import { clientToPage, type PageSize } from "@/lib/ink/coords";
import {
  flatPoints,
  hitItem,
  heldStill,
  itemBounds,
  lassoItems,
  lineWidth,
  pageAnchors,
  polylinePath,
  snapShape,
  strokePath,
  withShape,
  unionBox,
  type Box,
  type Pt,
} from "@/lib/ink/geometry";
import { inkFontFamily } from "@/lib/ink/fonts";
import { lineHeightOf, svgAnchor, textAnchorX, textLook, withTextLook, type TextLook, type TextLookPatch } from "@/lib/ink/text-style";
import { FloatingTextBar, TextStyleBar } from "./text-style-bar";
import { inkId, type InkDoc, type InkImage, type InkItem, type InkStroke, type InkText } from "@/lib/ink/model";
import { HIGHLIGHTER_OPACITY } from "@/lib/ink/presets";
import { STROKE_ERASER_RADIUS, eraseWith as erase, type EraserMode } from "@/lib/ink/eraser";
import {
  CORNERS,
  cornerPoint,
  cornerScale,
  handleAt,
  isShape,
  isTap,
  itemAt,
  pinchTransform,
  rotateHandlePoint,
  rotation,
  rotationDegrees,
  transformSelected,
  translation,
  type Handle,
} from "@/lib/ink/selection";
import { InkSelectionBar } from "./ink-selection-bar";
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
import { ImageFrame, InkImageItem, useFileSrc, type ImageAction } from "./ink-picture";
import { splitHighlights } from "@/lib/ink/svg";
import { useLocale } from "../i18n";
import { isUnspoken, type Playback } from "@/lib/ink/audio-sync";
import { dragShape, followPen, type ShapeName } from "@/lib/ink/shape-recognize";
import { defaultUnit } from "@/lib/ink/ruler";
import type { InkShape } from "@/lib/ink/shapes";
import { InkShapeItem, paintDraft } from "./ink-shape";
import { ShapeEditor, formatAngle, formatLength } from "./shape-editor";
import { InkRuler, rulerGuide, type InkGuide } from "./ink-ruler";
import { getShapeSettings, useRuler, type ShapeToolSettings } from "./ink-stores";

type XY = { x: number; y: number };
// How long the pen rests at the end of a stroke before it snaps (ms).
const HOLD_MS = 550;
const LASER_MS = 700;
// Selection handles: how far a press reaches them, how far above the box
// the rotation handle sits (CSS pixels).
const HANDLE_REACH = 14;
const ROTATE_OFFSET = 26;

type Gesture =
  | {
      kind: "draw";
      pointer: number;
      type: string;
      stroke: InkStroke;
      raw: Pt[];
      track: PressureTrack;
      timed: (XY & { t: number })[];
      anchor: XY;
      snapped: boolean;
      // Snapped: the stroke as drawn (undo brings it back), the shape and
      // where the pen was when it snapped (moving on resizes it).
      drawn?: InkStroke;
      snap?: { shape: InkShape; at: XY };
      // Along the ruler or compass; the shape tool's "recognise".
      guide?: InkGuide | null;
      recognise?: boolean;
    }
  | { kind: "shape"; pointer: number; start: XY; client: XY; stroke: InkStroke | null }
  | { kind: "erase"; pointer: number; mode: EraserMode; radius: number; items: InkItem[] }
  | { kind: "lasso"; pointer: number; polygon: XY[] }
  // The selection dragged by its body (move), a corner (scale) or the
  // rotation handle; a second finger turns it into a pinch.
  | { kind: "transform"; pointer: number; handle: Handle | "move"; start: XY; last?: XY; box: Box; ids: Set<string>; base: InkItem[]; touch: boolean }
  | { kind: "pinch"; pointers: Map<number, XY>; from: [XY, XY]; ids: Set<string>; base: InkItem[] }
  | { kind: "laser"; pointer: number }
  // A tap that may turn into a scroll: places text, or picks the item under a finger (lasso).
  | { kind: "tap"; pointer: number; client: XY; at: XY; select?: boolean }
  | { kind: "pan"; touches: Map<number, XY>; distance: number; zoom: number };

// The ink of a page, back to front: highlighter strokes in one layer, the
// rest in another. Highlighter above a picture (in order) is drawn among
// the ink, multiplied, so it shows on the picture (lib/ink/svg.ts).
// With `playback`, what the recording has not reached yet is dimmed (notebook
// audio); each item is its own memo, so playing re-draws only those that change.
const InkItems = memo(function InkItems({
  items,
  layer,
  src,
  playback = null,
}: {
  items: InkItem[];
  layer: "highlight" | "ink";
  src?: (file: string) => string;
  playback?: Playback;
}) {
  const under = splitHighlights(items);
  return (
    <>
      {items.map((item, index) => {
        const shown = item.type === "highlighter" ? (layer === "highlight") === index < under : layer === "ink";
        if (!shown) return null;
        return <InkItemView key={item.id} item={item} dim={isUnspoken(item, playback)} multiply={item.type === "highlighter" && index >= under} src={src} />;
      })}
    </>
  );
});
const InkItemView = memo(function InkItemView({ item, dim, multiply, src }: { item: InkItem; dim: boolean; multiply: boolean; src?: (file: string) => string }) {
  const className = dim ? "ink-unspoken" : undefined;
  if (item.type === "image") return <InkImageItem item={item} src={src} dim={dim} />;
  if (item.type === "text") return <InkTextItem item={item} className={className} />;
  if (item.type === "highlighter") {
    const { d } = strokePath(item);
    return (
      <path
        className={className}
        d={d}
        fill="none"
        stroke={item.color}
        strokeOpacity={HIGHLIGHTER_OPACITY}
        strokeWidth={item.width}
        strokeLinecap="round"
        strokeLinejoin="round"
        style={multiply ? { mixBlendMode: "multiply" } : undefined}
      />
    );
  }
  if (item.shape) return <InkShapeItem item={item} className={className} />;
  const { d, fill } = strokePath(item);
  return fill ? (
    <path className={className} d={d} fill={item.color} />
  ) : (
    <path className={className} d={d} fill="none" stroke={item.color} strokeWidth={lineWidth(item)} strokeLinecap="round" strokeLinejoin="round" />
  );
});
function InkTextItem({ item, className }: { item: InkText; className?: string }) {
  const x = textAnchorX(item);
  return (
    <text
      className={className}
      x={x}
      y={item.y + item.size * 0.8}
      transform={item.rotation ? `rotate(${item.rotation} ${item.x} ${item.y})` : undefined}
      fontSize={item.size}
      fill={item.color}
      fontFamily={inkFontFamily(item.font)}
      fontWeight={item.bold ? "bold" : undefined}
      fontStyle={item.italic ? "italic" : undefined}
      textDecoration={item.underline ? "underline" : undefined}
      textAnchor={item.align ? svgAnchor(item) : undefined}
      style={{ whiteSpace: "pre" }}
    >
      {item.text.split("\n").map((line, i) => (
        <tspan key={i} x={x} dy={i ? item.size * lineHeightOf(item) : 0}>
          {line || " "}
        </tspan>
      ))}
    </text>
  );
}

// The shape tool's fill and dashes on a new shape (the fill: its own
// colour, or the line's).
function withStyle(shape: InkShape, settings: ShapeToolSettings, color: string): InkShape {
  const out: InkShape = { ...shape };
  if (settings.dash !== "solid") out.dash = settings.dash;
  if (settings.fill && shape.kind !== "line") out.fill = settings.fillColor || color;
  return out;
}

export function InkLayer({
  page,
  size,
  editor,
  editing = false,
  doc,
  onPan,
  onZoom,
  onConvert,
  aiPageId,
  onOutline,
  label,
  fingersScroll = false,
  onImageAction,
  onSaveSticker,
  imageSrc: givenSrc,
  playback = null,
}: {
  page: string;
  size: PageSize;
  editor?: InkEditor | null;
  editing?: boolean;
  doc?: InkDoc | null;
  // Two fingers while fingers draw (pen-only drawing off): scroll and zoom.
  onPan?: (dx: number, dy: number) => void;
  onZoom?: (factor: number) => void;
  // "Convert to text" for a selection with handwriting: only where the
  // device recognises it (lib/ink/recognition.ts).
  onConvert?: () => void;
  // The page the surface belongs to: "Convert to text" with the instance's
  // AI where it may read that page (components/ink/ai-convert.tsx).
  aiPageId?: string;
  // Notebooks: "Als Überschrift ins Inhaltsverzeichnis" for selected text.
  onOutline?: (title: string, y: number) => void;
  // The name of the surface for screen readers.
  label?: string;
  // Fingers scroll even with pen-only drawing off (a drawing block not
  // activated yet: the document keeps scrolling under a finger).
  fingersScroll?: boolean;
  // "Save as sticker" in a picture's frame (notebooks).
  onImageAction?: (action: ImageAction, item: InkImage) => void;
  // "Als Sticker speichern" in the bar of a lasso selection (notebooks).
  onSaveSticker?: (items: InkItem[]) => void;
  // The address of a picture's file.
  imageSrc?: (file: string) => string;
  // Notebook audio playing: items written later in it are dimmed.
  playback?: Playback;
}) {
  const t = useT();
  const sharedSrc = useFileSrc();
  const imageSrc = givenSrc ?? sharedSrc;
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
  // The box being typed: its place, text and look (lib/ink/text-style.ts).
  type Typing = { id: string | null; x: number; y: number; rotation?: number; text: string; look: TextLook };
  const [typing, setTypingState] = useState<Typing | null>(null);
  // The field can end twice (Enter, then blur as it goes): only once counts.
  const typingRef = useRef<Typing | null>(null);
  const setTyping = (next: Typing | null) => {
    typingRef.current = next;
    setTypingState(next);
  };
  // The text field and its style bar (text-style-bar.tsx): a tap on the bar
  // keeps the field open (it may take the focus away for a moment).
  const textField = useRef<HTMLTextAreaElement>(null);
  const textBar = useRef<HTMLDivElement>(null);
  const barTouched = useRef(0);
  const [laser, setLaser] = useState<(XY & { t: number })[]>([]);
  // Ink ends at the edge of the page, as on paper. The layer itself shows
  // beyond it (selection handles near the edge), so the ink is clipped.
  const clipId = `ink-clip-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const clip = `url(#${clipId})`;
  const editorRef = useRef(editor);
  editorRef.current = editor;
  const locale = useLocale();
  const ruler = useRuler();
  const rulerHere = active && ruler?.page === page ? ruler : null;
  const unit = ruler?.unit ?? defaultUnit(size);
  // The shape being edited is drawn by its editor while a handle moves.
  const [hiddenId, setHiddenId] = useState<string | null>(null);
  const readout = useRef<HTMLDivElement>(null);

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
  const penOnly = fingersScroll || (editor?.penOnly ?? true);
  useEffect(() => {
    const el = root.current;
    if (!el || !active) return;
    const block = (event: TouchEvent) => {
      if (!event.cancelable) return;
      // Fingers on the ruler or a shape's handles move those, never the page.
      if ((event.target as Element | null)?.closest?.(".ink-ruler-layer, .ink-shape-edit")) return event.preventDefault();
      if ((event.target as Element | null)?.closest?.(".ink-ui")) return;
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

  useEffect(() => {
    editor?.pageSizes.current.set(page, size);
  }, [editor, page, size]);

  const toPage = (clientX: number, clientY: number) => clientToPage(clientX, clientY, root.current!.getBoundingClientRect(), size);
  const tolerance = (px: number) => px / scale;

  function drawDraft() {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const g = gesture.current;
      if ((g?.kind === "draw" || g?.kind === "shape") && g.stroke) {
        const el = g.stroke.type === "highlighter" ? draftHighlight.current : draftInk.current;
        if (!el) return;
        paintDraft(el, g.stroke, g.stroke.shape ? { d: "", fill: false } : strokePath(g.stroke));
        showMeasure(g);
      } else if (g?.kind === "lasso") lassoPath.current?.setAttribute("d", polylinePath(g.polygon) + (g.polygon.length > 2 ? "Z" : ""));
    });
  }
  function clearDraft() {
    cancelAnimationFrame(frame.current);
    for (const el of [draftInk.current, draftHighlight.current, lassoPath.current]) el?.setAttribute("d", "");
    if (readout.current) readout.current.hidden = true;
  }
  // The small readout by the pen: length along the ruler or of a line, the
  // shape just snapped to.
  const shapeNames = (name: ShapeName) =>
    ({
      line: t("Linie", "Line"),
      arrow: t("Pfeil", "Arrow"),
      rectangle: t("Rechteck", "Rectangle"),
      square: t("Quadrat", "Square"),
      rounded: t("Abgerundetes Rechteck", "Rounded rectangle"),
      ellipse: t("Ellipse", "Ellipse"),
      circle: t("Kreis", "Circle"),
      triangle: t("Dreieck", "Triangle"),
      diamond: t("Raute", "Diamond"),
      polygon: t("Vieleck", "Polygon"),
      star: t("Stern", "Star"),
    })[name];
  const snapName = useRef<{ name: ShapeName; until: number } | null>(null);
  function showMeasure(g: Extract<Gesture, { kind: "draw" } | { kind: "shape" }>) {
    const el = readout.current;
    if (!el || !g.stroke) return;
    let text = "";
    const shape = g.stroke.shape;
    if (g.kind === "draw" && g.guide) text = g.guide.label();
    else if (shape?.kind === "line" && shape.pts) {
      const [x1, y1, x2, y2] = shape.pts;
      const deg = (Math.atan2(-(y2 - y1), x2 - x1) * 180) / Math.PI;
      text = `${formatLength(Math.hypot(x2 - x1, y2 - y1), unit, locale)} · ${formatAngle(Math.round((deg < 0 ? deg + 360 : deg) * 10) / 10, locale)}`;
    } else if (shape && snapName.current && Date.now() < snapName.current.until) text = shapeNames(snapName.current.name);
    el.hidden = !text;
    if (!text) return;
    el.textContent = text;
    const pts = g.stroke.points;
    const x = pts[pts.length - 3],
      y = pts[pts.length - 2];
    el.style.left = `${(x / (size.width || 1)) * 100}%`;
    el.style.top = `calc(${(y / (size.height || 1)) * 100}% - 34px)`;
  }
  function armSnap() {
    if (holdTimer.current) clearTimeout(holdTimer.current);
    holdTimer.current = setTimeout(() => {
      const g = gesture.current;
      if (g?.kind !== "draw" || g.snapped || g.guide || (!editorRef.current?.snap && !g.recognise)) return;
      if (!heldStill(g.timed, Date.now(), HOLD_MS - 50, tolerance(4))) return;
      snapNow(g);
    }, HOLD_MS);
  }
  // The stroke drawn so far becomes the shape it looks like.
  function snapNow(g: Extract<Gesture, { kind: "draw" }>) {
    const result = snapShape(g.stroke, { anchors: pageAnchors(items), tolerance: tolerance(12), minSize: tolerance(14) });
    if (!result) return false;
    g.drawn = g.stroke;
    g.stroke = result.stroke;
    g.snapped = true;
    const last = g.timed[g.timed.length - 1];
    if (result.stroke.shape) g.snap = { shape: result.stroke.shape, at: last };
    snapName.current = { name: result.name, until: Date.now() + 1400 };
    drawDraft();
    return true;
  }
  function eraseWith(g: Extract<Gesture, { kind: "erase" }>, path: XY[]) {
    const next = erase(g.items, path, g.mode, tolerance(g.radius));
    if (next !== g.items) {
      g.items = next;
      setPreview(next);
    }
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    notePenActivity(e);
    const ed = editor;
    if (!ed || !active || (e.target as Element).closest(".ink-ui")) return;
    // Scribble into a focused field near the pen – unless the field holds
    // this surface (a drawing block in the document being edited).
    if (!document.activeElement?.contains(root.current) && writingInField(e)) return;
    const running = gesture.current;
    // Fingers drawing (pen-only off): a second finger scrolls and zooms instead.
    if (e.pointerType === "touch" && running && running.kind !== "pan" && "type" in running && running.type === "touch") {
      return startPan(e, running);
    }
    if (running?.kind === "pan" && e.pointerType === "touch") {
      running.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      return;
    }
    // A second finger on a selection held by a finger: pinch to scale and turn it.
    if (e.pointerType === "touch" && running?.kind === "transform" && running.touch) {
      const first = running.last ?? running.start;
      const second = toPage(e.clientX, e.clientY);
      // The pinch goes on from where the drag got to.
      const base = previewRef.current ?? running.base;
      root.current?.setPointerCapture?.(e.pointerId);
      gesture.current = {
        kind: "pinch",
        pointers: new Map([
          [running.pointer, first],
          [e.pointerId, second],
        ]),
        from: [first, second],
        ids: running.ids,
        base,
      };
      setPreview(base);
      return;
    }
    // The hand holding the pen, or anything else while a gesture runs.
    if (running) return;
    if (notePen(e)) ed.setPenOnly(true);
    if (e.pointerType === "touch" && palmLikely(e)) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const at = toPage(e.clientX, e.clientY);
    ed.lastPage.current = page;
    const fingerOnly = !drawsWith(e, ed.penOnly || fingersScroll);
    // Text is placed with a tap, also by a finger: scrolling stays possible.
    if (ed.tool === "text" && !isEraser(e)) {
      gesture.current = { kind: "tap", pointer: e.pointerId, client: { x: e.clientX, y: e.clientY }, at };
      return;
    }
    if (fingerOnly && ed.tool === "lasso") {
      // A finger moves, scales and turns a selection; elsewhere it scrolls,
      // and a tap picks the item under it.
      const target = selectionTarget(at);
      if (!target) {
        gesture.current = { kind: "tap", pointer: e.pointerId, client: { x: e.clientX, y: e.clientY }, at, select: true };
        return;
      }
      e.preventDefault();
      root.current?.setPointerCapture?.(e.pointerId);
      gesture.current = { ...target, pointer: e.pointerId, start: at, touch: true };
      return;
    }
    if (fingerOnly) return;
    e.preventDefault();
    root.current?.setPointerCapture?.(e.pointerId);
    if (ed.tool === "eraser" || isEraser(e)) {
      // The eraser end of a pen takes whole strokes, as before.
      const mode: EraserMode = isEraser(e) ? "stroke" : ed.eraserMode;
      const g: Gesture = { kind: "erase", pointer: e.pointerId, mode, radius: mode === "partial" ? ed.eraserSize : STROKE_ERASER_RADIUS, items };
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
      const target = selectionTarget(at);
      if (target) {
        gesture.current = { ...target, pointer: e.pointerId, start: at, touch: e.pointerType === "touch" };
        return;
      }
      ed.setSelection(null);
      gesture.current = { kind: "lasso", pointer: e.pointerId, polygon: [at] };
      return;
    }
    const settings = ed.tool === "shape" ? getShapeSettings() : null;
    if (settings && settings.kind !== "auto") {
      gesture.current = { kind: "shape", pointer: e.pointerId, start: at, client: { x: e.clientX, y: e.clientY }, stroke: null };
      return;
    }
    if (ed.tool !== "pen" && ed.tool !== "highlighter" && ed.tool !== "shape") return;
    const track: PressureTrack = { pressures: [], measured: false };
    if (e.pointerType === "pen") pushPressure(track, e.pressure);
    else track.pressures.push(0.5);
    const guide = rulerGuide(rulerHere, size, scale, at, locale);
    const raw = [{ ...(guide ? guide.map(at)[0] : at), p: track.pressures[0] }];
    gesture.current = {
      kind: "draw",
      pointer: e.pointerId,
      type: e.pointerType,
      stroke: { id: inkId(), type: ed.tool === "highlighter" ? "highlighter" : "pen", color: ed.style.color, width: ed.style.width, points: flatPoints(raw) },
      raw,
      track,
      timed: [{ ...at, t: Date.now() }],
      anchor: at,
      snapped: false,
      guide,
      recognise: !!settings,
    };
    drawDraft();
    if (!guide) armSnap();
  }

  // What a press at `at` grabs of this page's selection: a handle, the
  // body (with a margin) or nothing.
  function selectionTarget(at: XY): { kind: "transform"; handle: Handle | "move"; box: Box; ids: Set<string>; base: InkItem[] } | null {
    const ed = editor;
    const box = ed?.selection?.page === page ? ed.selectionBox : null;
    if (!ed || !box) return null;
    const ids = new Set(ed.selection!.ids);
    const handle = handleAt(box, at, tolerance(HANDLE_REACH), tolerance(ROTATE_OFFSET));
    if (handle) return { kind: "transform", handle, box, ids, base: items };
    const pad = tolerance(8);
    if (at.x >= box.x - pad && at.x <= box.x + box.w + pad && at.y >= box.y - pad && at.y <= box.y + box.h + pad)
      return { kind: "transform", handle: "move", box, ids, base: items };
    return null;
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
    if (g.kind === "pinch") {
      if (!g.pointers.has(e.pointerId)) return;
      e.preventDefault();
      g.pointers.set(e.pointerId, toPage(e.clientX, e.clientY));
      const now = [...g.pointers.values()];
      if (now.length === 2) setPreview(transformSelected(g.base, g.ids, pinchTransform(g.from, [now[0], now[1]])));
      return;
    }
    if (g.kind === "tap" || g.pointer !== e.pointerId) return;
    e.preventDefault();
    const rect = root.current!.getBoundingClientRect();
    const list = samples(e);
    const pts = list.map((s) => clientToPage(s.clientX, s.clientY, rect, size));
    if (g.kind === "shape") {
      const to = pts[pts.length - 1];
      if (!g.stroke && Math.hypot(e.clientX - g.client.x, e.clientY - g.client.y) < 4) return;
      const ed = editorRef.current!;
      const settings = getShapeSettings();
      if (settings.kind === "auto") return;
      let shape = dragShape(settings.kind, g.start, to, { even: e.shiftKey, snap: !e.altKey });
      if (shape.kind === "line" && !e.altKey) {
        const anchor = pageAnchors(items).find((a) => Math.hypot(a.x - to.x, a.y - to.y) <= tolerance(12));
        if (anchor && shape.pts) shape = { ...shape, pts: [shape.pts[0], shape.pts[1], anchor.x, anchor.y] };
      }
      const styled = withStyle(shape, settings, ed.style.color);
      g.stroke = withShape(g.stroke ?? { id: inkId(), type: "pen", color: ed.style.color, width: ed.style.width, points: [] }, styled);
      drawDraft();
      return;
    }
    if (g.kind === "draw") {
      if (g.snapped) {
        // Moving on after snapping: lines follow with their end, shapes grow.
        if (g.snap) {
          g.stroke = withShape(g.stroke, followPen(g.snap.shape, g.snap.at, pts[pts.length - 1]), g.stroke.points[2] ?? 0.5);
          drawDraft();
        }
        return;
      }
      if (g.guide) {
        for (const [i, s] of list.entries()) {
          if (g.type === "pen") pushPressure(g.track, s.pressure);
          const p = g.type === "pen" ? (g.track.pressures[g.track.pressures.length - 1] ?? 0.5) : 0.5;
          for (const q of g.guide.map(pts[i])) g.raw.push({ ...q, p });
        }
        if (g.raw.length > 5000) g.raw.splice(1, g.raw.length - 5000);
        g.stroke = { ...g.stroke, points: flatPoints(g.raw) };
        drawDraft();
        return;
      }
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
    } else if (g.kind === "transform") {
      const p = pts[pts.length - 1];
      g.last = p;
      const { box } = g;
      const centre = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
      const m =
        g.handle === "move"
          ? translation(p.x - g.start.x, p.y - g.start.y)
          : g.handle === "rotate"
            ? rotation((rotationDegrees(centre, g.start, p, e.shiftKey) * Math.PI) / 180, centre)
            : cornerScale(box, g.handle, p, e.shiftKey || g.touch);
      setPreview(transformSelected(g.base, g.ids, m));
    } else if (g.kind === "laser") {
      const now = Date.now();
      setLaser((trail) => [...trail.filter((p) => now - p.t < LASER_MS), ...pts.map((p) => ({ ...p, t: now }))]);
    }
  }

  function onPointerUp(e: React.PointerEvent<HTMLDivElement>, cancelled = false) {
    const g = gesture.current;
    const ed = editor;
    if (!g || !ed) return;
    // The item a tap picked: a picture or sticker alone opens in its frame
    // (components/ink/ink-picture.tsx), anything else is selected.
    const pickItem = (hit: string | null) => {
      if (hit && items.find((i) => i.id === hit)?.type === "image") ed.pick({ page, id: hit });
      else {
        ed.pick(null);
        ed.setSelection(hit ? { page, ids: [hit] } : null);
      }
    };
    if (g.kind === "pan") {
      g.touches.delete(e.pointerId);
      if (g.touches.size) return;
      gesture.current = null;
      if (Math.abs(g.zoom - 1) > 0.15) onZoom?.(g.zoom);
      return;
    }
    if (g.kind === "pinch") {
      if (!g.pointers.has(e.pointerId)) return;
      gesture.current = null;
      const current = previewRef.current;
      setPreview(null);
      if (current && current !== g.base) ed.change(page, () => current);
      return;
    }
    if (g.pointer !== e.pointerId) return;
    gesture.current = null;
    if (holdTimer.current) clearTimeout(holdTimer.current);
    if (g.kind === "tap") {
      if (cancelled || Math.hypot(e.clientX - g.client.x, e.clientY - g.client.y) > 10) return;
      if (g.select) {
        const hit = itemAt(items, g.at, tolerance(10));
        pickItem(hit);
      } else openText(g.at);
      return;
    }
    if (g.kind === "shape") {
      clearDraft();
      const stroke = g.stroke;
      if (cancelled && !stroke) return;
      if (!stroke) {
        // A tap picks the shape under it for editing (the lasso's picking, shapes only).
        const hit = itemAt(items, g.start, tolerance(10), isShape);
        ed.setSelection(hit ? { page, ids: [hit] } : null);
        return;
      }
      ed.change(page, (list) => [...list, stroke]);
      ed.setSelection({ page, ids: [stroke.id] });
      return;
    }
    if (g.kind === "draw") {
      // The shape tool's "recognise": no need to hold.
      if (g.recognise && !g.snapped && !cancelled) snapNow(g);
      clearDraft();
      // A stroke the browser took over (scrolling) was not meant – unless a pen drew it.
      if (cancelled && g.type !== "pen") return;
      let stroke = g.stroke;
      if (g.guide?.finish) stroke = g.guide.finish(stroke);
      if (g.recognise && stroke.shape) stroke = withShape(stroke, withStyle(stroke.shape, getShapeSettings(), stroke.color), stroke.points[2] ?? 0.5);
      const drawn = g.drawn;
      // Snapped: first the stroke as drawn, then the shape – undo goes back to freehand.
      if (drawn && stroke.shape) ed.change(page, (list) => [...list, drawn]);
      ed.change(page, (list) => (drawn && stroke.shape ? list.map((i) => (i.id === stroke.id ? stroke : i)) : [...list, stroke]));
      if (g.recognise && stroke.shape) ed.setSelection({ page, ids: [stroke.id] });
    } else if (g.kind === "erase") {
      setPreview(null);
      if (g.items !== items) ed.change(page, () => g.items);
    } else if (g.kind === "lasso") {
      clearDraft();
      // A tap picks the one item under it – a picture or sticker opens in
      // its frame (components/ink/ink-picture.tsx); a loop what it goes around.
      if (isTap(g.polygon, tolerance(6))) {
        pickItem(itemAt(items, g.polygon[0], tolerance(e.pointerType === "pen" ? 6 : 8)));
        return;
      }
      const ids = lassoItems(items, g.polygon);
      if (ids.length === 1) pickItem(ids[0]);
      else ed.setSelection(ids.length ? { page, ids } : null);
    } else if (g.kind === "transform") {
      const current = previewRef.current;
      setPreview(null);
      if (current && !cancelled) ed.change(page, () => current);
    }
  }

  // ---- Text ----
  const typingOf = (item: InkText): Typing => ({ id: item.id, x: item.x, y: item.y, rotation: item.rotation, text: item.text, look: textLook(item) });
  function openText(at: XY) {
    const ed = editor!;
    const hit = [...items].reverse().find((item): item is InkText => item.type === "text" && hitItem(item, at, tolerance(4)));
    if (hit) return setTyping(typingOf(hit));
    // New text: the text tool's style (ink-panel.tsx).
    const s = ed.style;
    const look: TextLook = {
      font: s.font,
      size: s.width,
      color: s.color,
      bold: !!s.bold,
      italic: !!s.italic,
      underline: !!s.underline,
      align: s.align || "left",
      lineHeight: lineHeightOf(s),
    };
    setTyping({ id: null, x: at.x, y: at.y - s.width * 0.6, text: "", look });
  }
  // A text box chosen with the lasso: typed in again with the text tool.
  function editText(id: string) {
    const hit = items.find((i): i is InkText => i.id === id && i.type === "text");
    if (!hit || !editor) return;
    editor.setTool("text");
    setTyping(typingOf(hit));
  }
  // The style bar while typing: the box's look; for new text also the text
  // tool's (the next box starts so).
  function styleTyping(patch: TextLookPatch) {
    const now = typingRef.current;
    if (!now) return;
    setTyping({ ...now, look: { ...now.look, ...patch } });
    if (!now.id && editor) {
      const { size, ...rest } = patch;
      editor.setStyle({ ...rest, ...(size !== undefined ? { width: size } : {}) });
    }
  }
  // Text and look are one undo step; an emptied box goes.
  function commitText() {
    const entry = typingRef.current;
    setTyping(null);
    if (!entry || !editor) return;
    const text = entry.text.replace(/\s+$/, "");
    editor.change(page, (list) => {
      if (entry.id) {
        const current = list.find((i): i is InkText => i.id === entry.id && i.type === "text");
        if (!current) return list;
        if (!text) return list.filter((i) => i.id !== entry.id);
        const styled = withTextLook(current.text === text ? current : { ...current, text }, entry.look);
        return styled === current ? list : list.map((i) => (i.id === entry.id ? styled : i));
      }
      if (!text) return list;
      return [...list, withTextLook({ id: inkId(), type: "text", color: entry.look.color, size: entry.look.size, x: entry.x, y: entry.y, text }, entry.look)];
    });
  }
  // Focus left the field or its bar: the box is done – unless it went
  // between them, or the bar was just tapped (the field gets it back).
  function textFocusLeft(to: EventTarget | null) {
    const node = to as Node | null;
    if (node && (node === textField.current || textBar.current?.contains(node))) return;
    if (Date.now() - barTouched.current < 600) {
      setTimeout(() => {
        const now = document.activeElement;
        if (typingRef.current && now !== textField.current && !textBar.current?.contains(now)) textField.current?.focus({ preventScroll: true });
      }, 0);
      return;
    }
    commitText();
  }

  const shown = preview ?? items;
  const editingId = typing?.id ?? hiddenId;
  const visible = editingId ? shown.filter((i) => i.id !== editingId) : shown;
  const selected = editor?.selection?.page === page ? editor.selection : null;
  // One shape selected with the lasso or the shape tool: its own handles.
  const shapeItem =
    active && !preview && selected?.ids.length === 1 && (editor?.tool === "lasso" || editor?.tool === "shape")
      ? (shown.find((i): i is InkStroke & { shape: InkShape } => i.id === selected.ids[0] && i.type === "pen" && !!i.shape) ?? null)
      : null;
  const selectionBox: Box | null = useMemo(() => {
    if (!selected) return null;
    const ids = new Set(selected.ids);
    return unionBox(shown.filter((i) => ids.has(i.id)).map(itemBounds));
  }, [selected, shown]);
  const showSelection = active && editor?.tool === "lasso" && !shapeItem && selectionBox;
  const pickedItem =
    active && editor?.tool === "lasso" && editor.picked?.page === page ? (shown.find((i) => i.id === editor.picked!.id && i.type === "image") as InkImage | undefined) : undefined;
  const percent = (v: number, of: number) => `${(v / (of || 1)) * 100}%`;
  const center = (p: XY) => ({ cx: p.x, cy: p.y });
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
        <defs>
          <clipPath id={clipId} clipPathUnits="userSpaceOnUse">
            <rect x={0} y={0} width={size.width} height={size.height} />
          </clipPath>
        </defs>
        <g clipPath={clip}>
          <InkItems items={visible} layer="highlight" src={imageSrc} playback={playback} />
          <path ref={draftHighlight} className="ink-draft" fill="none" strokeOpacity={HIGHLIGHTER_OPACITY} strokeLinecap="round" strokeLinejoin="round" />
        </g>
      </svg>
      <svg
        className="ink-strokes"
        viewBox={`0 0 ${size.width} ${size.height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={label || t(`Anmerkungen auf Seite ${page}`, `Annotations on page ${page}`)}
        data-count={visible.length}
      >
        <g clipPath={clip}>
          <InkItems items={visible} layer="ink" src={imageSrc} playback={playback} />
          <path ref={draftInk} className="ink-draft" strokeLinecap="round" strokeLinejoin="round" />
        </g>
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
        {laser.length > 0 && <circle className="ink-laser-dot" cx={laser[laser.length - 1].x} cy={laser[laser.length - 1].y} r={tolerance(6)} />}
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
            {!preview && (
              <>
                <line
                  className="ink-rotate-stem"
                  x1={selectionBox.x + selectionBox.w / 2}
                  y1={selectionBox.y - tolerance(4)}
                  x2={rotateHandlePoint(selectionBox, tolerance(ROTATE_OFFSET)).x}
                  y2={rotateHandlePoint(selectionBox, tolerance(ROTATE_OFFSET)).y}
                  vectorEffect="non-scaling-stroke"
                />
                <circle {...center(rotateHandlePoint(selectionBox, tolerance(ROTATE_OFFSET)))} r={tolerance(7)} className="ink-handle ink-handle-rotate" />
                {CORNERS.map((corner) => (
                  <circle key={corner} {...center(cornerPoint(selectionBox, corner))} r={tolerance(6)} className={`ink-handle ink-handle-${corner}`} />
                ))}
              </>
            )}
          </g>
        )}
      </svg>
      {rulerHere && <InkRuler page={page} size={size} scale={scale} state={rulerHere} items={items} />}
      {shapeItem && editor && (
        <ShapeEditor key={shapeItem.id} page={page} size={size} scale={scale} item={shapeItem} items={items} editor={editor} unit={unit} onHide={setHiddenId} />
      )}
      <div ref={readout} className="ink-measure" hidden />
      {showSelection && !preview && editor && selected && (
        <InkSelectionBar
          editor={editor}
          page={page}
          size={size}
          box={selectionBox}
          items={shown.filter((i) => selected.ids.includes(i.id))}
          onConvert={onConvert}
          aiPageId={aiPageId}
          onOutline={onOutline}
          onSticker={onSaveSticker}
          onEditText={editText}
        />
      )}
      {pickedItem && editor && (
        <ImageFrame
          item={pickedItem}
          items={items}
          size={size}
          scale={scale}
          root={root}
          src={imageSrc}
          onPreview={setPreview}
          onCommit={(next) => editor.change(page, () => next)}
          onClose={() => editor.pick(null)}
          onPick={(id) => editor.pick({ page, id })}
          onAction={onImageAction}
        />
      )}
      {typing && (
        <textarea
          ref={textField}
          autoFocus
          className="ink-ui ink-text-input"
          aria-label={t("Text auf der Seite", "Text on the page")}
          rows={Math.max(1, typing.text.split("\n").length)}
          style={{
            left: percent(typing.x, size.width),
            top: percent(typing.y, size.height),
            fontSize: typing.look.size * scale,
            fontFamily: inkFontFamily(typing.look.font),
            color: typing.look.color,
            lineHeight: typing.look.lineHeight,
            ...(typing.look.bold ? { fontWeight: 700 } : {}),
            ...(typing.look.italic ? { fontStyle: "italic" } : {}),
            ...(typing.look.underline ? { textDecoration: "underline" } : {}),
            ...(typing.look.align !== "left" ? { textAlign: typing.look.align } : {}),
            ...(typing.rotation ? { transform: `rotate(${typing.rotation}deg)`, transformOrigin: "0 0" } : {}),
          }}
          value={typing.text}
          maxLength={1000}
          onChange={(e) => setTyping({ ...typing, text: e.target.value })}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            const k = e.key.toLowerCase();
            if ((e.metaKey || e.ctrlKey) && !e.altKey && (k === "b" || k === "i" || k === "u")) {
              // ⌘B, ⌘I, ⌘U: bold, italic, underline of the whole box.
              e.preventDefault();
              const key = k === "b" ? "bold" : k === "i" ? "italic" : "underline";
              styleTyping({ [key]: !typing.look[key] });
              return;
            }
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
            textFocusLeft(e.relatedTarget);
          }}
        />
      )}
      {typing && editor && (
        <FloatingTextBar
          anchor={textField}
          barRef={textBar}
          label={t("Textstil", "Text style")}
          onPointerDown={(e) => {
            e.stopPropagation();
            barTouched.current = Date.now();
            // Buttons keep the focus in the text field; fields take it.
            if (!(e.target as Element).closest("input, select, textarea, .color-picker")) e.preventDefault();
          }}
          onBlur={(e) => textFocusLeft(e.relatedTarget)}
        >
          <TextStyleBar className="ink-selection-row" look={typing.look} onChange={styleTyping} color={{ recent: editor.recentColors, onRemember: editor.rememberCustomColor }} />
        </FloatingTextBar>
      )}
    </div>
  );
}
