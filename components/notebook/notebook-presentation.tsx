"use client";
// "Präsentieren": the notebook full screen, one sheet at a time (Fullscreen
// API where the browser has it – otherwise, as in the iPhone/iPad app, an
// overlay over everything), without toolbars. Arrow keys, Page Up/Down (a
// clicker), Space, Home/End and a horizontal swipe move; Escape ends.
// Tools: the laser pointer (a glowing dot with a short fading trail) and a
// marker whose strokes fade after a few seconds – neither is saved. Links on
// the sheets follow with a tap.
//
// Follow mode (use-notebook-live.ts): while someone presents, the others
// who have the notebook open get "Folgen" – the same view, showing the
// presenter's sheet and pointer live. Readers follow too.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CaretLeft, CaretRight, CursorClick, Hand, HighlighterCircle, X } from "@phosphor-icons/react";
import { useT } from "../i18n";
import { InkLayer } from "../ink/ink-layer";
import { PaperSvg, PdfBackground } from "./paper";
import { SheetLinks } from "./sheet-links";
import { usePresenting, type LivePoint, type Presenter } from "./use-notebook-live";
import { clientToPage, type PageSize } from "@/lib/ink/coords";
import type { InkDoc } from "@/lib/ink/model";
import type { Paper, PaperLayout } from "@/lib/notebook-paper";
import type { NotebookSheet } from "@/lib/notebook";
import type { NotebookLinkTarget } from "@/lib/notebook-organize-model";
import { pointerTrail, type TrailPoint } from "@/lib/notebook-pointer";

type Tool = "laser" | "marker" | "hand";
type Stroke = { points: TrailPoint[]; ended: number | null };
export const LASER_MS = 700;
export const MARKER_MS = 3000;

type FullscreenElement = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };
type FullscreenDocument = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => Promise<void> | void };

