"use client";
// Pictures and stickers among the ink (lib/ink/image.ts): how one is drawn
// in the ink layer, and the frame around the picked one – move it, resize
// it at the corners (proportions kept, Shift: free) or edges, turn it at
// the handle above, crop it, bring it to the front or send it behind the
// ink, change its opacity, duplicate, delete or save it as a sticker. All
// with pen, finger or mouse; one undo step per gesture. Keyboard: arrows
// move (Shift: further), Delete, ⌘D, Escape (useInkShortcuts).
import { memo, useEffect, useRef, useState } from "react";
import { ArrowsClockwise, Check, CopySimple, Crop, DropHalf, SelectionBackground, SelectionForeground, Sticker, Trash } from "@phosphor-icons/react";
import { useT } from "../i18n";
import { clientToPage, type PageSize } from "@/lib/ink/coords";
import {
  cropImage,
  fullFrame,
  IMAGE_HANDLES,
  imageBounds,
  imageCentre,
  fullBox,
  replaceItem,
  resizeImage,
  rotateImage,
  toBack,
  toFront,
  uncropImage,
  type ImageHandle,
} from "@/lib/ink/image";
import { copyItems } from "@/lib/ink/geometry";
import type { InkImage, InkItem } from "@/lib/ink/model";
import { builtinSticker, stickerSvgElements } from "@/lib/ink/stickers";
import { palmLikely } from "@/lib/stylus";

export const fileSrc = (file: string) => `/api/files/${file}`;

// One picture or sticker in the ink SVG (page units).
export const InkImageItem = memo(function InkImageItem({ item, src = fileSrc }: { item: InkImage; src?: (file: string) => string }) {
  const c = imageCentre(item);
  const transform = item.rotation ? `rotate(${item.rotation} ${c.x} ${c.y})` : undefined;
  const opacity = item.opacity !== undefined && item.opacity < 1 ? item.opacity : undefined;
  if (item.sticker) {
    const sticker = builtinSticker(item.sticker);
    if (!sticker) return null;
    return (
      <g transform={transform} opacity={opacity} data-image={item.id}>
        <svg
          x={item.x}
          y={item.y}
          width={item.w}
          height={item.h}
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          overflow="visible"
          dangerouslySetInnerHTML={{ __html: stickerSvgElements(sticker, item.color) }}
        />
      </g>
    );
  }
  if (!item.file) return null;
  const full = fullBox(item);
  return (
    <g transform={transform} opacity={opacity} data-image={item.id}>
      <svg x={item.x} y={item.y} width={item.w} height={item.h} viewBox={`${item.x - full.x} ${item.y - full.y} ${item.w} ${item.h}`} preserveAspectRatio="none">
        <image href={src(item.file)} x={0} y={0} width={full.w} height={full.h} preserveAspectRatio="none" />
      </svg>
    </g>
  );
});

type Drag =
  | { kind: "move"; pointer: number; start: { x: number; y: number }; base: InkImage }
  | { kind: "resize" | "crop"; pointer: number; handle: ImageHandle; base: InkImage }
  | { kind: "rotate"; pointer: number; base: InkImage };

export type ImageAction = "sticker";

