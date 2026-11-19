// Turns a drawing (lib/drawing-model.ts) into what the drawing viewer's
// canvas draws (#384, components/viewer2d): every entity as polylines or
// filled rings in drawing coordinates – blocks inserted with their
// transforms, colours and linetypes resolved (BYLAYER, BYBLOCK) – grouped
// by layer, colour and linetype, plus the texts, the points the measuring
// tool snaps to and the bounding box. Runs in the parsing worker; the
// arrays are transferred to the page. Also the layer list's state.
import {
  IDENTITY,
  apply,
  arcPoints,
  circlePoints,
  ellipsePoints,
  insertTransform,
  matAngle,
  matScale,
  multiply,
  polylinePoints,
  splinePoints,
  type Mat,
  type Pt,
} from "./drawing-geometry";
import { BYBLOCK, BYLAYER, INK, resolveColor, type ColorRef, type Drawing, type DrawingEntity, type TextAnchor } from "./drawing-model";

export type BatchKind = "stroke" | "fill" | "tint";
export type Batch = {
  layer: number;
  // RGB, or INK (black or white by the paper).
  color: number;
  kind: BatchKind;
  // Dash pattern in drawing units (empty: continuous).
  dash: number[];
  // x, y pairs relative to the scene's origin.
  points: Float32Array;
  // Where each polyline (or ring) starts, as a point index; a fill batch
  // groups rings into shapes with `shapes` (index into starts).
  starts: Uint32Array;
  shapes?: Uint32Array;
  bounds: [number, number, number, number];
};
export type SceneText = { layer: number; color: number; x: number; y: number; height: number; rotation: number; lines: string[]; anchor: TextAnchor; lineSpacing: number };
export type SceneLayer = { name: string; color: number; visible: boolean };
export type DrawingScene = {
  // Added to every coordinate to get the drawing's own (kept apart so the
  // 32-bit arrays stay precise far from the drawing's origin).
  origin: [number, number];
  units: number;
  layers: SceneLayer[];
  batches: Batch[];
  texts: SceneText[];
  // Ends, vertices and centres (x, y pairs relative to the origin).
  snaps: Float64Array;
  // [minX, minY, maxX, maxY] relative to the origin, or null when empty.
  bounds: [number, number, number, number] | null;
  entities: number;
  segments: number;
  // More than the viewer draws at once (the rest left out).
  truncated: boolean;
  skipped: Record<string, number>;
};

// A large drawing is shown up to this many points (about 64 MB of floats).
export const MAX_POINTS = 8_000_000;
const MAX_DEPTH = 16;
const MAX_ARRAY = 10_000;
const BATCH_POINTS = 16_384;

type Builder = { layer: number; color: number; kind: BatchKind; dash: number[]; points: number[]; starts: number[]; shapes: number[] };
type Context = { m: Mat; layer: number | null; color: number; lineType: string | null; ltScale: number; depth: number };

// Natural order ("Layer 2" before "Layer 10"), layer "0" first.
const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

