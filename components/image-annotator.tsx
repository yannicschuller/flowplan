"use client";
// Marking up a photo in a document: pen, highlighter, arrow, rectangle,
// ellipse and text in a few colours. Shapes are kept in the image's own
// pixels, so they stay sharp at any size. Saving writes a new image with the
// markings; the original and the shapes stay on the image, so the markings
// can be changed or removed later without loss.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowArcLeft,
  ArrowArcRight,
  ArrowUpRight,
  Circle,
  Eraser,
  HighlighterCircle,
  PencilSimple,
  Square,
  TextT,
  Trash,
} from "@phosphor-icons/react";
import { useT } from "./i18n";
import { drawsWith, isEraser, notePen, onPencilAction, penOnlySetting, samples } from "@/lib/stylus";
import { Modal } from "./ui";

type Tool = "pen" | "marker" | "arrow" | "rect" | "ellipse" | "text" | "eraser";
type Point = [number, number];
export type Shape =
  | { type: "pen" | "marker"; color: string; width: number; points: Point[] }
  | { type: "arrow" | "rect" | "ellipse"; color: string; width: number; from: Point; to: Point }
  | { type: "text"; color: string; width: number; at: Point; text: string };

const COLORS = ["#e03131", "#f08c00", "#fab005", "#2f9e44", "#1c7ed6", "#212529", "#ffffff"];
const WIDTHS = [1, 2, 4];
const MAX_SHAPES = 500;

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
    [draft, setDraft] = useState<Shape | null>(null),
    [typing, setTyping] = useState<{ at: Point; screen: Point; text: string } | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [scale, setScale] = useState(1);
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

  // The canvas shows the photo as large as the dialog allows.
  const unit = image.current ? Math.max(1, Math.min(image.current.naturalWidth, image.current.naturalHeight) / 500) : 1;
  const paint = useCallback(() => {
    const el = canvas.current,
      img = image.current;
    if (!el || !img) return;
    const maxW = Math.min(window.innerWidth - 80, 1100),
      maxH = window.innerHeight - 260;
    const s = Math.min(1, maxW / img.naturalWidth, maxH / img.naturalHeight);
    setScale(s);
    const ratio = window.devicePixelRatio || 1;
    el.width = Math.round(img.naturalWidth * s * ratio);
    el.height = Math.round(img.naturalHeight * s * ratio);
    el.style.width = `${Math.round(img.naturalWidth * s)}px`;
    el.style.height = `${Math.round(img.naturalHeight * s)}px`;
    const ctx = el.getContext("2d")!;
    ctx.setTransform(s * ratio, 0, 0, s * ratio, 0, 0);
    ctx.drawImage(img, 0, 0);
    drawShapes(ctx, draft ? [...shapes, draft] : shapes, unit);
  }, [shapes, draft, unit]);
  useEffect(() => {
    if (!ready) return;
    paint();
    window.addEventListener("resize", paint);
    return () => window.removeEventListener("resize", paint);
  }, [ready, paint]);

  const point = (event: React.PointerEvent): Point => {
    const rect = canvas.current!.getBoundingClientRect();
    return [(event.clientX - rect.left) / scale, (event.clientY - rect.top) / scale];
  };
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
    const tolerance = 8 / scale;
    setShapes((list) => {
      const kept = list.filter((shape) => !points.some((p) => shapeHit(shape, p, tolerance + shape.width)));
      if (kept.length !== list.length) setUndone((u) => [...u, ...list.filter((shape) => !kept.includes(shape))]);
      return kept.length === list.length ? list : kept;
    });
  }
  function onDown(event: React.PointerEvent) {
    if (!ready || (active.current !== null && active.current !== event.pointerId)) return;
    if (notePen(event)) penOnly.current = true;
    if (!drawsWith(event, penOnly.current) && tool !== "text") return;
    event.preventDefault();
    const p = point(event);
    if (tool === "eraser" || isEraser(event)) {
      (event.target as Element).setPointerCapture(event.pointerId);
      active.current = event.pointerId;
      erasing.current = true;
      erase([p]);
      return;
    }
    if (tool === "text") {
      commitText();
      const rect = canvas.current!.getBoundingClientRect();
      setTyping({ at: p, screen: [event.clientX - rect.left, event.clientY - rect.top], text: "" });
      return;
    }
    (event.target as Element).setPointerCapture(event.pointerId);
    active.current = event.pointerId;
    setDraft(tool === "pen" || tool === "marker" ? { type: tool, color, width, points: [p] } : { type: tool, color, width, from: p, to: p });
  }
  function onMove(event: React.PointerEvent) {
    if (active.current !== null && active.current !== event.pointerId) return;
    const all = () => {
      const rect = canvas.current!.getBoundingClientRect();
      return samples(event).map((s): Point => [(s.clientX - rect.left) / scale, (s.clientY - rect.top) / scale]);
    };
    if (erasing.current) return erase(all());
    if (!draft) return;
    const p = point(event);
    // Every point the pen measured since the last event: smooth fast strokes.
    if (draft.type === "pen" || draft.type === "marker") setDraft({ ...draft, points: [...draft.points, ...all()] });
    else if (draft.type === "arrow" || draft.type === "rect" || draft.type === "ellipse") setDraft({ ...draft, to: p });
  }
  function onUp(event: React.PointerEvent) {
    if (active.current !== null && active.current !== event.pointerId) return;
    active.current = null;
    erasing.current = false;
    if (!draft) return;
    const tiny =
      (draft.type === "arrow" || draft.type === "rect" || draft.type === "ellipse") &&
      Math.hypot(draft.to[0] - draft.from[0], draft.to[1] - draft.from[1]) < 3;
    if (!tiny) add(draft);
    setDraft(null);
  }
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
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      }
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
            <button type="button" aria-label={t("Rückgängig", "Undo")} title={t("Rückgängig (⌘Z)", "Undo (⌘Z)")} disabled={!shapes.length} onClick={undo}>
              <ArrowArcLeft size={18} />
            </button>
            <button type="button" aria-label={t("Wiederholen", "Redo")} title={t("Wiederholen (⇧⌘Z)", "Redo (⇧⌘Z)")} disabled={!undone.length} onClick={redo}>
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
        </div>
        <div className="annotator-stage">
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
                onPointerDown={onDown}
                onPointerMove={onMove}
                onPointerUp={onUp}
                onPointerCancel={onUp}
              />
              {typing && (
                <input
                  autoFocus
                  className="annotator-text"
                  aria-label={t("Text auf dem Bild", "Text on the image")}
                  style={{ left: typing.screen[0], top: typing.screen[1], color }}
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