// The frame around the picked picture. `items` are the page's items as
// shown; `onPreview` shows changed items while a gesture runs, `onCommit`
// stores them (one undo step).
export function ImageFrame({
  item,
  items,
  size,
  scale,
  root,
  onPreview,
  onCommit,
  onClose,
  onPick,
  onAction,
  src = fileSrc,
}: {
  item: InkImage;
  items: InkItem[];
  size: PageSize;
  scale: number;
  root: React.RefObject<HTMLDivElement | null>;
  onPreview: (items: InkItem[] | null) => void;
  onCommit: (items: InkItem[]) => void;
  onClose: () => void;
  // Puts another picture in the frame (a duplicate).
  onPick?: (id: string) => void;
  onAction?: (action: ImageAction, item: InkImage) => void;
  src?: (file: string) => string;
}) {
  const t = useT();
  const [cropping, setCropping] = useState(false);
  const [alpha, setAlpha] = useState<number | null>(null);
  const drag = useRef<Drag | null>(null);
  const [dragging, setDragging] = useState(false);
  const latest = useRef<InkImage>(item);
  latest.current = item;
  // A picture that is not cropped any more leaves crop mode as it is.
  useEffect(() => setCropping(false), [item.id]);

  const toPage = (e: { clientX: number; clientY: number }) => clientToPage(e.clientX, e.clientY, root.current!.getBoundingClientRect(), size);
  const show = (next: InkImage) => onPreview(replaceItem(items, next));
  // Stored only when it differs from what is saved (`item` may be the preview).
  const commit = (next: InkImage) => {
    onPreview(null);
    const saved = items.find((i) => i.id === next.id);
    if (JSON.stringify(next) !== JSON.stringify(saved)) onCommit(replaceItem(items, next));
  };
  function begin(e: React.PointerEvent, next: Drag) {
    // A palm on the screen neither moves nor resizes.
    if (e.pointerType === "touch" && palmLikely(e)) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    drag.current = next;
    setDragging(true);
  }
  function move(e: React.PointerEvent) {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    e.preventDefault();
    const p = toPage(e);
    if (d.kind === "move") show({ ...d.base, x: Math.round((d.base.x + p.x - d.start.x) * 100) / 100, y: Math.round((d.base.y + p.y - d.start.y) * 100) / 100 });
    else if (d.kind === "resize") show(resizeImage(d.base, d.handle, p, { free: e.shiftKey }));
    else if (d.kind === "crop") show(cropImage(d.base, d.handle, p));
    else show(rotateImage(d.base, p, { steps: e.shiftKey }));
  }
  function end(e: React.PointerEvent, cancelled = false) {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    drag.current = null;
    setDragging(false);
    if (cancelled) return onPreview(null);
    // The preview holds the last state (latest follows the shown items).
    commit(latest.current);
  }
  const handlers = { onPointerMove: move, onPointerUp: (e: React.PointerEvent) => end(e), onPointerCancel: (e: React.PointerEvent) => end(e, true) };

  const percent = (v: number, of: number) => `${(v / (of || 1)) * 100}%`;
  const bounds = imageBounds(item);
  const frame = fullFrame(item);
  const style: React.CSSProperties = {
    left: percent(item.x, size.width),
    top: percent(item.y, size.height),
    width: percent(item.w, size.width),
    height: percent(item.h, size.height),
    transform: item.rotation ? `rotate(${item.rotation}deg)` : undefined,
  };
  // The whole picture while cropping, relative to the frame.
  const whole: React.CSSProperties = {
    left: percent(frame.left + item.w / 2, item.w),
    top: percent(frame.top + item.h / 2, item.h),
    width: percent(frame.W, item.w),
    height: percent(frame.H, item.h),
  };
  const bar: React.CSSProperties = {
    left: percent(bounds.x, size.width),
    // Below the picture (the turning handle is above it), above when the sheet ends.
    top: (size.height - bounds.y - bounds.h) * scale > 70 ? `calc(${percent(bounds.y + bounds.h, size.height)} + 14px)` : `calc(${percent(bounds.y, size.height)} - 96px)`,
  };
  const label = item.sticker ? t("Sticker", "Sticker") : t("Bild", "Picture");
  // The opacity slider shows while it moves and is stored when let go.
  const commitAlpha = () => {
    if (alpha === null) return;
    const next: InkImage = { ...latest.current };
    if (alpha >= 1) delete next.opacity;
    else next.opacity = alpha;
    setAlpha(null);
    commit(next);
  };
  const change = (next: InkItem[]) => {
    onPreview(null);
    onCommit(next);
  };
  return (
    <>
      <div
        className={`ink-ui ink-image-frame${cropping ? " is-cropping" : ""}${dragging ? " is-dragging" : ""}`}
        style={style}
        role="group"
        aria-label={label}
        onPointerDown={(e) => !cropping && begin(e, { kind: "move", pointer: e.pointerId, start: toPage(e), base: item })}
        {...handlers}
      >
        {cropping && (
          <div className="ink-image-whole" style={whole} aria-hidden="true">
            {item.file && <img src={src(item.file)} alt="" draggable={false} />}
          </div>
        )}
        {IMAGE_HANDLES.map((handle) => (
          <span
            key={handle}
            className={`ink-image-handle is-${handle}`}
            role="presentation"
            onPointerDown={(e) => begin(e, { kind: cropping ? "crop" : "resize", pointer: e.pointerId, handle, base: item })}
          />
        ))}
        {!cropping && (
          <span
            className="ink-image-rotate"
            role="presentation"
            title={t("Drehen (Umschalt: in 15°-Schritten)", "Rotate (Shift: in 15° steps)")}
            onPointerDown={(e) => begin(e, { kind: "rotate", pointer: e.pointerId, base: item })}
          >
            <ArrowsClockwise size={13} weight="bold" />
          </span>
        )}
      </div>
      {!dragging && (
        <div className="ink-ui ink-selection-bar ink-image-bar" role="toolbar" aria-label={label} style={bar} onPointerDown={(e) => e.stopPropagation()}>
          {cropping ? (
            <>
              <button type="button" className="ink-image-text" onClick={() => change(replaceItem(items, uncropImage(item)))} disabled={!item.crop}>
                {t("Zurücksetzen", "Reset")}
              </button>
              <button type="button" className="ink-image-text" onClick={() => setCropping(false)}>
                <Check size={16} /> {t("Fertig", "Done")}
              </button>
            </>
          ) : (
            <>
              {item.file && (
                <button type="button" aria-label={t("Zuschneiden", "Crop")} title={t("Zuschneiden", "Crop")} onClick={() => setCropping(true)}>
                  <Crop size={17} />
                </button>
              )}
              <button type="button" aria-label={t("Nach vorne (über die Tinte)", "Bring to front (over the ink)")} title={t("Nach vorne (über die Tinte)", "Bring to front (over the ink)")} onClick={() => change(toFront(items, item.id))}>
                <SelectionForeground size={17} />
              </button>
              <button type="button" aria-label={t("Nach hinten (unter die Tinte)", "Send to back (under the ink)")} title={t("Nach hinten (unter die Tinte)", "Send to back (under the ink)")} onClick={() => change(toBack(items, item.id))}>
                <SelectionBackground size={17} />
              </button>
              <label className="ink-image-alpha" title={t("Deckkraft", "Opacity")}>
                <DropHalf size={17} aria-hidden="true" />
                <input
                  type="range"
                  min={10}
                  max={100}
                  step={5}
                  aria-label={t("Deckkraft", "Opacity")}
                  value={Math.round((alpha ?? item.opacity ?? 1) * 100)}
                  onChange={(e) => {
                    const value = Number(e.target.value) / 100;
                    setAlpha(value);
                    show({ ...item, opacity: value });
                  }}
                  onPointerUp={commitAlpha}
                  onKeyUp={commitAlpha}
                  onBlur={commitAlpha}
                />
              </label>
              <button
                type="button"
                aria-label={t("Duplizieren", "Duplicate")}
                title={t("Duplizieren", "Duplicate")}
                onClick={() => {
                  const [copy] = copyItems([item], 16, 16);
                  change([...items, copy]);
                  onPick?.(copy.id);
                }}
              >
                <CopySimple size={17} />
              </button>
              {item.file && onAction && (
                <button type="button" aria-label={t("Als Sticker speichern", "Save as sticker")} title={t("Als Sticker speichern", "Save as sticker")} onClick={() => onAction("sticker", item)}>
                  <Sticker size={17} />
                </button>
              )}
              <button
                type="button"
                aria-label={t("Löschen", "Delete")}
                title={t("Löschen", "Delete")}
                onClick={() => {
                  onClose();
                  change(items.filter((i) => i.id !== item.id));
                }}
              >
                <Trash size={17} />
              </button>
            </>
          )}
        </div>
      )}
    </>
  );
}
