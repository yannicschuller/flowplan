"use client";
// "Bildverdeckung bearbeiten" (docs/specs/flashcards.md §5.5): masks over a
// picture of a record's document, stored on the picture as data-occlusion
// (lib/study-occlusion.ts) – the picture itself stays as it is.
//
// - Draw rectangles and ellipses by dragging, polygons by tapping their
//   corners (close on the first corner, Enter, a double click or "Fertig");
//   move masks by dragging, resize the selected one at its corners.
// - Keyboard: "Maske hinzufügen" puts a rectangle in the middle; on the
//   picture the arrow keys move the selected masks (Shift: further), with
//   Alt they change the size, Delete removes, G groups or ungroups, Escape
//   ends a polygon or the selection, ⌘Z/Ctrl+Z undoes.
// - Each mask, or each group ("gemeinsam abfragen"), is one card; the list
//   numbers them as the cards and takes the labels (the answer on the
//   back). The mode applies to the picture: cover all and ask one, or cover
//   only the one asked.
// - The masks are an SVG layer over the picture in the picture's own
//   pixels (its viewBox), so handles stay square; geometry is SVG
//   attributes, colours are classes – no inline styles.
// Loaded on demand (components/editor.tsx, next/dynamic).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowArcLeft, ArrowArcRight, Circle, Cursor, ExcludeSquare, Eye, Info, Plus, Polygon, Square, Trash, UniteSquare } from "@phosphor-icons/react";
import { useT } from "../i18n";
import { Modal } from "../ui";
import { MaskShape, OcclusionImage } from "./card-parts";
import { useKeyboardHints } from "@/lib/keyboard-hints";
import { shortcutLetter } from "@/lib/keymap";
import {
  MAX_MASKS,
  MAX_POINTS,
  MIN_SIZE,
  boundsOf,
  occlusionAttribute,
  occlusionTargets,
  parseOcclusion,
  type OcclusionMask,
  type OcclusionMode,
  type OcclusionPoint,
} from "@/lib/study-occlusion";

export type OcclusionEditResult = { occlusion: string | null; alt: string };
type Tool = "select" | "rect" | "ellipse" | "polygon";
type Box = { x: number; y: number; w: number; h: number };
type Drag = { pointer: number; kind: "move" | "resize"; corner: number; start: OcclusionPoint; before: OcclusionMask[]; moved: boolean };
type Snapshot = { masks: OcclusionMask[]; mode: OcclusionMode };

const clamp = (n: number, min = 0, max = 1) => Math.min(max, Math.max(min, n));
const round = (n: number) => Math.round(n * 10_000) / 10_000;
const newId = () => crypto.randomUUID();
// A mask stretched into a new box (a polygon's corners with it).
function fitted(mask: OcclusionMask, box: Box): OcclusionMask {
  const next = { ...mask, x: round(box.x), y: round(box.y), w: round(box.w), h: round(box.h) };
  if (mask.shape === "polygon" && mask.points)
    next.points = mask.points.map(([px, py]) => [
      round(clamp(box.x + ((px - mask.x) / (mask.w || 1)) * box.w)),
      round(clamp(box.y + ((py - mask.y) / (mask.h || 1)) * box.h)),
    ]);
  return next;
}
const boxOf = (a: OcclusionPoint, b: OcclusionPoint): Box => ({ x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(b[0] - a[0]), h: Math.abs(b[1] - a[1]) });
const corners = (m: Box): OcclusionPoint[] => [
  [m.x, m.y],
  [m.x + m.w, m.y],
  [m.x + m.w, m.y + m.h],
  [m.x, m.y + m.h],
];

