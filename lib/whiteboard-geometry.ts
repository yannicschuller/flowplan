// Geometry of whiteboard items, free of React: used by the board
// (components/whiteboard/render.tsx) and by the server (lib/whiteboard-svg.ts).
import { connectorPoint, type Point, type ShapeKind, type WhiteboardItem } from "./whiteboard-model";

// Outline of a shape in a w×h box, as an SVG path.
export function shapePath(kind: ShapeKind = "rectangle", w: number, h: number) {
  switch (kind) {
    case "ellipse":
      return `M ${w / 2} 0 A ${w / 2} ${h / 2} 0 1 1 ${w / 2 - 0.01} 0 Z`;
    case "triangle":
      return `M ${w / 2} 0 L ${w} ${h} L 0 ${h} Z`;
    case "diamond":
      return `M ${w / 2} 0 L ${w} ${h / 2} L ${w / 2} ${h} L 0 ${h / 2} Z`;
    case "hexagon":
      return `M ${w * 0.25} 0 L ${w * 0.75} 0 L ${w} ${h / 2} L ${w * 0.75} ${h} L ${w * 0.25} ${h} L 0 ${h / 2} Z`;
    case "parallelogram":
      return `M ${w * 0.2} 0 L ${w} 0 L ${w * 0.8} ${h} L 0 ${h} Z`;
    case "arrow":
      return `M 0 ${h * 0.3} L ${w * 0.6} ${h * 0.3} L ${w * 0.6} 0 L ${w} ${h / 2} L ${w * 0.6} ${h} L ${w * 0.6} ${h * 0.7} L 0 ${h * 0.7} Z`;
    case "star": {
      const points: string[] = [];
      for (let i = 0; i < 10; i++) {
        const angle = -Math.PI / 2 + (i * Math.PI) / 5,
          r = i % 2 ? 0.4 : 1;
        points.push(
          `${w / 2 + (Math.cos(angle) * r * w) / 2} ${h / 2 + (Math.sin(angle) * r * h) / 2}`,
        );
      }
      return `M ${points.join(" L ")} Z`;
    }
    case "cloud":
      return `M ${w * 0.25} ${h * 0.8} C ${w * 0.02} ${h * 0.8} ${w * 0.02} ${h * 0.45} ${w * 0.22} ${h * 0.45} C ${w * 0.2} ${h * 0.12} ${w * 0.55} ${h * 0.05} ${w * 0.62} ${h * 0.3} C ${w * 0.8} ${h * 0.15} ${w * 0.98} ${h * 0.35} ${w * 0.88} ${h * 0.52} C ${w * 1.02} ${h * 0.62} ${w * 0.92} ${h * 0.85} ${w * 0.75} ${h * 0.8} Z`;
    case "rounded": {
      const r = Math.min(16, w / 4, h / 4);
      return `M ${r} 0 H ${w - r} Q ${w} 0 ${w} ${r} V ${h - r} Q ${w} ${h} ${w - r} ${h} H ${r} Q 0 ${h} 0 ${h - r} V ${r} Q 0 0 ${r} 0 Z`;
    }
    default:
      return `M 0 0 H ${w} V ${h} H 0 Z`;
  }
}
// Route of a connector between its two ends.
export function connectorGeometry(
  item: WhiteboardItem,
  items: Map<string, WhiteboardItem>,
) {
  const rawA = connectorPoint(item.from, items),
    rawB = connectorPoint(item.to, items);
  const a = connectorPoint(item.from, items, rawB),
    b = connectorPoint(item.to, items, rawA);
  let d: string;
  let endDir: Point, startDir: Point;
  if (item.route === "elbow") {
    const mx = (a.x + b.x) / 2;
    d = `M ${a.x} ${a.y} H ${mx} V ${b.y} H ${b.x}`;
    endDir = { x: Math.sign(b.x - mx) || 1, y: 0 };
    startDir = { x: Math.sign(a.x - mx) || -1, y: 0 };
  } else if (item.route === "curved") {
    const dx = (b.x - a.x) / 2;
    d = `M ${a.x} ${a.y} C ${a.x + dx} ${a.y} ${b.x - dx} ${b.y} ${b.x} ${b.y}`;
    endDir = { x: Math.sign(b.x - a.x) || 1, y: 0 };
    startDir = { x: -(Math.sign(b.x - a.x) || 1), y: 0 };
  } else {
    d = `M ${a.x} ${a.y} L ${b.x} ${b.y}`;
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    endDir = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
    startDir = { x: -endDir.x, y: -endDir.y };
  }
  return { a, b, d, endDir, startDir };
}
export function contentBounds(
  items: WhiteboardItem[],
  map: Map<string, WhiteboardItem>,
) {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const item of items) {
    let box = { x: item.x, y: item.y, w: item.w, h: item.h };
    if (item.type === "connector") {
      const { a, b } = connectorGeometry(item, map);
      box = {
        x: Math.min(a.x, b.x),
        y: Math.min(a.y, b.y),
        w: Math.abs(a.x - b.x),
        h: Math.abs(a.y - b.y),
      };
    }
    if (item.type === "frame") box = { ...box, y: box.y - 30, h: box.h + 30 };
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.w);
    maxY = Math.max(maxY, box.y + box.h);
  }
  return Number.isFinite(minX)
    ? { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
    : null;
}
