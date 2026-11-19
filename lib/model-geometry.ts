// The arithmetic of the 3D viewer (#384, components/viewer3d): distances
// for the measuring tool, the size of the bounding box, the standard views
// and how far the camera stands to show the whole model. Pure, for the
// tests; the scene (components/viewer3d/scene.ts) applies it to three.js.

export type Vec3 = [number, number, number];
export type Up = "y" | "z";
export type StandardView = "front" | "top" | "right" | "iso";

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const length = (v: Vec3) => Math.hypot(v[0], v[1], v[2]);
const normalize = (v: Vec3): Vec3 => {
  const l = length(v) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

// The distance of two points in the model's units. `scale`: model units per
// scene unit, when the scene shows the model scaled (1: it does not).
export function measureDistance(a: Vec3, b: Vec3, scale = 1) {
  return length(sub(a, b)) * scale;
}

// The edges of the bounding box (width, depth, height in the model's axes).
export function boxSize(min: Vec3, max: Vec3): Vec3 {
  return [Math.max(0, max[0] - min[0]), Math.max(0, max[1] - min[1]), Math.max(0, max[2] - min[2])];
}
export const boxCenter = (min: Vec3, max: Vec3): Vec3 => [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
export const boxRadius = (min: Vec3, max: Vec3) => length(sub(max, min)) / 2;

// Significant digits that suit the size: 0.012 mm, 1.25 mm, 12.5 mm, 125 mm.
export function roundLength(value: number) {
  if (!Number.isFinite(value) || value === 0) return 0;
  const magnitude = Math.floor(Math.log10(Math.abs(value)));
  const decimals = Math.max(0, Math.min(6, 2 - magnitude));
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
// A length with its unit, in the reader's notation ("12,5 mm", "12.5 mm").
export function formatLength(value: number, unit: string, locale = "en") {
  const rounded = roundLength(value);
  const text = rounded.toLocaleString(locale, { maximumFractionDigits: 6 });
  return unit ? `${text} ${unit}` : text;
}
// "30 × 20 × 10 mm"
export function formatBox(size: Vec3, unit: string, locale = "en") {
  const text = size.map((v) => roundLength(v).toLocaleString(locale, { maximumFractionDigits: 6 })).join(" × ");
  return unit ? `${text} ${unit}` : text;
}

// Where the camera looks from (a unit vector from the model's centre to
// the camera) and which way is up on the screen, for a standard view.
// Z-up (CAD, STL, 3MF, STEP): the front looks along +Y (camera at −Y),
// the top down −Z, the right side along −X. Y-up (glTF, OBJ): the front
// looks along −Z (camera at +Z), the top down −Y.
export function viewDirection(view: StandardView, up: Up): { from: Vec3; up: Vec3 } {
  if (up === "z") {
    if (view === "front") return { from: [0, -1, 0], up: [0, 0, 1] };
    if (view === "top") return { from: [0, 0, 1], up: [0, 1, 0] };
    if (view === "right") return { from: [1, 0, 0], up: [0, 0, 1] };
    return { from: normalize([1, -1, 1]), up: [0, 0, 1] };
  }
  if (view === "front") return { from: [0, 0, 1], up: [0, 1, 0] };
  if (view === "top") return { from: [0, 1, 0], up: [0, 0, -1] };
  if (view === "right") return { from: [1, 0, 0], up: [0, 1, 0] };
  return { from: normalize([1, 1, 1]), up: [0, 1, 0] };
}

// How far from the centre a perspective camera stands so that a sphere of
// `radius` fits the view (vertical field of view `fovDeg`, width/height
// `aspect`) with a margin around it.
export function fitDistance(radius: number, fovDeg: number, aspect: number, margin = 1.15) {
  const r = radius > 0 && Number.isFinite(radius) ? radius : 1;
  const vertical = (fovDeg * Math.PI) / 360;
  const horizontal = Math.atan(Math.tan(vertical) * (aspect > 0 ? aspect : 1));
  return (r * margin) / Math.sin(Math.min(vertical, horizontal));
}

// Zoom buttons move the camera towards or away from the point it looks at;
// the distance stays between a hundredth and twenty times the fitted one.
export function zoomDistance(distance: number, direction: 1 | -1, fitted: number, step = 1.25) {
  const next = direction > 0 ? distance / step : distance * step;
  return Math.min(fitted * 20, Math.max(fitted / 100, next));
}

// The scale of a sprite that does not shrink with distance (three.js,
// sizeAttenuation off) for a height of `pixels` in a view `viewHeight`
// pixels tall.
export function screenScale(pixels: number, viewHeight: number, fovDeg: number) {
  return (pixels / Math.max(1, viewHeight)) * 2 * Math.tan((fovDeg * Math.PI) / 360);
}
