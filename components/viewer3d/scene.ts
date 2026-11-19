// The three.js scene of the 3D viewer (#384): the model, a light that moves
// with the camera, orbit/pan/zoom (OrbitControls: mouse, touch with one
// finger to turn and two to pinch and pan, arrow keys to pan), the
// standard views and the measuring tool. Drawn only when something changes.
// The arithmetic is in lib/model-geometry.ts.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { boxCenter, boxRadius, boxSize, fitDistance, measureDistance, screenScale, viewDirection, zoomDistance, type StandardView, type Up, type Vec3 } from "@/lib/model-geometry";

export type Measurement = { id: number; a: Vec3; b: Vec3; distance: number };
type Shown = { data: Measurement; group: THREE.Group; label: THREE.Sprite; aspect: number };

const FOV = 35;
const ACCENT = 0xf2620f;
const LABEL_PX = 26;
const vec = (v: THREE.Vector3): Vec3 => [v.x, v.y, v.z];

export class ModelScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 1000);
  readonly scene = new THREE.Scene();
  readonly controls: OrbitControls;
  readonly size: Vec3;
  view: StandardView | "custom" = "iso";
  private center: Vec3;
  private radius: number;
  private fitted = 1;
  private frame = 0;
  private height = 1;
  private measuring = false;
  private pending: { point: Vec3; marker: THREE.Mesh } | null = null;
  private shown: Shown[] = [];
  private nextId = 1;
  private overlay = new THREE.Group();
  private down: { x: number; y: number; at: number } | null = null;
  private raycaster = new THREE.Raycaster();

  constructor(
    readonly canvas: HTMLCanvasElement,
    readonly model: THREE.Object3D,
    readonly up: Up,
    private readonly events: {
      onMeasurements: (list: Measurement[]) => void;
      onPending: (pending: boolean) => void;
      onView: (view: StandardView | "custom") => void;
      label: (distance: number) => string;
    },
  ) {
    // The drawing buffer is kept so the picture can be read back (tests).
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x000000, 0);
    if (up === "z") this.camera.up.set(0, 0, 1);
    this.scene.add(model, this.overlay);
    // Soft light from everywhere, and one from just above the camera.
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f99, 1.6));
    const light = new THREE.DirectionalLight(0xffffff, 1.8);
    light.position.set(0.4, 0.8, 0.3);
    this.camera.add(light);
    this.scene.add(this.camera);

    const box = new THREE.Box3().setFromObject(model);
    const min = vec(box.min),
      max = vec(box.max);
    this.size = boxSize(min, max);
    this.center = boxCenter(min, max);
    this.radius = boxRadius(min, max) || 1;
    this.camera.near = this.radius / 500;
    this.camera.far = this.radius * 200;

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.screenSpacePanning = true;
    this.controls.zoomToCursor = true;
    this.controls.listenToKeyEvents(canvas);
    this.controls.addEventListener("change", () => this.requestRender());
    // Turned by hand: no standard view any more.
    this.controls.addEventListener("start", () => this.setViewName("custom"));
    canvas.addEventListener("pointerdown", this.pointerDown);
    canvas.addEventListener("pointerup", this.pointerUp);
  }

  private setViewName(view: StandardView | "custom") {
    if (this.view === view) return;
    this.view = view;
    this.canvas.dataset.view = view;
    this.events.onView(view);
  }

  requestRender() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.renderer.render(this.scene, this.camera);
    });
  }

  resize(width: number, height: number) {
    if (width < 1 || height < 1) return;
    // Not the canvas's style: its size comes from the CSS (.viewer3d-canvas).
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.height = height;
    for (const shown of this.shown) this.scaleLabel(shown);
    this.fitted = fitDistance(this.radius, FOV, this.camera.aspect);
    this.controls.minDistance = this.fitted / 100;
    this.controls.maxDistance = this.fitted * 20;
    // A standard view stays fitted when the stage changes its size (the
    // bar below appears, the phone turns); one turned by hand stays as it is.
    if (this.view !== "custom") this.setView(this.view);
    this.requestRender();
  }

  // A standard view of the whole model.
  setView(view: StandardView) {
    const { from, up } = viewDirection(view, this.up);
    const direction = new THREE.Vector3(...from);
    // Looking straight along the up axis: a hair off it, so the screen's
    // up is the view's (OrbitControls keeps the model's up axis).
    if (Math.abs(direction.dot(this.camera.up)) > 0.999) direction.addScaledVector(new THREE.Vector3(...up), -0.001).normalize();
    this.place(direction, this.fitted);
    this.setViewName(view);
  }
  // The isometric view, the whole model, measurements kept.
  home() {
    this.setView("iso");
  }
  // The whole model from where the camera looks now.
  fit() {
    const direction = this.camera.position.clone().sub(this.controls.target).normalize();
    this.place(direction.lengthSq() ? direction : new THREE.Vector3(1, -1, 1).normalize(), this.fitted);
  }
  zoom(direction: 1 | -1) {
    this.setViewName("custom");
    const offset = this.camera.position.clone().sub(this.controls.target);
    offset.setLength(zoomDistance(offset.length(), direction, this.fitted));
    this.camera.position.copy(this.controls.target).add(offset);
    this.controls.update();
    this.requestRender();
  }
  private place(direction: THREE.Vector3, distance: number) {
    const target = new THREE.Vector3(...this.center);
    this.controls.target.copy(target);
    this.camera.position.copy(target).addScaledVector(direction, distance);
    this.camera.lookAt(target);
    this.controls.update();
    this.requestRender();
  }

  setWireframe(on: boolean) {
    this.model.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) (material as THREE.MeshStandardMaterial).wireframe = on;
    });
    this.requestRender();
  }

  /* ---------- Measuring ---------- */

  setMeasuring(on: boolean) {
    this.measuring = on;
    this.canvas.classList.toggle("is-measuring", on);
    if (!on) this.dropPending();
  }
  private dropPending() {
    if (!this.pending) return;
    this.overlay.remove(this.pending.marker);
    dispose(this.pending.marker);
    this.pending = null;
    this.events.onPending(false);
    this.requestRender();
  }
  clearMeasurements() {
    this.dropPending();
    for (const shown of this.shown) {
      this.overlay.remove(shown.group);
      dispose(shown.group);
    }
    this.shown = [];
    this.events.onMeasurements([]);
    this.requestRender();
  }
  removeMeasurement(id: number) {
    const shown = this.shown.find((s) => s.data.id === id);
    if (!shown) return;
    this.overlay.remove(shown.group);
    dispose(shown.group);
    this.shown = this.shown.filter((s) => s !== shown);
    this.events.onMeasurements(this.shown.map((s) => s.data));
    this.requestRender();
  }
  // A click (not a drag) on the surface while measuring sets a point.
  private pointerDown = (event: PointerEvent) => {
    this.down = event.isPrimary ? { x: event.clientX, y: event.clientY, at: performance.now() } : null;
  };
  private pointerUp = (event: PointerEvent) => {
    const down = this.down;
    this.down = null;
    if (!this.measuring || !down || !event.isPrimary) return;
    if (Math.hypot(event.clientX - down.x, event.clientY - down.y) > 6 || performance.now() - down.at > 800) return;
    const rect = this.canvas.getBoundingClientRect();
    const hit = this.pick((event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height);
    if (hit) this.addPoint(hit);
  };
  // The point of the model's surface under (x, y), both 0–1 of the view.
  pick(x: number, y: number): Vec3 | null {
    this.raycaster.setFromCamera(new THREE.Vector2(x * 2 - 1, 1 - y * 2), this.camera);
    const hit = this.raycaster.intersectObject(this.model, true)[0];
    return hit ? vec(hit.point) : null;
  }
  addPoint(point: Vec3) {
    if (!this.pending) {
      const marker = this.marker(point);
      this.overlay.add(marker);
      this.pending = { point, marker };
      this.events.onPending(true);
      this.requestRender();
      return;
    }
    const a = this.pending.point;
    this.overlay.remove(this.pending.marker);
    dispose(this.pending.marker);
    this.pending = null;
    this.events.onPending(false);
    const data: Measurement = { id: this.nextId++, a, b: point, distance: measureDistance(a, point) };
    const group = new THREE.Group();
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...a), new THREE.Vector3(...point)]),
      new THREE.LineBasicMaterial({ color: ACCENT, depthTest: false, transparent: true }),
    );
    line.renderOrder = 10;
    const { sprite, aspect } = labelSprite(this.events.label(data.distance));
    sprite.position.set((a[0] + point[0]) / 2, (a[1] + point[1]) / 2, (a[2] + point[2]) / 2);
    group.add(line, this.marker(a), this.marker(point), sprite);
    this.overlay.add(group);
    const shown = { data, group, label: sprite, aspect };
    this.scaleLabel(shown);
    this.shown.push(shown);
    this.events.onMeasurements(this.shown.map((s) => s.data));
    this.requestRender();
  }
  private marker(point: Vec3) {
    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(this.radius * 0.012, 16, 12),
      new THREE.MeshBasicMaterial({ color: ACCENT, depthTest: false, transparent: true }),
    );
    marker.renderOrder = 11;
    marker.position.set(...point);
    return marker;
  }
  private scaleLabel(shown: Shown) {
    const h = screenScale(LABEL_PX, this.height, FOV);
    shown.label.scale.set(h * shown.aspect, h, 1);
  }

  dispose() {
    cancelAnimationFrame(this.frame);
    this.canvas.removeEventListener("pointerdown", this.pointerDown);
    this.canvas.removeEventListener("pointerup", this.pointerUp);
    this.controls.dispose();
    dispose(this.scene);
    this.renderer.dispose();
  }
}

// The distance as a label that keeps its size on the screen.
function labelSprite(text: string) {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d")!;
  const font = "600 30px system-ui, -apple-system, 'Segoe UI', sans-serif";
  context.font = font;
  const width = Math.ceil(context.measureText(text).width) + 28;
  canvas.width = width;
  canvas.height = 46;
  context.font = font;
  context.fillStyle = "rgba(22, 21, 27, 0.88)";
  context.beginPath();
  context.roundRect(0, 0, width, 46, 12);
  context.fill();
  context.fillStyle = "#ffffff";
  context.textBaseline = "middle";
  context.fillText(text, 14, 24);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, sizeAttenuation: false, transparent: true }));
  sprite.renderOrder = 12;
  return { sprite, aspect: width / 46 };
}

function dispose(root: THREE.Object3D) {
  root.traverse((child) => {
    const item = child as THREE.Mesh;
    item.geometry?.dispose();
    for (const material of Array.isArray(item.material) ? item.material : item.material ? [item.material] : []) {
      (material as THREE.SpriteMaterial).map?.dispose();
      material.dispose();
    }
  });
}