export function OcclusionEditor({ src, alt, value, onSave, onClose }: { src: string; alt: string; value: string | null; onSave: (result: OcclusionEditResult) => void; onClose: () => void }) {
  const t = useT();
  const keyHints = useKeyboardHints();
  const initial = useMemo(() => parseOcclusion(value), [value]);
  const [masks, setMasks] = useState<OcclusionMask[]>(initial?.masks || []),
    [mode, setMode] = useState<OcclusionMode>(initial?.mode || "hide-all"),
    [past, setPast] = useState<Snapshot[]>([]),
    [future, setFuture] = useState<Snapshot[]>([]),
    [selected, setSelected] = useState<string[]>([]),
    [tool, setTool] = useState<Tool>("rect"),
    [draft, setDraft] = useState<{ pointer: number; from: OcclusionPoint; to: OcclusionPoint } | null>(null),
    [polygon, setPolygon] = useState<OcclusionPoint[] | null>(null),
    [hover, setHover] = useState<OcclusionPoint | null>(null),
    [size, setSize] = useState<{ w: number; h: number } | null>(null),
    [shown, setShown] = useState(0),
    [failed, setFailed] = useState(false),
    [altText, setAltText] = useState(alt),
    [preview, setPreview] = useState<{ revealed: boolean } | null>(null),
    [status, setStatus] = useState("");
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<Drag | null>(null);
  const image = useRef<HTMLImageElement>(null);
  const labelling = useRef<string | null>(null);
  // When the last pointer went down in the dialog (see the label fields).
  const pointerAt = useRef(0);

  // The picture's size on screen, for handles that stay the same size.
  useEffect(() => {
    const el = image.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setShown(el.getBoundingClientRect().width));
    observer.observe(el);
    return () => observer.disconnect();
  }, [size]);
  const W = size?.w || 1000,
    H = size?.h || 1000;
  const px = shown > 0 ? W / shown : 1; // image pixels per screen pixel

  const occlusion = useMemo(() => ({ v: 1 as const, mode, masks }), [mode, masks]);
  const targets = useMemo(() => occlusionTargets(occlusion), [occlusion]);
  const number = useMemo(() => {
    const out = new Map<string, number>();
    targets.forEach((target, i) => target.masks.forEach((id) => out.set(id, i + 1)));
    return out;
  }, [targets]);

  // Every change goes through here (undo keeps up to 50 steps).
  const remember = useCallback(() => {
    setPast((list) => [...list, { masks, mode }].slice(-50));
    setFuture([]);
  }, [masks, mode]);
  const change = (next: OcclusionMask[], nextMode = mode) => {
    remember();
    setMasks(next.slice(0, MAX_MASKS));
    setMode(nextMode);
  };
  const undo = () => {
    const last = past.at(-1);
    if (!last) return;
    setFuture((list) => [...list, { masks, mode }]);
    setPast((list) => list.slice(0, -1));
    setMasks(last.masks);
    setMode(last.mode);
    setSelected((ids) => ids.filter((id) => last.masks.some((m) => m.id === id)));
  };
  const redo = () => {
    const next = future.at(-1);
    if (!next) return;
    setPast((list) => [...list, { masks, mode }]);
    setFuture((list) => list.slice(0, -1));
    setMasks(next.masks);
    setMode(next.mode);
  };

  const point = (event: { clientX: number; clientY: number }): OcclusionPoint => {
    const rect = svg.current!.getBoundingClientRect();
    return [round(clamp((event.clientX - rect.left) / rect.width)), round(clamp((event.clientY - rect.top) / rect.height))];
  };
  const add = (mask: OcclusionMask) => {
    if (masks.length >= MAX_MASKS) {
      setStatus(t(`Höchstens ${MAX_MASKS} Masken je Bild.`, `At most ${MAX_MASKS} masks per picture.`));
      return;
    }
    change([...masks, mask]);
    setSelected([mask.id]);
    setStatus(t(`Maske ${masks.length + 1} hinzugefügt.`, `Mask ${masks.length + 1} added.`));
  };
  const finishPolygon = (points = polygon) => {
    setPolygon(null);
    setHover(null);
    if (!points || points.length < 3) return;
    const box = boundsOf(points);
    if (box.w < MIN_SIZE || box.h < MIN_SIZE) return;
    add({ id: newId(), shape: "polygon", ...box, points });
  };
  const remove = (ids: string[]) => {
    if (!ids.length) return;
    change(masks.filter((m) => !ids.includes(m.id)));
    setSelected([]);
    setStatus(ids.length === 1 ? t("Maske gelöscht.", "Mask deleted.") : t(`${ids.length} Masken gelöscht.`, `${ids.length} masks deleted.`));
  };
  const chosen = masks.filter((m) => selected.includes(m.id));
  const canGroup = chosen.length > 1 && new Set(chosen.map((m) => m.group || m.id)).size > 1;
  const canUngroup = chosen.some((m) => m.group);
  const group = () => {
    if (!canGroup) return;
    // The group keeps the id of a group already there (its learning state).
    const id = chosen.find((m) => m.group)?.group || newId();
    change(masks.map((m) => (selected.includes(m.id) ? { ...m, group: id } : m)));
    setStatus(t(`${chosen.length} Masken gruppiert: eine Karte.`, `${chosen.length} masks grouped: one card.`));
  };
  const ungroup = () => {
    if (!canUngroup) return;
    change(masks.map((m) => (selected.includes(m.id) ? (({ group: _g, ...rest }) => rest)(m) : m)));
    setStatus(t("Gruppe gelöst: jede Maske eine Karte.", "Group removed: each mask is a card."));
  };
  // Moves (or with `resize` sizes) the selected masks by a step.
  const nudge = (dx: number, dy: number, resize: boolean) => {
    if (!chosen.length) return;
    const box = boundsOf(chosen.flatMap((m) => corners(m)));
    const mx = resize ? 0 : clamp(dx, -box.x, 1 - box.x - box.w),
      my = resize ? 0 : clamp(dy, -box.y, 1 - box.y - box.h);
    change(
      masks.map((m) => {
        if (!selected.includes(m.id)) return m;
        if (!resize) return fitted(m, { x: m.x + mx, y: m.y + my, w: m.w, h: m.h });
        return fitted(m, { x: m.x, y: m.y, w: clamp(m.w + dx, MIN_SIZE * 2, 1 - m.x), h: clamp(m.h + dy, MIN_SIZE * 2, 1 - m.y) });
      }),
    );
  };

  function onPointerDown(event: React.PointerEvent<SVGSVGElement>) {
    if (!size || (event.pointerType === "mouse" && event.button !== 0)) return;
    const target = event.target as Element;
    const p = point(event);
    const handle = target.closest("[data-handle]");
    const maskEl = target.closest("[data-mask]");
    event.currentTarget.focus({ preventScroll: true });
    if (polygon) {
      event.preventDefault();
      // The first corner again (within 12 screen pixels) closes it.
      const first = polygon[0];
      const near = Math.hypot((p[0] - first[0]) * W, (p[1] - first[1]) * H) <= 12 * px;
      if (near && polygon.length >= 3) finishPolygon();
      else if (polygon.length < MAX_POINTS) setPolygon([...polygon, p]);
      return;
    }
    if (handle && chosen.length === 1) {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { pointer: event.pointerId, kind: "resize", corner: Number(handle.getAttribute("data-handle")), start: p, before: masks, moved: false };
      return;
    }
    if (maskEl) {
      event.preventDefault();
      const id = maskEl.getAttribute("data-mask")!;
      if (event.shiftKey || event.metaKey || event.ctrlKey) {
        setSelected((ids) => (ids.includes(id) ? ids.filter((i) => i !== id) : [...ids, id]));
        return;
      }
      if (!selected.includes(id)) setSelected([id]);
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { pointer: event.pointerId, kind: "move", corner: -1, start: p, before: masks, moved: false };
      return;
    }
    if (tool === "select") {
      setSelected([]);
      return;
    }
    event.preventDefault();
    if (tool === "polygon") {
      setSelected([]);
      setPolygon([p]);
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    setDraft({ pointer: event.pointerId, from: p, to: p });
  }
  function onPointerMove(event: React.PointerEvent<SVGSVGElement>) {
    if (!size) return;
    const p = point(event);
    if (polygon) {
      setHover(p);
      return;
    }
    if (draft && draft.pointer === event.pointerId) {
      setDraft({ ...draft, to: p });
      return;
    }
    const d = drag.current;
    if (!d || d.pointer !== event.pointerId) return;
    const dx = p[0] - d.start[0],
      dy = p[1] - d.start[1];
    if (!d.moved && Math.hypot(dx * W, dy * H) < 3 * px) return;
    d.moved = true;
    if (d.kind === "move") {
      const moving = d.before.filter((m) => selected.includes(m.id));
      const box = boundsOf(moving.flatMap((m) => corners(m)));
      const mx = clamp(dx, -box.x, 1 - box.x - box.w),
        my = clamp(dy, -box.y, 1 - box.y - box.h);
      setMasks(d.before.map((m) => (selected.includes(m.id) ? fitted(m, { x: m.x + mx, y: m.y + my, w: m.w, h: m.h }) : m)));
    } else {
      const mask = d.before.find((m) => m.id === selected[0]);
      if (!mask) return;
      // The opposite corner stays.
      const fixed = corners(mask)[(d.corner + 2) % 4];
      const box = boxOf(fixed, p);
      if (box.w < MIN_SIZE * 2 || box.h < MIN_SIZE * 2) return;
      setMasks(d.before.map((m) => (m.id === mask.id ? fitted(m, box) : m)));
    }
  }
  function onPointerUp(event: React.PointerEvent<SVGSVGElement>) {
    if (draft && draft.pointer === event.pointerId) {
      setDraft(null);
      const box = boxOf(draft.from, draft.to);
      if (box.w >= MIN_SIZE * 2 && box.h >= MIN_SIZE * 2 && (tool === "rect" || tool === "ellipse")) add({ id: newId(), shape: tool, ...box });
      return;
    }
    const d = drag.current;
    if (!d || d.pointer !== event.pointerId) return;
    drag.current = null;
    // One step of undo for the whole drag.
    if (d.moved) {
      setPast((list) => [...list, { masks: d.before, mode }].slice(-50));
      setFuture([]);
    }
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if ((event.target as HTMLElement).closest("input, textarea, select")) return;
    const step = event.shiftKey ? 0.05 : 0.01;
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (event.key in arrows && chosen.length) {
      event.preventDefault();
      const [dx, dy] = arrows[event.key];
      nudge(dx, dy, event.altKey);
    } else if ((event.key === "Delete" || event.key === "Backspace") && chosen.length) {
      event.preventDefault();
      remove(selected);
    } else if (event.key === "Enter" && polygon) {
      event.preventDefault();
      finishPolygon();
    } else if (shortcutLetter(event.nativeEvent) === "g" && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      if (canGroup) group();
      else ungroup();
    }
  }
  // ⌘Z / Ctrl+Z anywhere in the dialog but in its fields.
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || shortcutLetter(event) !== "z") return;
      if ((event.target as HTMLElement | null)?.closest?.("input, textarea")) return;
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });

  const save = () => {
    onSave({ occlusion: occlusionAttribute(occlusion), alt: altText.replace(/\s+/g, " ").trim().slice(0, 500) });
    onClose();
  };
  const tools: [Tool, string, React.ReactNode][] = [
    ["select", t("Auswählen und verschieben", "Select and move"), <Cursor key="s" size={18} />],
    ["rect", t("Rechteck", "Rectangle"), <Square key="r" size={18} />],
    ["ellipse", t("Ellipse", "Ellipse"), <Circle key="e" size={18} />],
    ["polygon", t("Polygon (Ecken antippen)", "Polygon (tap its corners)"), <Polygon key="p" size={18} />],
  ];
  const shapeName = (m: OcclusionMask) => (m.shape === "rect" ? t("Rechteck", "Rectangle") : m.shape === "ellipse" ? t("Ellipse", "Ellipse") : t("Polygon", "Polygon"));
  const handle = 12 * px;
  const single = chosen.length === 1 ? chosen[0] : null;
  const previewTarget = targets.find((target) => target.masks.some((id) => selected.includes(id))) || targets[0];
  const previewIndex = previewTarget ? targets.indexOf(previewTarget) : -1;
  return (
    <Modal
      open
      wide
      title={t("Bildverdeckung bearbeiten", "Edit image occlusion")}
      onClose={onClose}
      className="occlusion-editor-dialog"
      onEscapeKeyDown={(event) => {
        // Escape ends a polygon or the selection before the dialog.
        if (polygon || draft || selected.length || preview) {
          event.preventDefault();
          if (preview) setPreview(null);
          else if (polygon) {
            setPolygon(null);
            setHover(null);
          } else if (draft) setDraft(null);
          else setSelected([]);
        }
      }}
    >
      <div
        className="occlusion-editor"
        onPointerDownCapture={() => {
          pointerAt.current = Date.now();
        }}
      >
        <div className="annotator-tools occlusion-tools" role="toolbar" aria-label={t("Werkzeuge", "Tools")}>
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
                onClick={() => {
                  if (polygon) finishPolygon();
                  setTool(id);
                }}
              >
                {icon}
              </button>
            ))}
          </div>
          <div>
            <button
              type="button"
              aria-label={t("Maske hinzufügen", "Add a mask")}
              title={t("Maske hinzufügen (Rechteck in der Mitte)", "Add a mask (a rectangle in the middle)")}
              disabled={!size}
              onClick={() => {
                const offset = (masks.length % 5) * 0.03;
                add({ id: newId(), shape: "rect", x: round(0.4 + offset), y: round(0.4 + offset), w: 0.2, h: 0.12 });
              }}
            >
              <Plus size={18} />
            </button>
            <button type="button" aria-label={t("Gruppieren", "Group")} title={t("Gruppieren: gemeinsam abfragen (G)", "Group: ask together (G)")} disabled={!canGroup} onClick={group}>
              <UniteSquare size={18} />
            </button>
            <button type="button" aria-label={t("Gruppe lösen", "Ungroup")} title={t("Gruppe lösen (G)", "Ungroup (G)")} disabled={!canUngroup} onClick={ungroup} className="occlusion-ungroup">
              <ExcludeSquare size={18} />
            </button>
            <button type="button" aria-label={t("Auswahl löschen", "Delete selection")} title={t("Auswahl löschen (Entf)", "Delete selection (Del)")} disabled={!chosen.length} onClick={() => remove(selected)}>
              <Trash size={18} />
            </button>
          </div>
          <div>
            <button type="button" aria-label={t("Rückgängig", "Undo")} title={t("Rückgängig", "Undo") + keyHints.suffix("Mod+Z")} disabled={!past.length} onClick={undo}>
              <ArrowArcLeft size={18} />
            </button>
            <button type="button" aria-label={t("Wiederholen", "Redo")} title={t("Wiederholen", "Redo") + keyHints.suffix("Mod+Shift+Z")} disabled={!future.length} onClick={redo}>
              <ArrowArcRight size={18} />
            </button>
            <button
              type="button"
              aria-label={t("Vorschau der Karte", "Preview of the card")}
              title={t("Vorschau der Karte", "Preview of the card")}
              aria-pressed={!!preview}
              className={preview ? "active" : ""}
              disabled={!targets.length}
              onClick={() => setPreview(preview ? null : { revealed: false })}
            >
              <Eye size={18} />
            </button>
          </div>
        </div>
        <div className="occlusion-workspace">
          <div className="annotator-stage occlusion-stage-wrap">
            {failed ? (
              <p role="alert" className="field-error">
                {t("Das Bild konnte nicht geladen werden.", "The image could not be loaded.")}
              </p>
            ) : preview && previewTarget ? (
              <div className="occlusion-preview">
                <OcclusionImage
                  occlusion={{ src, alt: altText, mode, masks, target: previewTarget.masks, index: previewIndex + 1, total: targets.length }}
                  reveal={preview.revealed}
                />
                <p className="muted">
                  {t(`Karte ${previewIndex + 1} von ${targets.length}`, `Card ${previewIndex + 1} of ${targets.length}`)}
                  {preview.revealed && previewTarget.labels.length > 0 ? ` · ${previewTarget.labels.join(" · ")}` : ""}
                </p>
                <button type="button" className="button compact" onClick={() => setPreview({ revealed: !preview.revealed })}>
                  {preview.revealed ? t("Vorderseite", "Front") : t("Aufdecken", "Reveal")}
                </button>
              </div>
            ) : (
              <div className="occlusion-frame occlusion-edit-frame">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  ref={image}
                  src={src}
                  alt={altText}
                  draggable={false}
                  onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth || 1000, h: e.currentTarget.naturalHeight || 1000 })}
                  onError={() => setFailed(true)}
                />
                {size && (
                  <svg
                    ref={svg}
                    className={`occlusion-layer occlusion-edit-layer tool-${polygon ? "polygon" : tool}`}
                    viewBox={`0 0 ${W} ${H}`}
                    preserveAspectRatio="none"
                    tabIndex={0}
                    role="application"
                    aria-label={t("Masken auf dem Bild", "Masks on the picture")}
                    aria-describedby="occlusion-keys"
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                    onPointerCancel={(e) => {
                      onPointerUp(e);
                      setDraft(null);
                    }}
                    onDoubleClick={() => polygon && finishPolygon(polygon.slice(0, -1).length >= 3 ? polygon.slice(0, -1) : polygon)}
                    onKeyDown={onKeyDown}
                  >
                    {masks.map((m) => (
                      <g key={m.id} data-mask={m.id} className={`occlusion-edit-mask${selected.includes(m.id) ? " selected" : ""}${m.group ? " grouped" : ""}`}>
                        <MaskShape mask={m} className="occlusion-mask" scale={{ x: W, y: H }} />
                        <text x={(m.x + m.w / 2) * W} y={(m.y + m.h / 2) * H} className="occlusion-number" fontSize={14 * px} textAnchor="middle" dominantBaseline="central">
                          {number.get(m.id)}
                        </text>
                      </g>
                    ))}
                    {draft && (
                      <MaskShape mask={{ id: "draft", shape: tool === "ellipse" ? "ellipse" : "rect", ...boxOf(draft.from, draft.to) }} className="occlusion-mask occlusion-draft" scale={{ x: W, y: H }} />
                    )}
                    {polygon && (
                      <>
                        <polyline
                          className="occlusion-draft"
                          vectorEffect="non-scaling-stroke"
                          points={[...polygon, ...(hover ? [hover] : [])].map(([x, y]) => `${x * W},${y * H}`).join(" ")}
                        />
                        {polygon.map(([x, y], i) => (
                          <circle key={i} className={`occlusion-vertex${i === 0 ? " first" : ""}`} cx={x * W} cy={y * H} r={(i === 0 ? 6 : 4) * px} vectorEffect="non-scaling-stroke" />
                        ))}
                      </>
                    )}
                    {single &&
                      !polygon &&
                      corners(single).map(([x, y], i) => (
                        <rect
                          key={i}
                          data-handle={i}
                          className={`occlusion-handle corner-${i}`}
                          x={x * W - handle / 2}
                          y={y * H - handle / 2}
                          width={handle}
                          height={handle}
                          vectorEffect="non-scaling-stroke"
                        />
                      ))}
                  </svg>
                )}
              </div>
            )}
          </div>
          <div className="occlusion-side">
            <fieldset className="occlusion-mode">
              <legend>{t("Abfrage", "Asking")}</legend>
              <label className="checkbox-label">
                <input type="radio" name="occlusion-mode" checked={mode === "hide-all"} onChange={() => change(masks, "hide-all")} />
                {t("Alle verdecken, eine abfragen", "Hide all, ask one")}
              </label>
              <label className="checkbox-label">
                <input type="radio" name="occlusion-mode" checked={mode === "hide-one"} onChange={() => change(masks, "hide-one")} />
                {t("Eine verdecken, Rest sichtbar", "Hide one, show the rest")}
              </label>
            </fieldset>
            <p className="muted occlusion-count">
              {masks.length === 0
                ? t("Noch keine Masken: Zieh ein Rechteck über das Bild.", "No masks yet: drag a rectangle over the picture.")
                : t(`${masks.length} Masken · ${targets.length} Karten`, `${masks.length} masks · ${targets.length} cards`)}
            </p>
            {masks.length > 0 && (
              <ol className="occlusion-list" aria-label={t("Masken", "Masks")}>
                {masks.map((m, i) => (
                  <li key={m.id} className={selected.includes(m.id) ? "selected" : ""}>
                    <button
                      type="button"
                      className="occlusion-pick"
                      aria-pressed={selected.includes(m.id)}
                      aria-label={t(`Karte ${number.get(m.id)}: ${shapeName(m)} auswählen`, `Card ${number.get(m.id)}: select ${shapeName(m)}`)}
                      title={t("Auswählen (mehrere zum Gruppieren)", "Select (several to group them)")}
                      // A toggle: several masks are chosen here on touch
                      // screens too (to group them).
                      onClick={() => setSelected((ids) => (ids.includes(m.id) ? ids.filter((i) => i !== m.id) : [...ids, m.id]))}
                    >
                      <span className="occlusion-badge">{number.get(m.id)}</span>
                      <span className="sr-only">{m.group ? t(" (Gruppe)", " (group)") : ""}</span>
                    </button>
                    <input
                      value={m.label || ""}
                      maxLength={200}
                      placeholder={m.group ? t("Beschriftung (Gruppe)", "Label (group)") : t("Beschriftung", "Label")}
                      // Masks by their place in the list (a group's share a card number).
                      aria-label={t(`Beschriftung von Maske ${i + 1}`, `Label of mask ${i + 1}`)}
                      // Its mask is chosen when the field is tapped or
                      // reached with Tab – not when focus only comes back to
                      // it after a tap elsewhere (phones keep the keyboard's
                      // field), which would undo picking several to group.
                      onPointerDown={() => setSelected((ids) => (ids.includes(m.id) ? ids : [m.id]))}
                      onFocus={() => {
                        if (Date.now() - pointerAt.current > 500) setSelected((ids) => (ids.includes(m.id) ? ids : [m.id]));
                        labelling.current = null;
                      }}
                      onChange={(e) => {
                        const label = e.target.value.slice(0, 200);
                        // Typing is one undo step per field, not per letter.
                        if (labelling.current !== m.id) remember();
                        labelling.current = m.id;
                        setMasks((list) => list.map((x) => (x.id === m.id ? { ...x, label: label || undefined } : x)));
                      }}
                    />
                    <button type="button" className="icon-button" aria-label={t(`Maske ${i + 1} löschen`, `Delete mask ${i + 1}`)} title={t("Löschen", "Delete")} onClick={() => remove([m.id])}>
                      <Trash size={16} />
                    </button>
                  </li>
                ))}
              </ol>
            )}
            <label className="occlusion-alt">
              {t("Alternativtext des Bildes", "Alternative text of the picture")}
              <input value={altText} maxLength={500} onChange={(e) => setAltText(e.target.value)} placeholder={t("z. B. Querschnitt des Herzens", "e.g. cross-section of the heart")} />
            </label>
            {!altText.trim() && (
              <p className="muted occlusion-hint">
                <Info aria-hidden size={14} />{" "}
                {t("Ohne Alternativtext hören Screenreader nur „Bereich 3 von 7 verdeckt“.", "Without alternative text, screen readers only hear “Area 3 of 7 covered”.")}
              </p>
            )}
            <p className="muted occlusion-keys" id="occlusion-keys">
              {t(
                "Pfeiltasten verschieben die Auswahl (mit Umschalt weiter, mit Alt die Größe), Entf löscht, G gruppiert. Labels stehen auf der Rückseite.",
                "Arrow keys move the selection (with Shift further, with Alt its size), Delete removes, G groups. Labels show on the back.",
              )}
            </p>
          </div>
        </div>
        <p className="sr-only" role="status" aria-live="polite">
          {status}
        </p>
        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose}>
            {t("Abbrechen", "Cancel")}
          </button>
          {polygon && (
            <button type="button" className="button" onClick={() => finishPolygon()} disabled={polygon.length < 3}>
              {t("Polygon fertig", "Finish polygon")}
            </button>
          )}
          <button type="button" className="button primary" disabled={failed} onClick={save}>
            {t("Speichern", "Save")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