// Trails and fading strokes of one pointer (own or the presenter's).
function usePointerInk() {
  const [, setTick] = useState(0);
  const laser = useRef<TrailPoint[]>([]);
  const strokes = useRef<Stroke[]>([]);
  const frame = useRef(0);
  const animate = useCallback(() => {
    cancelAnimationFrame(frame.current);
    const tick = () => {
      const now = Date.now();
      laser.current = laser.current.filter((p) => now - p.t < LASER_MS);
      strokes.current = strokes.current.filter((s) => s.ended === null || now - s.ended < MARKER_MS);
      setTick((n) => n + 1);
      if (laser.current.length || strokes.current.length) frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
  }, []);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  const point = useCallback(
    (p: LivePoint | null) => {
      const now = Date.now();
      const open = strokes.current.find((s) => s.ended === null);
      if (!p || !p.mark) {
        if (open) open.ended = now;
      }
      if (p?.laser) laser.current = [...laser.current, { x: p.x, y: p.y, t: now }].slice(-60);
      if (p?.mark) {
        if (open) open.points.push({ x: p.x, y: p.y, t: now });
        else strokes.current.push({ points: [{ x: p.x, y: p.y, t: now }], ended: null });
      }
      animate();
    },
    [animate],
  );
  const clear = useCallback(() => {
    laser.current = [];
    strokes.current = [];
    animate();
  }, [animate]);
  return { laser: laser.current, strokes: strokes.current, point, clear };
}

function PointerLayer({ size, laser, strokes, scale }: { size: PageSize; laser: TrailPoint[]; strokes: Stroke[]; scale: number }) {
  const now = Date.now();
  const unit = 1 / (scale || 1);
  const trail = pointerTrail(laser, now, LASER_MS);
  const head = laser[laser.length - 1];
  return (
    <svg className="notebook-pointer-layer" viewBox={`0 0 ${size.width} ${size.height}`} preserveAspectRatio="none" aria-hidden="true">
      {strokes.map((s, i) => {
        const fade = s.ended === null ? 1 : Math.max(0, Math.min(1, (MARKER_MS - (now - s.ended)) / 1000));
        return (
          <polyline
            key={i}
            className="notebook-marker-stroke"
            points={s.points.map((p) => `${p.x},${p.y}`).join(" ")}
            strokeWidth={unit * 18}
            style={{ opacity: 0.45 * fade }}
          />
        );
      })}
      {trail.map((segment, i) => (
        <line key={i} className="notebook-laser-trail" x1={segment.x1} y1={segment.y1} x2={segment.x2} y2={segment.y2} strokeWidth={unit * 5 * segment.weight} style={{ opacity: segment.weight }} />
      ))}
      {head && now - head.t < LASER_MS && (
        <>
          <circle className="notebook-laser-glow" cx={head.x} cy={head.y} r={unit * 14} />
          <circle className="notebook-laser-dot" cx={head.x} cy={head.y} r={unit * 5} />
        </>
      )}
    </svg>
  );
}

export function NotebookPresentation({
  pageId,
  title,
  sheets,
  sizes,
  layouts,
  doc,
  start,
  follow,
  onPoint,
  onSheet,
  onFollowLink,
  onClose,
}: {
  pageId: string;
  title: string;
  sheets: NotebookSheet[];
  sizes: Map<string, PageSize>;
  layouts: Map<string, { paper: Paper; layout: PaperLayout | null }>;
  doc: InkDoc;
  start: string;
  // Following someone: their sheet and pointer; without, this person presents.
  follow: Presenter | null;
  onPoint: (listener: (p: Presenter) => void) => () => void;
  onSheet?: (sheetId: string) => void;
  onFollowLink: (target: { page: string }) => void;
  onClose: (sheetId: string) => void;
}) {
  const t = useT();
  const root = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(() => Math.max(0, sheets.findIndex((s) => s.id === start)));
  const followed = follow ? sheets.findIndex((s) => s.id === follow.sheet) : -1;
  const shownIndex = follow ? Math.max(0, followed) : Math.min(index, sheets.length - 1);
  const sheet = sheets[shownIndex];
  const [tool, setTool] = useState<Tool>("laser");
  const [since] = useState(() => Date.now());
  const presenting = usePresenting(pageId, follow ? null : sheet ? { sheet: sheet.id, since } : null);
  const ink = usePointerInk();
  const sheetRef = useRef(sheet?.id);
  sheetRef.current = sheet?.id;
  useEffect(() => {
    if (sheet && !follow) onSheet?.(sheet.id);
    ink.clear();
  }, [sheet?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // The presenter's pointer, while following.
  useEffect(() => {
    if (!follow) return;
    return onPoint((p) => {
      if (p.userId !== follow.userId || p.sheet !== sheetRef.current) return;
      ink.point(p.point);
    });
  }, [follow?.userId, onPoint]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Full screen ----
  useEffect(() => {
    const el = root.current as FullscreenElement | null;
    const d = document as FullscreenDocument;
    let entered = false;
    try {
      const request = el?.requestFullscreen?.bind(el) ?? el?.webkitRequestFullscreen?.bind(el);
      const result = request?.();
      if (result && typeof (result as Promise<void>).then === "function") (result as Promise<void>).then(() => (entered = true)).catch(() => {});
      else if (request) entered = true;
    } catch {}
    const change = () => {
      // Leaving full screen with the browser's own Escape ends presenting.
      if (entered && !(d.fullscreenElement || d.webkitFullscreenElement)) onCloseRef.current();
    };
    document.addEventListener("fullscreenchange", change);
    document.addEventListener("webkitfullscreenchange", change);
    return () => {
      document.removeEventListener("fullscreenchange", change);
      document.removeEventListener("webkitfullscreenchange", change);
      if (d.fullscreenElement || d.webkitFullscreenElement) void (d.exitFullscreen?.() ?? d.webkitExitFullscreen?.())?.catch?.(() => {});
    };
  }, []);
  const close = useCallback(() => onClose(sheetRef.current || start), [onClose, start]);
  const onCloseRef = useRef(close);
  onCloseRef.current = close;

  // ---- Moving through the sheets ----
  const go = useCallback(
    (step: number | "first" | "last") => {
      if (follow) return;
      setIndex((i) => (step === "first" ? 0 : step === "last" ? sheets.length - 1 : Math.max(0, Math.min(sheets.length - 1, i + step))));
    },
    [follow, sheets.length],
  );
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement | null)?.closest?.("input, textarea, [contenteditable=true]")) return;
      const k = event.key;
      if (k === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
      } else if (["ArrowRight", "ArrowDown", "PageDown", " ", "Enter"].includes(k)) {
        event.preventDefault();
        go(1);
      } else if (["ArrowLeft", "ArrowUp", "PageUp", "Backspace"].includes(k)) {
        event.preventDefault();
        go(-1);
      } else if (k === "Home" || k === "End") {
        event.preventDefault();
        go(k === "Home" ? "first" : "last");
      } else if (!follow && !event.metaKey && !event.ctrlKey && !event.altKey && (k === "l" || k === "m" || k === "h")) {
        setTool(k === "l" ? "laser" : k === "m" ? "marker" : "hand");
      } else return;
      wake();
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  });

  // ---- The sheet, fit into the screen ----
  const [screen, setScreen] = useState({ width: 1024, height: 768 });
  useEffect(() => {
    const measure = () => setScreen({ width: window.innerWidth, height: window.innerHeight });
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  const size = sheet ? sizes.get(sheet.id)! : { width: 595, height: 842 };
  const look = sheet ? layouts.get(sheet.id) : undefined;
  const pad = 16;
  const scale = Math.min((screen.width - pad * 2) / size.width, (screen.height - pad * 2) / size.height);
  const width = Math.max(1, Math.floor(size.width * scale));
  const height = Math.max(1, Math.floor(size.height * scale));

  // ---- Controls that hide while nothing happens ----
  const [awake, setAwake] = useState(true);
  const sleep = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wake = useCallback(() => {
    setAwake(true);
    if (sleep.current) clearTimeout(sleep.current);
    sleep.current = setTimeout(() => setAwake(false), 2600);
  }, []);
  useEffect(() => {
    wake();
    return () => {
      if (sleep.current) clearTimeout(sleep.current);
    };
  }, [wake]);

  // ---- Pointer: laser, marker, swipe ----
  const surface = useRef<HTMLDivElement>(null);
  const gesture = useRef<{ pointer: number; x: number; y: number; type: string; drawing: boolean } | null>(null);
  const toSheet = (event: React.PointerEvent) => clientToPage(event.clientX, event.clientY, surface.current!.getBoundingClientRect(), size);
  const emit = (p: LivePoint | null) => {
    ink.point(p);
    presenting.move(p);
  };
  const down = (event: React.PointerEvent) => {
    wake();
    if (follow || (event.target as Element).closest(".notebook-links a, .notebook-links button")) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const drawing = tool !== "hand";
    gesture.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, type: event.pointerType, drawing };
    if (drawing) {
      event.preventDefault();
      surface.current?.setPointerCapture?.(event.pointerId);
      emit({ ...toSheet(event), laser: tool === "laser", mark: tool === "marker" });
    }
  };
  const move = (event: React.PointerEvent) => {
    if (follow) return;
    const g = gesture.current;
    // A mouse with the laser points without a button pressed.
    if (!g && event.pointerType === "mouse" && tool === "laser") {
      emit({ ...toSheet(event), laser: true });
      return;
    }
    if (!g || g.pointer !== event.pointerId || !g.drawing) return;
    const events = (event.nativeEvent as PointerEvent).getCoalescedEvents?.() || [event.nativeEvent];
    for (const e of events.slice(-4)) {
      const p = clientToPage(e.clientX, e.clientY, surface.current!.getBoundingClientRect(), size);
      emit({ ...p, laser: tool === "laser", mark: tool === "marker" });
    }
  };
  const up = (event: React.PointerEvent) => {
    const g = gesture.current;
    if (!g || g.pointer !== event.pointerId) return;
    gesture.current = null;
    if (g.drawing) {
      emit(event.pointerType === "mouse" && tool === "laser" ? { ...toSheet(event), laser: true } : null);
      return;
    }
    // Hand: a swipe sideways turns the sheet.
    const dx = event.clientX - g.x,
      dy = event.clientY - g.y;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.4) go(dx < 0 ? 1 : -1);
  };
  const leave = () => {
    if (!follow && tool === "laser" && !gesture.current) emit(null);
  };

  const sheetName = useMemo(() => {
    const names = new Map(sheets.map((s, i) => [s.id, s.title || t(`Blatt ${i + 1}`, `Sheet ${i + 1}`)]));
    return (sid: string) => names.get(sid) || t("Blatt", "Sheet");
  }, [sheets, t]);
  const followLink = (target: NotebookLinkTarget) => {
    if ("sheet" in target) {
      const i = sheets.findIndex((s) => s.id === target.sheet);
      if (i >= 0 && !follow) setIndex(i);
    } else onFollowLink(target);
  };

  if (typeof document === "undefined" || !sheet) return null;
  const dark = !sheet.background && look?.paper.color === "dark";
  return createPortal(
    <div
      ref={root}
      className={`notebook-presentation${awake ? " is-awake" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label={follow ? t(`${follow.name} präsentiert`, `${follow.name} is presenting`) : t(`Präsentation: ${title}`, `Presentation: ${title}`)}
      onPointerMove={wake}
    >
      <div
        ref={surface}
        className={`notebook-sheet notebook-presentation-sheet${dark ? " is-dark" : ""}`}
        data-tool={follow ? undefined : tool}
        style={{ width, height }}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onPointerLeave={leave}
        onContextMenu={(e) => e.preventDefault()}
      >
        {sheet.background ? (
          <PdfBackground key={sheet.id} src={`/api/files/${sheet.background.file}`} page={sheet.background.page} width={width} eager />
        ) : look?.layout ? (
          <PaperSvg layout={look.layout} />
        ) : null}
        <InkLayer page={sheet.id} size={size} doc={doc} label={t(`Handschrift auf Blatt ${shownIndex + 1}`, `Handwriting on sheet ${shownIndex + 1}`)} />
        <PointerLayer size={size} laser={ink.laser} strokes={ink.strokes} scale={scale} />
        <SheetLinks links={sheet.links || []} size={size} editable={false} areas={tool === "hand" || !!follow} sheetName={sheetName} onFollow={followLink} />
      </div>
      <div className="notebook-presentation-bar" role="toolbar" aria-label={t("Präsentation", "Presentation")} onPointerDown={wake}>
        {follow ? (
          <span className="notebook-presentation-follow" role="status">
            {t(`Du folgst ${follow.name}`, `You follow ${follow.name}`)}
          </span>
        ) : (
          <>
            <button type="button" aria-label={t("Vorheriges Blatt", "Previous sheet")} title={t("Vorheriges Blatt", "Previous sheet")} disabled={shownIndex === 0} onClick={() => go(-1)}>
              <CaretLeft size={20} />
            </button>
            <div role="radiogroup" aria-label={t("Zeiger", "Pointer")} className="notebook-presentation-tools">
              <button type="button" role="radio" aria-checked={tool === "laser"} className={tool === "laser" ? "active" : ""} title={t("Laserpointer (L)", "Laser pointer (L)")} aria-label={t("Laserpointer", "Laser pointer")} onClick={() => setTool("laser")}>
                <CursorClick size={19} />
              </button>
              <button type="button" role="radio" aria-checked={tool === "marker"} className={tool === "marker" ? "active" : ""} title={t("Verblassender Marker (M)", "Fading marker (M)")} aria-label={t("Verblassender Marker", "Fading marker")} onClick={() => setTool("marker")}>
                <HighlighterCircle size={19} />
              </button>
              <button type="button" role="radio" aria-checked={tool === "hand"} className={tool === "hand" ? "active" : ""} title={t("Blättern und Links (H)", "Swipe and links (H)")} aria-label={t("Blättern und Links", "Swipe and links")} onClick={() => setTool("hand")}>
                <Hand size={19} />
              </button>
            </div>
            <button type="button" aria-label={t("Nächstes Blatt", "Next sheet")} title={t("Nächstes Blatt", "Next sheet")} disabled={shownIndex >= sheets.length - 1} onClick={() => go(1)}>
              <CaretRight size={20} />
            </button>
          </>
        )}
        <span className="notebook-presentation-count" aria-live="polite">
          {t(`${shownIndex + 1} / ${sheets.length}`, `${shownIndex + 1} / ${sheets.length}`)}
        </span>
        <button type="button" aria-label={follow ? t("Nicht mehr folgen", "Stop following") : t("Präsentation beenden", "End presentation")} title={(follow ? t("Nicht mehr folgen", "Stop following") : t("Präsentation beenden", "End presentation")) + " (Esc)"} onClick={close}>
          <X size={20} />
        </button>
      </div>
    </div>,
    document.body,
  );
}
