// Pictures and stickers among the ink (lib/ink/model.ts InkImage): where
// they are, hit tests, moving the handles of the frame (resize, rotate,
// crop), the order front to back and where a new one goes. Page units like
// all ink; free of React and the DOM.
import type { Box } from "./geometry";
import type { InkImage, InkItem } from "./model";

type XY = { x: number; y: number };
const round2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 10000) / 10000;
const RAD = Math.PI / 180;
// The smallest side a picture keeps while resizing or cropping.
export const MIN_IMAGE_SIDE = 8;

export const isImage = (item: InkItem): item is InkImage => item.type === "image";
export const imageCentre = (item: Pick<InkImage, "x" | "y" | "w" | "h">): XY => ({ x: item.x + item.w / 2, y: item.y + item.h / 2 });
const turn = (p: XY, degrees: number): XY => {
  if (!degrees) return p;
  const a = degrees * RAD,
    c = Math.cos(a),
    s = Math.sin(a);
  return { x: p.x * c - p.y * s, y: p.x * s + p.y * c };
};
// A point of the page in the picture's own frame: centre at 0, upright.
export function toLocal(item: InkImage, p: XY): XY {
  const c = imageCentre(item);
  return turn({ x: p.x - c.x, y: p.y - c.y }, -(item.rotation || 0));
}
export function fromLocal(item: Pick<InkImage, "x" | "y" | "w" | "h" | "rotation">, p: XY): XY {
  const c = imageCentre(item);
  const q = turn(p, item.rotation || 0);
  return { x: c.x + q.x, y: c.y + q.y };
}
// The corners on the page (top left, top right, bottom right, bottom left).
export function imageCorners(item: InkImage): XY[] {
  const hw = item.w / 2,
    hh = item.h / 2;
  return [
    { x: -hw, y: -hh },
    { x: hw, y: -hh },
    { x: hw, y: hh },
    { x: -hw, y: hh },
  ].map((p) => fromLocal(item, p));
}
export function imageBounds(item: InkImage): Box {
  if (!item.rotation) return { x: item.x, y: item.y, w: item.w, h: item.h };
  const pts = imageCorners(item);
  const xs = pts.map((p) => p.x),
    ys = pts.map((p) => p.y);
  const x = Math.min(...xs),
    y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}
export function hitImage(item: InkImage, p: XY, tolerance = 0) {
  const q = toLocal(item, p);
  return Math.abs(q.x) <= item.w / 2 + tolerance && Math.abs(q.y) <= item.h / 2 + tolerance;
}
// The topmost picture under a point.
export function imageAt(items: InkItem[], p: XY, tolerance = 0): InkImage | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (isImage(item) && hitImage(item, p, tolerance)) return item;
  }
  return null;
}

// ---- The frame's handles ----

// Corners keep the proportions (Shift: free), edges stretch one side.
export type ImageHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
export const IMAGE_HANDLES: ImageHandle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const SIGNS: Record<ImageHandle, [number, number]> = { nw: [-1, -1], n: [0, -1], ne: [1, -1], e: [1, 0], se: [1, 1], s: [0, 1], sw: [-1, 1], w: [-1, 0] };
export const handleSigns = (handle: ImageHandle) => SIGNS[handle];
// Where a handle sits, in the picture's own frame.
export const handleLocal = (item: Pick<InkImage, "w" | "h">, handle: ImageHandle): XY => ({ x: (SIGNS[handle][0] * item.w) / 2, y: (SIGNS[handle][1] * item.h) / 2 });

function withLocalBox(base: InkImage, left: number, top: number, right: number, bottom: number): InkImage {
  const w = right - left,
    h = bottom - top;
  const centre = fromLocal(base, { x: (left + right) / 2, y: (top + bottom) / 2 });
  return { ...base, x: round2(centre.x - w / 2), y: round2(centre.y - h / 2), w: round2(w), h: round2(h) };
}

// The picture with `handle` dragged to `p` (page units); the opposite
// corner or edge stays where it is, also when the picture is turned.
export function resizeImage(base: InkImage, handle: ImageHandle, p: XY, { free = false }: { free?: boolean } = {}): InkImage {
  const [sx, sy] = SIGNS[handle];
  const q = toLocal(base, p);
  const hw = base.w / 2,
    hh = base.h / 2;
  // The fixed side, in the frame.
  const ax = -sx * hw,
    ay = -sy * hh;
  let w = sx ? Math.max(MIN_IMAGE_SIDE, (q.x - ax) * sx) : base.w;
  let h = sy ? Math.max(MIN_IMAGE_SIDE, (q.y - ay) * sy) : base.h;
  if (sx && sy && !free) {
    const scale = Math.max(w / base.w, h / base.h, MIN_IMAGE_SIDE / Math.min(base.w, base.h));
    w = base.w * scale;
    h = base.h * scale;
  }
  const cx = sx ? ax + (sx * w) / 2 : 0,
    cy = sy ? ay + (sy * h) / 2 : 0;
  return withLocalBox(base, cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2);
}

