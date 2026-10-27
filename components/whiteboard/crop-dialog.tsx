"use client";
// Cropping a picture on the board – without changing the file: the board
// keeps the part shown ("crop", fractions of the whole picture) and can
// always go back to the whole picture. Drag the frame to move it, its
// corners to resize; arrow keys move it, with Shift they resize it.
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useT } from "../i18n";
import { Modal } from "../ui";

export type Crop = { x: number; y: number; w: number; h: number };
const MIN = 0.05;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
export function clampCrop(c: Crop): Crop {
  const w = clamp(c.w, MIN, 1),
    h = clamp(c.h, MIN, 1);
  return { x: clamp(c.x, 0, 1 - w), y: clamp(c.y, 0, 1 - h), w, h };
}

export function CropDialog({
  open,
  src,
  crop,
  onClose,
  onApply,
}: {
  open: boolean;
  src: string;
  crop: Crop | null;
  onClose: () => void;
  onApply: (crop: Crop | null) => void;
}) {
  const t = useT();
  const [box, setBox] = useState<Crop>(crop || { x: 0.1, y: 0.1, w: 0.8, h: 0.8 });
  const stage = useRef<HTMLDivElement>(null);
  const drag = useRef<{ handle: string; start: { x: number; y: number }; origin: Crop } | null>(null);
  useEffect(() => {
    if (open) setBox(crop || { x: 0.1, y: 0.1, w: 0.8, h: 0.8 });
  }, [open, crop]);
  const point = (e: ReactPointerEvent) => {
    const rect = stage.current!.getBoundingClientRect();
    return { x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height };
  };
  const down = (e: ReactPointerEvent, handle: string) => {
    e.preventDefault();
    e.stopPropagation();
    stage.current?.setPointerCapture(e.pointerId);
    drag.current = { handle, start: point(e), origin: box };
  };
  const move = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const p = point(e);
    const dx = p.x - d.start.x,
      dy = p.y - d.start.y;
    const o = d.origin;
    if (d.handle === "move") return setBox(clampCrop({ ...o, x: o.x + dx, y: o.y + dy }));
    let { x, y, w, h } = o;
    if (d.handle.includes("e")) w = clamp(o.w + dx, MIN, 1 - o.x);
    if (d.handle.includes("s")) h = clamp(o.h + dy, MIN, 1 - o.y);
    if (d.handle.includes("w")) {
      x = clamp(o.x + dx, 0, o.x + o.w - MIN);
      w = o.x + o.w - x;
    }
    if (d.handle.includes("n")) {
      y = clamp(o.y + dy, 0, o.y + o.h - MIN);
      h = o.y + o.h - y;
    }
    setBox({ x, y, w, h });
  };
  const pct = (v: number) => `${v * 100}%`;
  return (
    <Modal open={open} onClose={onClose} title={t("Bild zuschneiden", "Crop image")} wide className="wb-crop-dialog">
      <div
        className="wb-crop-stage"
        ref={stage}
        onPointerMove={move}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt="" draggable={false} />
        <div className="wb-crop-shade" style={{ clipPath: `polygon(0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${pct(box.x)} ${pct(box.y)}, ${pct(box.x)} ${pct(box.y + box.h)}, ${pct(box.x + box.w)} ${pct(box.y + box.h)}, ${pct(box.x + box.w)} ${pct(box.y)}, ${pct(box.x)} ${pct(box.y)})` }} />
        <div
          className="wb-crop-box"
          role="slider"
          tabIndex={0}
          aria-label={t("Ausschnitt – Pfeiltasten verschieben, mit Umschalt ändern sie die Größe", "Crop area – arrow keys move it, with Shift they resize it")}
          aria-valuetext={`${Math.round(box.w * 100)} × ${Math.round(box.h * 100)} %`}
          style={{ left: pct(box.x), top: pct(box.y), width: pct(box.w), height: pct(box.h) }}
          onPointerDown={(e) => down(e, "move")}
          onKeyDown={(e) => {
            const step = 0.01;
            const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
            if (!d) return;
            e.preventDefault();
            setBox((b) => clampCrop(e.shiftKey ? { ...b, w: b.w + d[0], h: b.h + d[1] } : { ...b, x: b.x + d[0], y: b.y + d[1] }));
          }}
        >
          {["nw", "ne", "sw", "se"].map((h) => (
            <span key={h} className={`wb-crop-handle ${h}`} onPointerDown={(e) => down(e, h)} aria-hidden="true" />
          ))}
        </div>
      </div>
      <div className="wb-crop-actions">
        {crop && (
          <button type="button" className="button" onClick={() => onApply(null)}>
            {t("Ganzes Bild zeigen", "Show the whole image")}
          </button>
        )}
        <span className="spacer" />
        <button type="button" className="button" onClick={onClose}>
          {t("Abbrechen", "Cancel")}
        </button>
        <button type="button" className="button primary" onClick={() => onApply(clampCrop(box))}>
          {t("Zuschneiden", "Crop")}
        </button>
      </div>
    </Modal>
  );
}
