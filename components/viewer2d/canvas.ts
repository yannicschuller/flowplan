// The canvas of the drawing viewer (#384): draws the scene of
// lib/drawing-scene.ts with Canvas 2D – one Path2D per batch in drawing
// coordinates, so panning and zooming only change the transform; batches
// outside the view and text too small to read are skipped. Pan with a
// finger or the mouse (any button), zoom with the wheel or a pinch, arrow
// keys pan. The measuring tool snaps to the nearest end or vertex. Drawn
// only when something changes.
import { SnapIndex, fitView, measure, panBy, toScreen, toWorld, zoomAt, type Pt, type View } from "@/lib/drawing-geometry";
import { INK, shownBounds, type Batch, type DrawingScene } from "@/lib/drawing-scene";
import { hexColor } from "@/lib/drawing-model";

export type Paper = "light" | "dark";
export type Measurement = { id: number; a: Pt; b: Pt; distance: number; dx: number; dy: number };

const PAPER = { light: { bg: "#ffffff", ink: "#1d2330" }, dark: { bg: "#15181e", ink: "#e8eaee" } };
const ACCENT = "#f2620f";
const SNAP_PX = 14;
const ZOOM_STEP = 1.4;
const TINT_ALPHA = 0.22;

type Prepared = { batch: Batch; paths: Path2D[] };

export class DrawingCanvas {
  view: View = { scale: 1, x: 0, y: 0 };
  private width = 1;
  private height = 1;
  private dpr = 1;
  private paper: Paper = "light";
  private visible: boolean[];
  private prepared: Prepared[];
  private snaps: SnapIndex;
  private frame = 0;
  private measuring = false;
  private pending: Pt | null = null;
  private hover: Pt | null = null;
  private measurements: Measurement[] = [];
  private nextId = 1;
  private pointers = new Map<number, Pt>();
  private gesture: { x: number; y: number; distance: number; moved: boolean; at: number } | null = null;
  private fitted = 1;

  constructor(
    readonly canvas: HTMLCanvasElement,
    readonly scene: DrawingScene,
    private readonly events: {
      onMeasurements: (list: Measurement[]) => void;
      onPending: (pending: boolean) => void;
      onZoom?: (scale: number) => void;
      label: (distance: number) => string;
    },
  ) {
    this.visible = scene.layers.map((layer) => layer.visible);
    this.prepared = scene.batches.map((batch) => ({ batch, paths: [] }));
    this.snaps = new SnapIndex(scene.snaps);
    canvas.addEventListener("pointerdown", this.down);
    canvas.addEventListener("pointermove", this.move);
    canvas.addEventListener("pointerup", this.up);
    canvas.addEventListener("pointercancel", this.cancel);
    canvas.addEventListener("pointerleave", this.leave);
    canvas.addEventListener("wheel", this.wheel, { passive: false });
    canvas.addEventListener("keydown", this.key);
  }

  dispose() {
    cancelAnimationFrame(this.frame);
    const c = this.canvas;
    c.removeEventListener("pointerdown", this.down);
    c.removeEventListener("pointermove", this.move);
    c.removeEventListener("pointerup", this.up);
    c.removeEventListener("pointercancel", this.cancel);
    c.removeEventListener("pointerleave", this.leave);
    c.removeEventListener("wheel", this.wheel);
    c.removeEventListener("keydown", this.key);
  }

  resize(width: number, height: number) {
    const first = this.width === 1 && this.height === 1;
    const old = { w: this.width, h: this.height };
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    // Keep the middle of the picture in the middle.
    if (first) this.fit();
    else {
      this.view = panBy(this.view, (this.width - old.w) / 2, (this.height - old.h) / 2);
      this.request();
    }
  }

