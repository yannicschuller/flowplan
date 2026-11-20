"use client";
// Marking up a photo in a document: pen, highlighter, arrow, rectangle,
// ellipse and text in a few colours. Shapes are kept in the image's own
// pixels, so they stay sharp at any size. Saving writes a new image with the
// markings; the original and the shapes stay on the image, so the markings
// can be changed or removed later without loss.
//
// The image can be zoomed (fit … 8×) and panned inside its frame
// (lib/image-markup-view.ts, lib/pinch-zoom.ts): two fingers pinch and pan,
// ⌘/Ctrl + wheel and a trackpad pinch zoom around the pointer, a plain
// wheel or two-finger scroll pans, the keys + / − / 0 zoom and fit. The view
// is only drawn – markings are always kept in image pixels. With pen-only
// drawing (lib/stylus.ts, shared with PDFs and whiteboards) one finger pans
// and never draws; without it one finger draws and two zoom.
import { useKeyboardHints } from "@/lib/keyboard-hints";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowArcLeft,
  ArrowArcRight,
  ArrowUpRight,
  Circle,
  Eraser,
  HighlighterCircle,
  MagnifyingGlassMinus,
  MagnifyingGlassPlus,
  PencilSimple,
  Square,
  TextT,
  Trash,
} from "@phosphor-icons/react";
import { useT } from "./i18n";
import { drawsWith, isEraser, notePen, notePenActivity, onPencilAction, palmLikely, penOnlySetting, samples } from "@/lib/stylus";
import { FRAME_VIEW, distance, frameZoom, framePan, framePinch, midpoint, pinchFactor, resizeView, settleView, wheelFactor, type FrameView, type XY } from "@/lib/pinch-zoom";
import { MARKUP_ZOOM, clampView, imageToScreen, pixelScale, screenToImage, stepView, wheelPan } from "@/lib/image-markup-view";
import { Modal } from "./ui";
import { shortcutLetter } from "@/lib/keymap";

type Tool = "pen" | "marker" | "arrow" | "rect" | "ellipse" | "text" | "eraser";
type Point = [number, number];
export type Shape =
  | { type: "pen" | "marker"; color: string; width: number; points: Point[] }
  | { type: "arrow" | "rect" | "ellipse"; color: string; width: number; from: Point; to: Point }
  | { type: "text"; color: string; width: number; at: Point; text: string };

const COLORS = ["#e03131", "#f08c00", "#fab005", "#2f9e44", "#1c7ed6", "#212529", "#ffffff"];
const WIDTHS = [1, 2, 4];
const MAX_SHAPES = 500;
// A finger that moves less than this (screen pixels) taps.
const TAP_MOVE = 10;

type Layout = { fit: number; width: number; height: number };
type Gesture =
  | { kind: "pinch"; start: FrameView & { mid: XY; distance: number } }
  | { kind: "pan"; id: number; from: XY; view: FrameView; moved: boolean };

// Parses stored markings; anything unexpected is dropped.
export function parseShapes(value: unknown): Shape[] {
  if (typeof value !== "string" || !value) return [];
  try {
    const list = JSON.parse(value);
    return Array.isArray(list) ? list.filter((s) => s && typeof s === "object" && typeof s.type === "string").slice(0, MAX_SHAPES) : [];
  } catch {
    return [];
  }
}