// The picture turned so its top points to `p` (the handle above it).
// Lands on 0°, 90°, 180°, 270° when close; Shift: 15° steps.
export function rotateImage(base: InkImage, p: XY, { steps = false }: { steps?: boolean } = {}): InkImage {
  const c = imageCentre(base);
  let degrees = Math.atan2(p.y - c.y, p.x - c.x) / RAD + 90;
  if (steps) degrees = Math.round(degrees / 15) * 15;
  else {
    const right = Math.round(degrees / 90) * 90;
    if (Math.abs(degrees - right) < 4) degrees = right;
  }
  const normal = round2((((degrees % 360) + 540) % 360) - 180);
  const next = { ...base };
  if (normal) next.rotation = normal;
  else delete next.rotation;
  return next;
}

// ---- Cropping ----

const fullCrop = { x: 0, y: 0, w: 1, h: 1 };
// The whole picture (before cropping) in the frame of the shown part.
export function fullFrame(item: InkImage) {
  const crop = item.crop || fullCrop;
  const W = item.w / crop.w,
    H = item.h / crop.h;
  const left = -item.w / 2 - crop.x * W,
    top = -item.h / 2 - crop.y * H;
  return { left, top, right: left + W, bottom: top + H, W, H };
}
// The whole picture's box on the page (unturned, around the same centre
// of rotation) – drawn faintly while cropping and used by the renderers.
export function fullBox(item: InkImage): Box {
  const f = fullFrame(item);
  const c = imageCentre(item);
  return { x: c.x + f.left, y: c.y + f.top, w: f.W, h: f.H };
}
// The shown part with `handle` dragged to `p`: its edges move inside the
// whole picture, which stays where it is.
export function cropImage(base: InkImage, handle: ImageHandle, p: XY): InkImage {
  const [sx, sy] = SIGNS[handle];
  const f = fullFrame(base);
  const q = toLocal(base, p);
  let left = -base.w / 2,
    right = base.w / 2,
    top = -base.h / 2,
    bottom = base.h / 2;
  const min = Math.min(MIN_IMAGE_SIDE, f.W, f.H);
  if (sx < 0) left = Math.max(f.left, Math.min(q.x, right - min));
  if (sx > 0) right = Math.min(f.right, Math.max(q.x, left + min));
  if (sy < 0) top = Math.max(f.top, Math.min(q.y, bottom - min));
  if (sy > 0) bottom = Math.min(f.bottom, Math.max(q.y, top + min));
  const crop = { x: r4((left - f.left) / f.W), y: r4((top - f.top) / f.H), w: r4((right - left) / f.W), h: r4((bottom - top) / f.H) };
  const next = withLocalBox(base, left, top, right, bottom);
  if (crop.x <= 0 && crop.y <= 0 && crop.w >= 1 && crop.h >= 1) delete next.crop;
  else next.crop = crop;
  return next;
}
// Back to the whole picture, the shown part's scale kept.
export function uncropImage(base: InkImage): InkImage {
  if (!base.crop) return base;
  const f = fullFrame(base);
  const next = withLocalBox(base, f.left, f.top, f.right, f.bottom);
  delete next.crop;
  return next;
}

// ---- Order, copies, placement ----

// Front: drawn over everything (also over ink drawn before); back: under
// all ink and the highlighter.
export function toFront(items: InkItem[], id: string) {
  const item = items.find((i) => i.id === id);
  return item ? [...items.filter((i) => i.id !== id), item] : items;
}
export function toBack(items: InkItem[], id: string) {
  const item = items.find((i) => i.id === id);
  return item ? [item, ...items.filter((i) => i.id !== id)] : items;
}
export function replaceItem(items: InkItem[], next: InkItem) {
  return items.map((i) => (i.id === next.id ? next : i));
}

// A new picture of `natural` proportions: at most 60 % of the sheet's width
// and half its height (stickers smaller), centred on `at` (default: the
// middle of the sheet), inside the sheet.
export function placeImage(natural: { width: number; height: number }, sheet: { width: number; height: number }, { at, max = 0.6 }: { at?: XY | null; max?: number } = {}) {
  const ratio = natural.width > 0 && natural.height > 0 ? natural.width / natural.height : 1;
  let w = Math.min(sheet.width * max, natural.width || sheet.width * max);
  let h = w / ratio;
  const maxH = sheet.height * Math.min(0.5, max);
  if (h > maxH) {
    h = maxH;
    w = h * ratio;
  }
  w = Math.max(MIN_IMAGE_SIDE, w);
  h = Math.max(MIN_IMAGE_SIDE, h);
  const c = at || { x: sheet.width / 2, y: sheet.height / 2 };
  const x = Math.max(0, Math.min(sheet.width - w, c.x - w / 2)),
    y = Math.max(0, Math.min(sheet.height - h, c.y - h / 2));
  return { x: round2(x), y: round2(y), w: round2(w), h: round2(h) };
}