  // Everything that is shown, whole, in the middle.
  fit() {
    this.view = fitView(shownBounds(this.scene, this.visible), this.width, this.height);
    this.fitted = this.view.scale;
    this.changed();
  }
  zoom(direction: 1 | -1) {
    this.view = this.clampZoom(zoomAt(this.view, direction > 0 ? ZOOM_STEP : 1 / ZOOM_STEP, { x: this.width / 2, y: this.height / 2 }));
    this.changed();
  }
  pan(dx: number, dy: number) {
    this.view = panBy(this.view, dx, dy);
    this.changed();
  }
  setPaper(paper: Paper) {
    this.paper = paper;
    this.request();
  }
  setVisible(visible: boolean[]) {
    this.visible = visible;
    this.request();
  }
  setMeasuring(on: boolean) {
    this.measuring = on;
    this.canvas.classList.toggle("is-measuring", on);
    if (!on) {
      this.pending = null;
      this.hover = null;
      this.events.onPending(false);
    }
    this.request();
  }
  clearMeasurements() {
    this.measurements = [];
    this.pending = null;
    this.events.onPending(false);
    this.events.onMeasurements([]);
    this.request();
  }
  removeMeasurement(id: number) {
    this.measurements = this.measurements.filter((m) => m.id !== id);
    this.events.onMeasurements([...this.measurements]);
    this.request();
  }
  // The world point a screen point snaps to (an end or vertex nearby), or
  // the point itself.
  snapAt(screen: Pt): { point: Pt; snapped: boolean } {
    const world = toWorld(this.view, screen);
    const near = this.snaps.nearest(world.x, world.y, SNAP_PX / this.view.scale);
    return near ? { point: near, snapped: true } : { point: world, snapped: false };
  }
  // Adds a measuring point at a screen position (also for the keyboard-free
  // tests): the first starts a measurement, the second ends it.
  pick(screen: Pt) {
    const { point } = this.snapAt(screen);
    if (!this.pending) {
      this.pending = point;
      this.events.onPending(true);
    } else {
      const m = measure(this.pending, point);
      this.measurements = [...this.measurements, { id: this.nextId++, a: this.pending, b: point, ...m }];
      this.pending = null;
      this.events.onPending(false);
      this.events.onMeasurements([...this.measurements]);
    }
    this.request();
  }