// Draws the markings; `unit` is the line width of size 1 in image pixels.
function drawShapes(ctx: CanvasRenderingContext2D, shapes: Shape[], unit: number) {
  for (const shape of shapes) {
    ctx.save();
    ctx.strokeStyle = shape.color;
    ctx.fillStyle = shape.color;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const width = shape.width * unit;
    if (shape.type === "pen" || shape.type === "marker") {
      if (shape.type === "marker") {
        ctx.globalAlpha = 0.35;
        ctx.lineWidth = width * 5;
      } else ctx.lineWidth = width;
      ctx.beginPath();
      shape.points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      if (shape.points.length === 1) ctx.lineTo(shape.points[0][0] + 0.1, shape.points[0][1]);
      ctx.stroke();
    } else if (shape.type === "rect" || shape.type === "ellipse") {
      ctx.lineWidth = width;
      const [x1, y1] = shape.from,
        [x2, y2] = shape.to;
      ctx.beginPath();
      if (shape.type === "rect") ctx.rect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
      else ctx.ellipse((x1 + x2) / 2, (y1 + y2) / 2, Math.abs(x2 - x1) / 2, Math.abs(y2 - y1) / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
    } else if (shape.type === "arrow") {
      ctx.lineWidth = width;
      const [x1, y1] = shape.from,
        [x2, y2] = shape.to;
      const angle = Math.atan2(y2 - y1, x2 - x1);
      const head = Math.max(10 * unit, width * 4);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - head * Math.cos(angle - 0.45), y2 - head * Math.sin(angle - 0.45));
      ctx.lineTo(x2 - head * Math.cos(angle + 0.45), y2 - head * Math.sin(angle + 0.45));
      ctx.closePath();
      ctx.fill();
    } else if (shape.type === "text") {
      const size = Math.round(14 * unit * (1 + shape.width / 2));
      ctx.font = `600 ${size}px system-ui, sans-serif`;
      ctx.textBaseline = "top";
      // A light outline keeps the text readable on any photo.
      ctx.lineWidth = Math.max(2, size / 8);
      ctx.strokeStyle = shape.color === "#ffffff" ? "rgba(0,0,0,.6)" : "rgba(255,255,255,.85)";
      ctx.strokeText(shape.text, shape.at[0], shape.at[1]);
      ctx.fillText(shape.text, shape.at[0], shape.at[1]);
    }
    ctx.restore();
  }
}

// Is a marking within `tolerance` image pixels of the point (eraser)?
export function shapeHit(shape: Shape, [x, y]: Point, tolerance: number) {
  const near = (a: Point, b: Point) => {
    const dx = b[0] - a[0],
      dy = b[1] - a[1];
    const length = dx * dx + dy * dy;
    const t = length ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / length)) : 0;
    return Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy)) <= tolerance;
  };
  if (shape.type === "pen" || shape.type === "marker")
    return shape.points.length === 1 ? near(shape.points[0], shape.points[0]) : shape.points.some((p, i) => i > 0 && near(shape.points[i - 1], p));
  if (shape.type === "arrow") return near(shape.from, shape.to);
  if (shape.type === "text") {
    const [tx, ty] = shape.at;
    return x >= tx - tolerance && y >= ty - tolerance && y <= ty + 40 + tolerance && x <= tx + shape.text.length * 12 + tolerance;
  }
  const { from, to } = shape as Extract<Shape, { from: Point }>;
  const [x1, y1] = from,
    [x2, y2] = to;
  const [left, right, top, bottom] = [Math.min(x1, x2), Math.max(x1, x2), Math.min(y1, y2), Math.max(y1, y2)];
  if (shape.type === "rect")
    return (
      near([left, top], [right, top]) || near([right, top], [right, bottom]) || near([right, bottom], [left, bottom]) || near([left, bottom], [left, top])
    );
  // Ellipse: distance to the outline, normalised by the radii.
  const rx = Math.max(1, (right - left) / 2),
    ry = Math.max(1, (bottom - top) / 2);
  const d = Math.hypot((x - (left + rx)) / rx, (y - (top + ry)) / ry);
  return Math.abs(d - 1) * Math.min(rx, ry) <= tolerance;
}

export type AnnotationResult = { blob: Blob; shapes: string; original: string };