export function buildScene(drawing: Drawing, maxPoints = MAX_POINTS): DrawingScene {
  // The layer list: every named layer, plus those only entities name.
  const layerInfo = new Map<string, { color: ColorRef; visible: boolean; lineType?: string }>();
  for (const layer of drawing.layers)
    if (!layerInfo.has(layer.name)) layerInfo.set(layer.name, { color: layer.color, visible: layer.on && !layer.frozen && layer.color.aci >= 0, lineType: layer.lineType });
  const noteLayer = (name: string) => {
    if (!layerInfo.has(name)) layerInfo.set(name, { color: { aci: 7 }, visible: true });
  };
  noteLayer("0");
  const visit = (list: DrawingEntity[]) => list.forEach((e) => noteLayer(e.layer || "0"));
  visit(drawing.entities);
  for (const block of Object.values(drawing.blocks)) visit(block.entities);
  const names = [...layerInfo.keys()].sort((a, b) => (a === "0" ? -1 : b === "0" ? 1 : collator.compare(a, b)));
  const layerIndex = new Map(names.map((name, i) => [name, i]));
  const layers: SceneLayer[] = names.map((name) => {
    const info = layerInfo.get(name)!;
    return { name, color: resolveColor({ aci: BYLAYER }, info.color), visible: info.visible };
  });
  const layerColor = (i: number) => layerInfo.get(names[i])!.color;
  const layerLineType = (i: number) => layerInfo.get(names[i])!.lineType;

  const lineTypes = new Map<string, number[]>();
  for (const [name, pattern] of Object.entries(drawing.lineTypes)) lineTypes.set(name.toUpperCase(), pattern);
  const globalScale = drawing.lineTypeScale > 0 ? drawing.lineTypeScale : 1;

  const builders = new Map<string, Builder>();
  const done: Builder[] = [];
  const texts: SceneText[] = [];
  const snaps: number[] = [];
  let total = 0,
    truncated = false,
    entities = 0,
    segments = 0;
  const builder = (layer: number, color: number, kind: BatchKind, dash: number[]) => {
    const key = `${layer}|${color}|${kind}|${dash.join(",")}`;
    let b = builders.get(key);
    if (b && b.points.length / 2 >= BATCH_POINTS) {
      done.push(b);
      b = undefined;
    }
    if (!b) {
      b = { layer, color, kind, dash, points: [], starts: [], shapes: [] };
      builders.set(key, b);
    }
    return b;
  };
  const room = (n: number) => {
    if (total + n > maxPoints) {
      truncated = true;
      return false;
    }
    total += n;
    return true;
  };

  // The dash pattern of a linetype, scaled (empty for continuous ones).
  const dashFor = (name: string | null, scale: number): number[] => {
    if (!name) return [];
    const pattern = lineTypes.get(name.toUpperCase());
    if (!pattern || pattern.length < 2) return [];
    const lengths = pattern.map((v) => Math.abs(v) * scale);
    const sum = lengths.reduce((a, b) => a + b, 0);
    if (!(sum > 0)) return [];
    // A dot (0) becomes a short dash; an odd count repeats (as canvas does).
    return lengths.map((v) => (v === 0 ? sum / 100 : v));
  };

  const emit = (ctx: Context, e: DrawingEntity, rings: Pt[][], kind: BatchKind) => {
    const layer = effectiveLayer(ctx, e);
    const color = resolveColor(e.color, layerColor(layer), ctx.color);
    let lineType: string | null = null;
    if (kind === "stroke") {
      const own = (e.lineType || "BYLAYER").toUpperCase();
      lineType = own === "BYLAYER" ? layerLineType(layer)?.toUpperCase() || null : own === "BYBLOCK" ? ctx.lineType : own;
      if (lineType === "CONTINUOUS") lineType = null;
    }
    const dash = dashFor(lineType, globalScale * (e.lineTypeScale || 1) * ctx.ltScale);
    const b = builder(layer, color, kind, dash);
    if (kind !== "stroke") b.shapes.push(b.starts.length);
    for (const ring of rings) {
      if (ring.length < 2 || !room(ring.length)) continue;
      b.starts.push(b.points.length / 2);
      for (const p of ring) {
        const q = apply(ctx.m, p);
        b.points.push(q.x, q.y);
      }
      segments += ring.length - 1;
    }
  };
  const snap = (ctx: Context, ...points: Pt[]) => {
    for (const p of points) {
      const q = apply(ctx.m, p);
      if (Number.isFinite(q.x) && Number.isFinite(q.y)) snaps.push(q.x, q.y);
    }
  };
  // Entities on layer 0 inside a block take the layer of the reference.
  const effectiveLayer = (ctx: Context, e: DrawingEntity) => {
    const own = layerIndex.get(e.layer || "0") ?? 0;
    return own === 0 && ctx.layer !== null ? ctx.layer : own;
  };

  const draw = (ctx: Context, e: DrawingEntity) => {
    entities++;
    switch (e.type) {
      case "line":
        emit(ctx, e, [[e.a, e.b]], "stroke");
        snap(ctx, e.a, e.b);
        break;
      case "polyline": {
        const points = polylinePoints(e.vertices, e.closed);
        emit(ctx, e, [points], "stroke");
        snap(ctx, ...e.vertices);
        break;
      }
      case "circle":
        if (!(e.r > 0)) break;
        emit(ctx, e, [circlePoints(e.c, e.r)], "stroke");
        snap(ctx, e.c, { x: e.c.x + e.r, y: e.c.y }, { x: e.c.x - e.r, y: e.c.y }, { x: e.c.x, y: e.c.y + e.r }, { x: e.c.x, y: e.c.y - e.r });
        break;
      case "arc": {
        if (!(e.r > 0)) break;
        const points = arcPoints(e.c, e.r, e.start, e.end);
        emit(ctx, e, [points], "stroke");
        snap(ctx, e.c, points[0], points[points.length - 1]);
        break;
      }
      case "ellipse": {
        const points = ellipsePoints(e.c, e.major, e.ratio, e.start, e.end);
        emit(ctx, e, [points], "stroke");
        snap(ctx, e.c, points[0], points[points.length - 1]);
        break;
      }
      case "spline": {
        const points = splinePoints(e.degree, e.controls, e.knots, e.weights, e.fit);
        if (e.closed && points.length > 2) points.push(points[0]);
        emit(ctx, e, [points], "stroke");
        if (points.length) snap(ctx, points[0], points[points.length - 1]);
        break;
      }
      case "fill":
        emit(ctx, e, e.rings, e.solid ? "fill" : "tint");
        break;
      case "point":
        snap(ctx, e.at);
        break;
      case "text": {
        if (!(e.height > 0) || !e.lines.some((line) => line.trim())) break;
        const layer = effectiveLayer(ctx, e);
        const at = apply(ctx.m, e.at);
        texts.push({
          layer,
          color: resolveColor(e.color, layerColor(layer), ctx.color),
          x: at.x,
          y: at.y,
          height: e.height * matScale(ctx.m),
          rotation: e.rotation + matAngle(ctx.m),
          lines: e.lines,
          anchor: e.anchor,
          lineSpacing: e.lineSpacing || 1,
        });
        snap(ctx, e.at);
        break;
      }
      case "insert": {
        const block = drawing.blocks[e.block];
        if (!block || ctx.depth >= MAX_DEPTH) break;
        const layer = effectiveLayer(ctx, e);
        const own = (e.lineType || "BYLAYER").toUpperCase();
        const inner: Omit<Context, "m"> = {
          layer,
          color: resolveColor(e.color, layerColor(layer), ctx.color),
          lineType: own === "BYLAYER" ? layerLineType(layer)?.toUpperCase() || null : own === "BYBLOCK" ? ctx.lineType : own,
          ltScale: ctx.ltScale * (e.lineTypeScale || 1),
          depth: ctx.depth + 1,
        };
        const columns = Math.max(1, Math.floor(e.columns) || 1),
          rows = Math.max(1, Math.floor(e.rows) || 1);
        if (columns * rows > MAX_ARRAY) break;
        for (let r = 0; r < rows; r++)
          for (let c = 0; c < columns; c++) {
            const m = multiply(ctx.m, insertTransform(e.at, e.sx, e.sy, e.rotation, block.base, { x: c * e.columnSpacing, y: r * e.rowSpacing }));
            for (const child of block.entities) draw({ ...inner, m }, child);
          }
        snap(ctx, e.at);
        break;
      }
    }
  };
  const top: Context = { m: IDENTITY, layer: null, color: INK, lineType: null, ltScale: 1, depth: 0 };
  for (const e of drawing.entities) draw(top, e);

  // The bounding box of everything, then all coordinates relative to its
  // centre.
  const all = [...done, ...builders.values()].filter((b) => b.points.length >= 4);
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  const grow = (x: number, y: number) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };
  for (const b of all) for (let i = 0; i < b.points.length; i += 2) grow(b.points[i], b.points[i + 1]);
  for (const text of texts) grow(text.x, text.y);
  // A few stray objects far away (a broken block reference, something
  // forgotten miles off) would make "fit" show a dot. Each polyline and
  // text counts once, by the centre of its box: going out from the middle
  // 80 % of the centres, a jump larger than twice that middle's span ends
  // the drawing, and the box is that of the objects within.
  const boxes: [number, number, number, number][] = [];
  for (const b of all)
    for (let r = 0; r < b.starts.length; r++) {
      const to = r + 1 < b.starts.length ? b.starts[r + 1] : b.points.length / 2;
      let x0 = Infinity,
        y0 = Infinity,
        x1 = -Infinity,
        y1 = -Infinity;
      for (let i = b.starts[r]; i < to; i++) {
        const x = b.points[i * 2],
          y = b.points[i * 2 + 1];
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
      if (x1 >= x0) boxes.push([x0, y0, x1, y1]);
    }
  for (const text of texts) if (Number.isFinite(text.x) && Number.isFinite(text.y)) boxes.push([text.x, text.y, text.x, text.y]);
  if (boxes.length >= 10) {
    const range = (values: number[]): [number, number] => {
      values.sort((a, b) => a - b);
      let lo = Math.floor(values.length * 0.1),
        hi = Math.ceil(values.length * 0.9) - 1;
      const gap = Math.max(values[hi] - values[lo], 1e-9) * 2;
      while (lo > 0 && values[lo] - values[lo - 1] <= gap) lo--;
      while (hi < values.length - 1 && values[hi + 1] - values[hi] <= gap) hi++;
      return [values[lo], values[hi]];
    };
    const [cx0, cx1] = range(boxes.map((b) => (b[0] + b[2]) / 2)),
      [cy0, cy1] = range(boxes.map((b) => (b[1] + b[3]) / 2));
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const b of boxes) {
      const cx = (b[0] + b[2]) / 2,
        cy = (b[1] + b[3]) / 2;
      if (cx < cx0 || cx > cx1 || cy < cy0 || cy > cy1) continue;
      x0 = Math.min(x0, b[0]);
      y0 = Math.min(y0, b[1]);
      x1 = Math.max(x1, b[2]);
      y1 = Math.max(y1, b[3]);
    }
    if (x1 >= x0 && y1 >= y0) [minX, minY, maxX, maxY] = [x0, y0, x1, y1];
  }
  const empty = !(maxX >= minX);
  const origin: [number, number] = empty ? [0, 0] : [(minX + maxX) / 2, (minY + maxY) / 2];
  const batches: Batch[] = all.map((b) => {
    const points = new Float32Array(b.points.length);
    let bx0 = Infinity,
      by0 = Infinity,
      bx1 = -Infinity,
      by1 = -Infinity;
    for (let i = 0; i < b.points.length; i += 2) {
      const x = b.points[i] - origin[0],
        y = b.points[i + 1] - origin[1];
      points[i] = x;
      points[i + 1] = y;
      if (x < bx0) bx0 = x;
      if (x > bx1) bx1 = x;
      if (y < by0) by0 = y;
      if (y > by1) by1 = y;
    }
    return {
      layer: b.layer,
      color: b.color,
      kind: b.kind,
      dash: b.dash,
      points,
      starts: Uint32Array.from(b.starts),
      shapes: b.kind === "stroke" ? undefined : Uint32Array.from(b.shapes),
      bounds: [bx0, by0, bx1, by1],
    };
  });
  for (const text of texts) {
    text.x -= origin[0];
    text.y -= origin[1];
  }
  const snapArray = new Float64Array(snaps.length);
  for (let i = 0; i < snaps.length; i += 2) {
    snapArray[i] = snaps[i] - origin[0];
    snapArray[i + 1] = snaps[i + 1] - origin[1];
  }
  return {
    origin,
    units: drawing.units,
    layers,
    batches,
    texts,
    snaps: snapArray,
    bounds: empty ? null : [minX - origin[0], minY - origin[1], maxX - origin[0], maxY - origin[1]],
    entities,
    segments,
    truncated,
    skipped: drawing.skipped,
  };
}

