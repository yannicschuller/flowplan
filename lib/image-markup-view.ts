// The view of the image being marked up (components/image-annotator.tsx):
// the image fits its frame at `fit` screen pixels per image pixel and is
// zoomed and panned inside it (lib/pinch-zoom.ts "frame" functions). The
// markings are kept in the image's own pixels – the view only changes where
// they are drawn, never what is saved.
import { clampPan, clampZoom, frameZoom, stepZoom, toContent, toFrame, type FrameView, type Size, type XY } from "./pinch-zoom";

// From the whole image (1, fit) to 8 times that.
export const MARKUP_ZOOM = { min: 1, max: 8 };
export const MARKUP_STEP = 0.5;

// A point on the canvas (CSS pixels from its top left) in image pixels.
export function screenToImage(view: FrameView, fit: number, p: XY): XY {
  const c = toContent(view, p);
  return { x: c.x / (fit || 1), y: c.y / (fit || 1) };
}
// A point of the image on the canvas.
export const imageToScreen = (view: FrameView, fit: number, p: XY): XY => toFrame(view, { x: p.x * fit, y: p.y * fit });

// Screen pixels per image pixel in this view.
export const pixelScale = (view: FrameView, fit: number) => view.scale * fit;

// A zoom key or button: the next step, around the middle of the frame
// (or `at`).
export function stepView(view: FrameView, direction: 1 | -1, size: Size, at: XY = { x: size.width / 2, y: size.height / 2 }): FrameView {
  const next = stepZoom(view.scale, direction, MARKUP_STEP, MARKUP_ZOOM);
  return frameZoom(view, at, next / view.scale, MARKUP_ZOOM, size);
}

// A plain wheel or two-finger trackpad scroll moves a zoomed image.
export function wheelPan(view: FrameView, deltaX: number, deltaY: number, deltaMode: number, size: Size): FrameView {
  const unit = deltaMode === 1 ? 16 : deltaMode === 2 ? size.height : 1;
  return { scale: view.scale, pan: clampPan({ x: view.pan.x - deltaX * unit, y: view.pan.y - deltaY * unit }, view.scale, size) };
}

// The view within the limits (and covering the frame).
export const clampView = (view: FrameView, size: Size): FrameView => {
  const scale = clampZoom(view.scale, MARKUP_ZOOM);
  return { scale, pan: clampPan(view.pan, scale, size) };
};