export function ImageAnnotator({
  src,
  original,
  annotations,
  onSave,
  onClose,
}: {
  src: string;
  original?: string | null;
  annotations?: string | null;
  onSave: (result: AnnotationResult) => Promise<void>;
  onClose: () => void;
}) {
  const t = useT();
  const keyHints = useKeyboardHints();
  // Markings are drawn on the original; an image without one is its own.
  const base = original || src;
  const canvas = useRef<HTMLCanvasElement>(null);
  const image = useRef<HTMLImageElement | null>(null);
  const [ready, setReady] = useState(false),
    [failed, setFailed] = useState(false),
    [shapes, setShapes] = useState<Shape[]>(() => (original ? parseShapes(annotations) : [])),
    [undone, setUndone] = useState<Shape[]>([]),
    [tool, setTool] = useState<Tool>("pen"),
    [color, setColor] = useState(COLORS[0]),
    [width, setWidth] = useState(2),
    [draft, setDraftState] = useState<Shape | null>(null),
    [typing, setTyping] = useState<{ at: Point; text: string } | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  // How the image fits the dialog, and the zoom and pan inside that frame.
  const [layout, setLayout] = useState<Layout>({ fit: 1, width: 0, height: 0 });
  const [view, setView] = useState<FrameView>(FRAME_VIEW);
  const viewRef = useRef(view);
  // The shape being drawn, current between renders (pointer events come
  // faster than React renders: no point of a stroke is lost).
  const draftRef = useRef<Shape | null>(null);
  const setDraft = (next: Shape | null) => {
    draftRef.current = next;
    setDraftState(next);
  };
  const layoutRef = useRef(layout);
  const apply = useCallback((next: FrameView) => {
    viewRef.current = next;
    setView(next);
  }, []);
  // Fingers on the stage (canvas pixels) and the gesture they make.
  const touches = useRef(new Map<number, XY>());
  const gesture = useRef<Gesture | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const activePen = useRef(false);
  // Pen-only drawing (lib/stylus.ts): once a pen draws, fingers do not.
  const penOnly = useRef(penOnlySetting() === "on");
  const erasing = useRef(false);
  // The pointer drawing or erasing: a palm next to the pen is ignored.
  const active = useRef<number | null>(null);
  const previousTool = useRef<Tool>("pen");

  useEffect(() => {
    const img = new window.Image();
    img.onload = () => {
      image.current = img;
      setReady(true);
    };
    img.onerror = () => setFailed(true);
    img.src = base;
  }, [base]);

  // The canvas shows the photo as large as the dialog allows (the frame);
  // zoomed, it shows a part of it.
  const unit = image.current ? Math.max(1, Math.min(image.current.naturalWidth, image.current.naturalHeight) / 500) : 1;
  useEffect(() => {
    if (!ready) return;
    const measure = () => {
      const img = image.current;
      if (!img) return;
      // Within the stage (its padding: 8 px) and the dialog (at most 85 % of
      // the window high), below the tools (one or two rows) and the title and
      // above the buttons.
      const box = stage.current,
        tools = box?.parentElement?.querySelector(".annotator-tools");
      const maxW = Math.min(window.innerWidth - 80, 1100, box ? box.clientWidth - 16 : Infinity),
        maxH = window.innerHeight * 0.85 - 200 - (tools?.getBoundingClientRect().height ?? 40);
      const fit = Math.min(1, maxW / img.naturalWidth, maxH / img.naturalHeight);
      const next = { fit, width: Math.round(img.naturalWidth * fit), height: Math.round(img.naturalHeight * fit) };
      const before = layoutRef.current;
      if (before.fit === next.fit && before.width === next.width && before.height === next.height) return;
      if (before.width) apply(resizeView(viewRef.current, before, next));
      layoutRef.current = next;
      setLayout(next);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [ready, apply]);
  useEffect(() => {
    const el = canvas.current,
      img = image.current;
    if (!ready || !el || !img || !layout.width) return;
    const ratio = window.devicePixelRatio || 1;
    const w = Math.round(layout.width * ratio),
      h = Math.round(layout.height * ratio);
    if (el.width !== w || el.height !== h) {
      el.width = w;
      el.height = h;
      el.style.width = `${layout.width}px`;
      el.style.height = `${layout.height}px`;
    }
    const ctx = el.getContext("2d")!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const k = pixelScale(view, layout.fit) * ratio;
    ctx.setTransform(k, 0, 0, k, view.pan.x * ratio, view.pan.y * ratio);
    ctx.drawImage(img, 0, 0);
    drawShapes(ctx, draft ? [...shapes, draft] : shapes, unit);
  }, [ready, layout, view, shapes, draft, unit]);

  const size = () => ({ width: layoutRef.current.width, height: layoutRef.current.height });
  // A point of the screen on the canvas (CSS pixels from its top left).
  const local = (clientX: number, clientY: number): XY => {
    const rect = canvas.current!.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  };
  const toImage = (clientX: number, clientY: number): Point => {
    const p = screenToImage(viewRef.current, layoutRef.current.fit, local(clientX, clientY));
    return [p.x, p.y];
  };
  const point = (event: React.PointerEvent): Point => toImage(event.clientX, event.clientY);
  const add = (shape: Shape) => {
    setShapes((list) => [...list, shape].slice(-MAX_SHAPES));
    setUndone([]);
  };
  function commitText() {
    if (typing?.text.trim()) add({ type: "text", color, width, at: typing.at, text: typing.text.trim().slice(0, 200) });
    setTyping(null);
  }
  function choose(next: Tool) {
    commitText();
    setTool((now) => {
      if (now !== next) previousTool.current = now;
      return next;
    });
  }
  // Apple Pencil double-tap and squeeze (iPad app): eraser, previous tool or pen.
  useEffect(
    () =>
      onPencilAction(({ preferred }) => {
        if (preferred === "switchEraser") choose(tool === "eraser" ? (previousTool.current === "eraser" ? "pen" : previousTool.current) : "eraser");
        else if (preferred === "switchPrevious") choose(previousTool.current);
        else if (preferred !== "ignore") choose("pen");
      }),
  );
  function erase(points: Point[]) {
    const tolerance = 8 / pixelScale(viewRef.current, layoutRef.current.fit);
    setShapes((list) => {
      const kept = list.filter((shape) => !points.some((p) => shapeHit(shape, p, tolerance + shape.width)));
      if (kept.length !== list.length) setUndone((u) => [...u, ...list.filter((shape) => !kept.includes(shape))]);
      return kept.length === list.length ? list : kept;
    });
  }
  function placeText(event: React.PointerEvent) {
    commitText();
    setTyping({ at: point(event), text: "" });
  }
  // Two fingers: from now on they zoom and pan.
  function startPinch() {
    const [a, b] = [...touches.current.values()];
    gesture.current = { kind: "pinch", start: { ...viewRef.current, mid: midpoint(a, b), distance: distance(a, b) } };
  }
  // A drawing or erasing pointer stops (a second finger came).
  function stopDrawing() {
    active.current = null;
    erasing.current = false;
    activePen.current = false;
    setDraft(null);
  }
  function onDown(event: React.PointerEvent<HTMLDivElement>) {
    if (!ready || !canvas.current || (event.target as Element).closest("input")) return;
    notePenActivity(event);
    if (notePen(event)) penOnly.current = true;
    if (event.pointerType === "touch") {
      // The hand holding the pen, while it draws or a moment after: nothing.
      if (activePen.current || palmLikely(event)) return;
      touches.current.set(event.pointerId, local(event.clientX, event.clientY));
      event.currentTarget.setPointerCapture?.(event.pointerId);
      if (touches.current.size >= 2) {
        event.preventDefault();
        // A stroke the first finger began is no stroke.
        if (active.current !== null) stopDrawing();
        if (touches.current.size === 2) startPinch();
        return;
      }
      // Pen-only: a finger pans (and taps text in place).
      if (!drawsWith(event, penOnly.current)) {
        event.preventDefault();
        gesture.current = { kind: "pan", id: event.pointerId, from: local(event.clientX, event.clientY), view: viewRef.current, moved: false };
        return;
      }
    }
    if (event.target !== canvas.current) return;
    if (active.current !== null && active.current !== event.pointerId) return;
    event.preventDefault();
    const p = point(event);
    if (tool === "eraser" || isEraser(event)) {
      event.currentTarget.setPointerCapture?.(event.pointerId);
      active.current = event.pointerId;
      activePen.current = event.pointerType === "pen";
      erasing.current = true;
      erase([p]);
      return;
    }
    if (tool === "text") return placeText(event);
    event.currentTarget.setPointerCapture?.(event.pointerId);
    active.current = event.pointerId;
    activePen.current = event.pointerType === "pen";
    setDraft(tool === "pen" || tool === "marker" ? { type: tool, color, width, points: [p] } : { type: tool, color, width, from: p, to: p });
  }
  function onMove(event: React.PointerEvent<HTMLDivElement>) {
    notePenActivity(event);
    if (!canvas.current) return;
    if (touches.current.has(event.pointerId)) {
      const now = local(event.clientX, event.clientY);
      touches.current.set(event.pointerId, now);
      const g = gesture.current;
      if (g?.kind === "pinch") {
        const [a, b] = [...touches.current.values()];
        apply(framePinch(g.start, midpoint(a, b), pinchFactor(g.start.distance, distance(a, b)), MARKUP_ZOOM, size()));
        return;
      }
      if (g?.kind === "pan") {
        if (g.id !== event.pointerId) return;
        const delta = { x: now.x - g.from.x, y: now.y - g.from.y };
        if (Math.hypot(delta.x, delta.y) > TAP_MOVE) g.moved = true;
        apply(framePan(g.view, delta, size()));
        return;
      }
    }
    if (active.current === null || active.current !== event.pointerId) return;
    const all = () => samples(event).map((s): Point => toImage(s.clientX, s.clientY));
    if (erasing.current) return erase(all());
    const draft = draftRef.current;
    if (!draft) return;
    const p = point(event);
    // Every point the pen measured since the last event: smooth fast strokes.
    if (draft.type === "pen" || draft.type === "marker") setDraft({ ...draft, points: [...draft.points, ...all()] });
    else if (draft.type === "arrow" || draft.type === "rect" || draft.type === "ellipse") setDraft({ ...draft, to: p });
  }
  function onUp(event: React.PointerEvent<HTMLDivElement>) {
    notePenActivity(event);
    if (touches.current.delete(event.pointerId)) {
      const g = gesture.current;
      if (g?.kind === "pinch") {
        if (touches.current.size >= 2) return startPinch();
        // Hardly zoomed is not zoomed; a finger left on the screen pans on.
        const settled = settleView(viewRef.current, MARKUP_ZOOM);
        apply(settled);
        const [rest] = [...touches.current.entries()];
        gesture.current = rest ? { kind: "pan", id: rest[0], from: rest[1], view: settled, moved: true } : null;
        return;
      }
      if (g?.kind === "pan") {
        if (g.id !== event.pointerId) return;
        gesture.current = null;
        if (!g.moved && event.type === "pointerup" && tool === "text" && event.target === canvas.current) placeText(event);
        return;
      }
    }
    if (active.current === null || active.current !== event.pointerId) return;
    active.current = null;
    activePen.current = false;
    erasing.current = false;
    const draft = draftRef.current;
    if (!draft) return;
    const tiny =
      (draft.type === "arrow" || draft.type === "rect" || draft.type === "ellipse") &&
      Math.hypot(draft.to[0] - draft.from[0], draft.to[1] - draft.from[1]) < 3;
    if (!tiny) add(draft);
    setDraft(null);
  }
  // Zooming with the wheel, a trackpad and Safari's gesture events.
  useEffect(() => {
    const box = stage.current;
    if (!ready || !box) return;
    const at = (event: { clientX: number; clientY: number }) => {
      const rect = canvas.current?.getBoundingClientRect();
      return rect ? { x: event.clientX - rect.left, y: event.clientY - rect.top } : { x: 0, y: 0 };
    };
    const frame = () => ({ width: layoutRef.current.width, height: layoutRef.current.height });
    const show = (next: FrameView) => {
      viewRef.current = next;
      setView(next);
    };
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        show(frameZoom(viewRef.current, at(event), wheelFactor(event.deltaY, event.deltaMode), MARKUP_ZOOM, frame()));
      } else if (viewRef.current.scale > 1) {
        event.preventDefault();
        show(wheelPan(viewRef.current, event.deltaX, event.deltaY, event.deltaMode, frame()));
      }
    };
    // Safari (trackpad on the Mac): `scale` counts from the gesture's start.
    // On iOS fingers are handled as pointers; the page itself never zooms.
    type GestureEvent = UIEvent & { scale: number; clientX: number; clientY: number };
    let start: (FrameView & { mid: XY }) | null = null;
    const onGestureStart = (event: Event) => {
      event.preventDefault();
      start = touches.current.size ? null : { ...viewRef.current, mid: at(event as GestureEvent) };
    };
    const onGestureChange = (event: Event) => {
      event.preventDefault();
      if (start) show(framePinch(start, start.mid, (event as GestureEvent).scale || 1, MARKUP_ZOOM, frame()));
    };
    const onGestureEnd = (event: Event) => {
      event.preventDefault();
      start = null;
    };
    const onTouchMove = (event: TouchEvent) => {
      if (event.touches.length > 1 && event.cancelable) event.preventDefault();
    };
    const options = { passive: false } as const;
    box.addEventListener("wheel", onWheel, options);
    box.addEventListener("gesturestart", onGestureStart, options);
    box.addEventListener("gesturechange", onGestureChange, options);
    box.addEventListener("gestureend", onGestureEnd, options);
    box.addEventListener("touchmove", onTouchMove, options);
    return () => {
      box.removeEventListener("wheel", onWheel);
      box.removeEventListener("gesturestart", onGestureStart);
      box.removeEventListener("gesturechange", onGestureChange);
      box.removeEventListener("gestureend", onGestureEnd);
      box.removeEventListener("touchmove", onTouchMove);
    };
  }, [ready]);
  const zoomBy = (direction: 1 | -1) => apply(stepView(viewRef.current, direction, size()));
  const fitView = () => apply(clampView(FRAME_VIEW, size()));
  function undo() {
    setShapes((list) => {
      if (!list.length) return list;
      setUndone((u) => [...u, list[list.length - 1]]);
      return list.slice(0, -1);
    });
  }
  function redo() {
    setUndone((u) => {
      if (!u.length) return u;
      setShapes((list) => [...list, u[u.length - 1]]);
      return u.slice(0, -1);
    });
  }
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (typing) return;
      if ((event.metaKey || event.ctrlKey) && shortcutLetter(event) === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      // + / − / 0: zoom in, out and fit (not while typing in a field).
      if (event.metaKey || event.ctrlKey || event.altKey || (event.target as Element | null)?.closest?.("input, textarea, [contenteditable=true]")) return;
      if (event.key === "+" || event.key === "=") zoomBy(1);
      else if (event.key === "-" || event.key === "−") zoomBy(-1);
      else if (event.key === "0") fitView();
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });

  async function save() {
    const img = image.current;
    if (!img) return;
    setBusy(true);
    setError("");
    try {
      const out = document.createElement("canvas");
      out.width = img.naturalWidth;
      out.height = img.naturalHeight;
      const ctx = out.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      drawShapes(ctx, shapes, unit);
      // Photos stay JPEG (small), everything else PNG (sharp edges).
      const type = /\.(jpe?g|webp|heic)(\?|$)/i.test(base) ? "image/jpeg" : "image/png";
      const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, type, 0.9));
      if (!blob) throw new Error(t("Das Bild konnte nicht gespeichert werden.", "The image could not be saved."));
      await onSave({ blob, shapes: shapes.length ? JSON.stringify(shapes) : "", original: base });
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  // A single key in a title, where keyboard hints are shown.
  const plainKey = (key: string) => (keyHints.visible ? ` (${key})` : "");
  // Where the text being typed sits on the canvas (it follows the view).
  const textAt = ([x, y]: Point) => {
    const at = imageToScreen(view, layout.fit, { x, y });
    return { left: at.x, top: at.y };
  };
  const tools: [Tool, string, React.ReactNode][] = [
    ["pen", t("Stift", "Pen"), <PencilSimple key="p" size={18} />],
    ["marker", t("Textmarker", "Highlighter"), <HighlighterCircle key="m" size={18} />],
    ["arrow", t("Pfeil", "Arrow"), <ArrowUpRight key="a" size={18} />],
    ["rect", t("Rechteck", "Rectangle"), <Square key="r" size={18} />],
    ["ellipse", t("Kreis", "Circle"), <Circle key="e" size={18} />],
    ["text", t("Text", "Text"), <TextT key="t" size={18} />],
    ["eraser", t("Radierer", "Eraser"), <Eraser key="x" size={18} />],
  ];
  return (
    <Modal open wide title={t("Bild markieren", "Mark up image")} onClose={onClose}>
      <div className="annotator">
        <div className="annotator-tools" role="toolbar" aria-label={t("Werkzeuge", "Tools")}>
          <div role="radiogroup" aria-label={t("Werkzeug", "Tool")}>
            {tools.map(([id, label, icon]) => (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={tool === id}
                aria-label={label}
                title={label}
                className={tool === id ? "active" : ""}
                onClick={() => choose(id)}
              >
                {icon}
              </button>
            ))}
          </div>
          <div role="radiogroup" aria-label={t("Farbe", "Colour")}>
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={color === c}
                aria-label={t(`Farbe ${c}`, `Colour ${c}`)}
                className={`annotator-color${color === c ? " active" : ""}`}
                style={{ "--swatch": c } as React.CSSProperties}
                onClick={() => setColor(c)}
              />
            ))}
          </div>
          <div role="radiogroup" aria-label={t("Strichstärke", "Line width")}>
            {WIDTHS.map((w) => (
              <button
                key={w}
                type="button"
                role="radio"
                aria-checked={width === w}
                aria-label={t(`Strichstärke ${w}`, `Line width ${w}`)}
                className={width === w ? "active" : ""}
                onClick={() => setWidth(w)}
              >
                <span className="annotator-width" style={{ height: w * 2 + 1 }} />
              </button>
            ))}
          </div>
          <div>
            <button type="button" aria-label={t("Rückgängig", "Undo")} title={t("Rückgängig", "Undo") + keyHints.suffix("Mod+Z")} disabled={!shapes.length} onClick={undo}>
              <ArrowArcLeft size={18} />
            </button>
            <button type="button" aria-label={t("Wiederholen", "Redo")} title={t("Wiederholen", "Redo") + keyHints.suffix("Mod+Shift+Z")} disabled={!undone.length} onClick={redo}>
              <ArrowArcRight size={18} />
            </button>
            <button
              type="button"
              aria-label={t("Alle Markierungen entfernen", "Remove all markings")}
              title={t("Alle Markierungen entfernen", "Remove all markings")}
              disabled={!shapes.length}
              onClick={() => {
                setUndone([...shapes].reverse());
                setShapes([]);
              }}
            >
              <Trash size={18} />
            </button>
          </div>
          <div className="annotator-zoom" role="group" aria-label={t("Zoom", "Zoom")}>
            <button
              type="button"
              aria-label={t("Verkleinern", "Zoom out")}
              title={t("Verkleinern", "Zoom out") + plainKey("−")}
              disabled={view.scale <= MARKUP_ZOOM.min}
              onClick={() => zoomBy(-1)}
            >
              <MagnifyingGlassMinus size={18} />
            </button>
            <span className="annotator-zoom-value" role="status" aria-label={t("Zoomstufe", "Zoom level")}>
              {Math.round(view.scale * 100)} %
            </span>
            <button
              type="button"
              aria-label={t("Vergrößern", "Zoom in")}
              title={t("Vergrößern", "Zoom in") + plainKey("+")}
              disabled={view.scale >= MARKUP_ZOOM.max}
              onClick={() => zoomBy(1)}
            >
              <MagnifyingGlassPlus size={18} />
            </button>
            <button
              type="button"
              className="annotator-fit"
              title={t("Ganzes Bild zeigen", "Show the whole image") + plainKey("0")}
              disabled={view.scale === 1 && !view.pan.x && !view.pan.y}
              onClick={fitView}
            >
              {t("Einpassen", "Fit")}
            </button>
          </div>
        </div>
        <div ref={stage} className="annotator-stage" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
          {failed ? (
            <p role="alert" className="field-error">
              {t("Das Bild konnte nicht geladen werden.", "The image could not be loaded.")}
            </p>
          ) : (
            <div className="annotator-canvas">
              <canvas
                ref={canvas}
                aria-label={t("Bild zum Markieren", "Image to mark up")}
                data-tool={tool}
                data-zoomed={view.scale > 1 ? "" : undefined}
              />
              {typing && (
                <input
                  autoFocus
                  className="annotator-text"
                  aria-label={t("Text auf dem Bild", "Text on the image")}
                  style={{ ...textAt(typing.at), color }}
                  value={typing.text}
                  maxLength={200}
                  onChange={(e) => setTyping({ ...typing, text: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitText();
                    if (e.key === "Escape") {
                      e.stopPropagation();
                      setTyping(null);
                    }
                  }}
                  onBlur={commitText}
                />
              )}
            </div>
          )}
        </div>
        {error && (
          <p role="alert" className="field-error">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose}>
            {t("Abbrechen", "Cancel")}
          </button>
          <button type="button" className="button primary" disabled={!ready || busy} onClick={() => void save()}>
            {busy ? t("Wird gespeichert …", "Saving …") : t("Speichern", "Save")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