// The arrays to transfer from the worker.
export function sceneTransferables(scene: DrawingScene): ArrayBuffer[] {
  const list: ArrayBuffer[] = [scene.snaps.buffer as ArrayBuffer];
  for (const b of scene.batches) for (const a of [b.points, b.starts, b.shapes]) if (a) list.push(a.buffer as ArrayBuffer);
  return list;
}

// ---- The layer list ----

// Which layers are shown: at first those that are on and not frozen.
export const initialVisibility = (layers: SceneLayer[]) => layers.map((layer) => layer.visible);
export const toggleLayer = (visible: boolean[], index: number) => visible.map((v, i) => (i === index ? !v : v));
export const setAllLayers = (visible: boolean[], on: boolean) => visible.map(() => on);
// The batches and texts drawn with these layers.
export const shownBatches = (scene: DrawingScene, visible: boolean[]) => scene.batches.filter((b) => visible[b.layer]);
export const shownTexts = (scene: DrawingScene, visible: boolean[]) => scene.texts.filter((t) => visible[t.layer]);
// The bounding box of what is shown (for "fit"), or of everything when
// nothing is.
export function shownBounds(scene: DrawingScene, visible: boolean[]): [number, number, number, number] | null {
  let box: [number, number, number, number] | null = null;
  for (const b of shownBatches(scene, visible))
    box = box ? [Math.min(box[0], b.bounds[0]), Math.min(box[1], b.bounds[1]), Math.max(box[2], b.bounds[2]), Math.max(box[3], b.bounds[3])] : [...b.bounds];
  for (const t of shownTexts(scene, visible)) box = box ? [Math.min(box[0], t.x), Math.min(box[1], t.y), Math.max(box[2], t.x), Math.max(box[3], t.y)] : [t.x, t.y, t.x, t.y];
  if (!box || !scene.bounds) return scene.bounds;
  // Within the drawing's box (which leaves out stray far-away points).
  const all = scene.bounds;
  const cut: [number, number, number, number] = [Math.max(box[0], all[0]), Math.max(box[1], all[1]), Math.min(box[2], all[2]), Math.min(box[3], all[3])];
  return cut[2] >= cut[0] && cut[3] >= cut[1] ? cut : scene.bounds;
}
// How many things each layer holds (for the list).
export function layerCounts(scene: DrawingScene): number[] {
  const counts = scene.layers.map(() => 0);
  for (const b of scene.batches) counts[b.layer] += b.starts.length;
  for (const t of scene.texts) counts[t.layer]++;
  return counts;
}
export { BYBLOCK, BYLAYER, INK };