  private clampZoom(view: View) {
    const min = this.fitted / 50,
      max = this.fitted * 1e6;
    if (view.scale < min) return zoomAt(this.view, min / this.view.scale, { x: this.width / 2, y: this.height / 2 });
    if (view.scale > max) return this.view;
    return view;
  }
  private changed() {
    this.canvas.dataset.scale = String(this.view.scale);
    this.events.onZoom?.(this.view.scale);
    this.request();
  }
  private request() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }
  // Draws now (the tests read the picture right after a change).
  draw() {
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    const { bg, ink } = PAPER[this.paper];
    const { scale, x, y } = this.view;
    const dpr = this.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    // The visible part of the drawing, for skipping what is outside.
    const a = toWorld(this.view, { x: 0, y: this.height }),
      b = toWorld(this.view, { x: this.width, y: 0 });
    const outside = (box: [number, number, number, number]) => box[2] < a.x || box[0] > b.x || box[3] < a.y || box[1] > b.y;
    ctx.setTransform(dpr * scale, 0, 0, -dpr * scale, dpr * x, dpr * y);
    ctx.lineWidth = 1 / scale;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    const colorOf = (color: number) => (color === INK ? ink : this.readable(color, ink));
    // Fills under lines.
    for (const pass of ["tint", "fill", "stroke"] as const)
      for (const item of this.prepared) {
        const batch = item.batch;
        if (batch.kind !== pass || !this.visible[batch.layer] || outside(batch.bounds)) continue;
        const paths = this.paths(item);
        if (pass === "stroke") {
          ctx.strokeStyle = colorOf(batch.color);
          const length = batch.dash.reduce((s, v) => s + v, 0);
          // Dashes smaller than a few pixels look like a solid line anyway.
          ctx.setLineDash(batch.dash.length && length * scale > 6 ? batch.dash : []);
          for (const path of paths) ctx.stroke(path);
        } else {
          ctx.fillStyle = colorOf(batch.color);
          ctx.globalAlpha = pass === "tint" ? TINT_ALPHA : 1;
          for (const path of paths) ctx.fill(path, "evenodd");
          ctx.globalAlpha = 1;
        }
      }
    ctx.setLineDash([]);
    // Text in screen pixels (fonts misbehave at drawing scales).
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const text of this.scene.texts) {
      if (!this.visible[text.layer]) continue;
      const px = text.height * scale;
      if (px < 2.5 || px > 4000) continue;
      const at = toScreen(this.view, text);
      const reach = (px * Math.max(...text.lines.map((l) => l.length), 1) * text.lineSpacing + px * text.lines.length * 2) | 0;
      if (at.x < -reach || at.x > this.width + reach || at.y < -reach || at.y > this.height + reach) continue;
      ctx.save();
      ctx.translate(at.x, at.y);
      ctx.rotate(-text.rotation);
      // The text height is the height of capitals, about 0.7 of the font size.
      ctx.font = `${px / 0.7}px system-ui, -apple-system, "Segoe UI", sans-serif`;
      ctx.fillStyle = colorOf(text.color);
      ctx.textAlign = text.anchor.h === 1 ? "center" : text.anchor.h === 2 ? "right" : "left";
      ctx.textBaseline = "alphabetic";
      const gap = px * text.lineSpacing;
      const n = text.lines.length;
      const block = (n - 1) * gap + px;
      for (let i = 0; i < n; i++) {
        const v = text.anchor.v;
        const baseline = v === "top" ? px + i * gap : v === "middle" ? px - block / 2 + i * gap : v === "bottom" ? -(n - 1 - i) * gap : i * gap;
        ctx.fillText(text.lines[i], 0, baseline);
      }
      ctx.restore();
    }
    this.drawOverlay(ctx);
  }

  private drawOverlay(ctx: CanvasRenderingContext2D) {
    const marker = (p: Pt, filled: boolean) => {
      const s = toScreen(this.view, p);
      ctx.beginPath();
      ctx.arc(s.x, s.y, 5, 0, Math.PI * 2);
      ctx.fillStyle = filled ? ACCENT : PAPER[this.paper].bg;
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 2;
      ctx.fill();
      ctx.stroke();
    };
    ctx.lineWidth = 2;
    for (const m of this.measurements) {
      const a = toScreen(this.view, m.a),
        b = toScreen(this.view, m.b);
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      marker(m.a, true);
      marker(m.b, true);
      const label = this.events.label(m.distance);
      ctx.font = `600 13px system-ui, -apple-system, "Segoe UI", sans-serif`;
      const w = ctx.measureText(label).width + 12;
      const cx = (a.x + b.x) / 2,
        cy = (a.y + b.y) / 2 - 16;
      ctx.fillStyle = ACCENT;
      ctx.beginPath();
      ctx.roundRect(cx - w / 2, cy - 11, w, 22, 6);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, cx, cy + 0.5);
    }
    if (this.pending) {
      marker(this.pending, true);
      if (this.hover) {
        const a = toScreen(this.view, this.pending),
          b = toScreen(this.view, this.hover);
        ctx.strokeStyle = ACCENT;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    if (this.measuring && this.hover) marker(this.hover, false);
  }

  // A colour that stands out from the paper: very light colours on white
  // paper and very dark ones on dark paper are drawn in ink instead.
  private readable(rgb: number, ink: string) {
    const r = (rgb >> 16) & 255,
      g = (rgb >> 8) & 255,
      b = rgb & 255;
    const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    if (this.paper === "light" ? luminance > 0.9 : luminance < 0.1) return ink;
    return hexColor(rgb);
  }

  private paths(item: Prepared) {
    if (item.paths.length) return item.paths;
    const { points, starts, shapes, kind } = item.batch;
    const ring = (path: Path2D, k: number) => {
      const from = starts[k],
        to = k + 1 < starts.length ? starts[k + 1] : points.length / 2;
      path.moveTo(points[from * 2], points[from * 2 + 1]);
      for (let i = from + 1; i < to; i++) path.lineTo(points[i * 2], points[i * 2 + 1]);
      if (kind !== "stroke") path.closePath();
    };
    if (kind === "stroke" || !shapes) {
      const path = new Path2D();
      for (let k = 0; k < starts.length; k++) ring(path, k);
      item.paths = [path];
    } else
      for (let s = 0; s < shapes.length; s++) {
        const path = new Path2D();
        const end = s + 1 < shapes.length ? shapes[s + 1] : starts.length;
        for (let k = shapes[s]; k < end; k++) ring(path, k);
        item.paths.push(path);
      }
    return item.paths;
  }

  // ---- Input ----

  private local(event: PointerEvent | WheelEvent): Pt {
    const box = this.canvas.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  }
  private down = (event: PointerEvent) => {
    this.canvas.focus({ preventScroll: true });
    this.canvas.setPointerCapture?.(event.pointerId);
    this.pointers.set(event.pointerId, this.local(event));
    this.gesture = this.gestureNow();
    if (this.gesture) this.gesture.at = performance.now();
  };
  private gestureNow() {
    const list = [...this.pointers.values()];
    if (!list.length) return null;
    const x = list.reduce((s, p) => s + p.x, 0) / list.length,
      y = list.reduce((s, p) => s + p.y, 0) / list.length;
    const distance = list.length >= 2 ? Math.hypot(list[0].x - list[1].x, list[0].y - list[1].y) : 0;
    return { x, y, distance, moved: this.gesture?.moved ?? false, at: this.gesture?.at ?? performance.now() };
  }
  private move = (event: PointerEvent) => {
    const at = this.local(event);
    if (!this.pointers.has(event.pointerId)) {
      if (this.measuring && event.pointerType === "mouse") {
        this.hover = this.snapAt(at).point;
        this.request();
      }
      return;
    }
    const before = this.gesture;
    this.pointers.set(event.pointerId, at);
    const now = this.gestureNow();
    if (!before || !now) return;
    const dx = now.x - before.x,
      dy = now.y - before.y;
    // Small jitter of a tap is not a pan (the gesture keeps its start).
    if (!before.moved && this.pointers.size === 1 && Math.hypot(dx, dy) < 4 && performance.now() - before.at < 400) return;
    const moved = before.moved || Math.hypot(dx, dy) > 0 || (before.distance > 0 && Math.abs(now.distance - before.distance) > 0);
    let view = panBy(this.view, dx, dy);
    if (before.distance > 0 && now.distance > 0) view = zoomAt(view, now.distance / before.distance, { x: now.x, y: now.y });
    this.view = this.clampZoom(view);
    this.gesture = { ...now, moved };
    if (this.measuring && event.pointerType === "mouse") this.hover = this.snapAt(at).point;
    this.changed();
  };
  private up = (event: PointerEvent) => {
    const gesture = this.gesture;
    const tap = this.pointers.size === 1 && gesture && !gesture.moved;
    this.pointers.delete(event.pointerId);
    this.gesture = this.gestureNow();
    if (tap && this.measuring && event.button <= 0) this.pick(this.local(event));
  };
  private cancel = (event: PointerEvent) => {
    this.pointers.delete(event.pointerId);
    this.gesture = this.gestureNow();
  };
  private leave = () => {
    if (this.hover && !this.pointers.size) {
      this.hover = null;
      this.request();
    }
  };
  private wheel = (event: WheelEvent) => {
    event.preventDefault();
    // Lines and pages (Firefox) in pixels; a trackpad pinch comes with ctrlKey.
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1);
    this.view = this.clampZoom(zoomAt(this.view, Math.exp(-delta * (event.ctrlKey ? 0.01 : 0.0015)), this.local(event)));
    this.changed();
  };
  private key = (event: KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const step = Math.min(this.width, this.height) * 0.15;
    const moves: Record<string, [number, number]> = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    this.pan(move[0], move[1]);
  };
}
