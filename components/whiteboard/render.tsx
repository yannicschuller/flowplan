"use client";
import type { CSSProperties, ReactNode } from "react";
import {
  connectorPoint,
  safeImageSource,
  type Point,
  type ShapeKind,
  type WhiteboardItem,
} from "@/lib/whiteboard-model";

export type PageRef = {
  id: string;
  title: string;
  icon?: string;
  kind?: string;
};

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
function arrowHead(at: Point, dir: Point, size: number, color: string) {
  const len = Math.hypot(dir.x, dir.y) || 1,
    ux = dir.x / len,
    uy = dir.y / len;
  const back = { x: at.x - ux * size, y: at.y - uy * size };
  const left = { x: back.x - uy * size * 0.55, y: back.y + ux * size * 0.55 },
    right = { x: back.x + uy * size * 0.55, y: back.y - ux * size * 0.55 };
  return (
    <path
      d={`M ${at.x} ${at.y} L ${left.x} ${left.y} L ${right.x} ${right.y} Z`}
      fill={color}
    />
  );
}
function TextBox({
  item,
  padding = 10,
  style,
  children,
}: {
  item: WhiteboardItem;
  padding?: number;
  style?: CSSProperties;
  children?: ReactNode;
}) {
  return (
    <foreignObject
      x={0}
      y={0}
      width={Math.max(1, item.w)}
      height={Math.max(1, item.h)}
    >
      <div
        className="wb-text"
        style={{
          padding,
          fontSize: item.fontSize || 16,
          fontWeight: item.bold ? 700 : 400,
          textAlign: item.align || "center",
          color: item.textColor || "#1f2937",
          justifyContent: item.type === "text" ? "flex-start" : "center",
          ...style,
        }}
      >
        {children ?? item.text}
      </div>
    </foreignObject>
  );
}
export function WhiteboardShape({
  item,
  items,
  pages,
  editing,
}: {
  item: WhiteboardItem;
  items: Map<string, WhiteboardItem>;
  pages: PageRef[];
  editing?: ReactNode;
}) {
  const transform = `translate(${item.x} ${item.y})${item.rotation ? ` rotate(${item.rotation} ${item.w / 2} ${item.h / 2})` : ""}`;
  const text = editing ?? undefined;
  switch (item.type) {
    case "sticky":
      return (
        <g transform={transform}>
          <rect
            width={item.w}
            height={item.h}
            rx={4}
            fill={item.fill || "#fff6b6"}
            filter="url(#wb-shadow)"
          />
          <TextBox item={item}>{text}</TextBox>
        </g>
      );
    case "text":
      return (
        <g transform={transform}>
          <rect width={item.w} height={item.h} fill="transparent" />
          <TextBox
            item={item}
            padding={2}
            style={{ textAlign: item.align || "left" }}
          >
            {text}
          </TextBox>
        </g>
      );
    case "shape":
      return (
        <g transform={transform}>
          <path
            d={shapePath(item.shape, item.w, item.h)}
            fill={item.fill || "#ffffff"}
            stroke={item.stroke || "#1f2937"}
            strokeWidth={item.strokeWidth ?? 2}
            strokeDasharray={item.dashed ? "8 6" : undefined}
            vectorEffect="non-scaling-stroke"
          />
          <TextBox item={item}>{text}</TextBox>
        </g>
      );
    case "frame":
      return (
        <g transform={`translate(${item.x} ${item.y})`}>
          <rect
            width={item.w}
            height={item.h}
            fill={
              item.fill && item.fill !== "transparent" ? item.fill : "#ffffff"
            }
            stroke="#ced4da"
            strokeWidth={1}
            rx={6}
          />
          <foreignObject x={0} y={-28} width={Math.max(1, item.w)} height={26}>
            <div className="wb-frame-title">
              {text ?? (item.text || "Rahmen")}
            </div>
          </foreignObject>
        </g>
      );
    case "pen": {
      const pts = item.points || [];
      let d = "";
      for (let i = 0; i + 1 < pts.length; i += 2)
        d += `${i ? " L" : "M"} ${item.x + pts[i] * item.w} ${item.y + pts[i + 1] * item.h}`;
      return (
        <path
          d={d}
          fill="none"
          stroke={item.stroke || "#1f2937"}
          strokeWidth={item.strokeWidth ?? 3}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      );
    }
    case "connector": {
      const { a, b, d, endDir, startDir } = connectorGeometry(item, items);
      const color = item.stroke || "#1f2937",
        width = item.strokeWidth ?? 2;
      return (
        <g>
          <path
            d={d}
            fill="none"
            stroke="transparent"
            strokeWidth={Math.max(12, width + 10)}
          />
          <path
            d={d}
            fill="none"
            stroke={color}
            strokeWidth={width}
            strokeDasharray={item.dashed ? "8 6" : undefined}
            strokeLinecap="round"
          />
          {item.endArrow !== false &&
            arrowHead(b, endDir, 8 + width * 2, color)}
          {item.startArrow && arrowHead(a, startDir, 8 + width * 2, color)}
          {item.text && (
            <foreignObject
              x={(a.x + b.x) / 2 - 80}
              y={(a.y + b.y) / 2 - 14}
              width={160}
              height={28}
            >
              <div className="wb-connector-label">{item.text}</div>
            </foreignObject>
          )}
        </g>
      );
    }
    case "image":
      return (
        <g transform={transform}>
          {safeImageSource(item.src) ? (
            <image
              href={item.src}
              width={item.w}
              height={item.h}
              preserveAspectRatio="xMidYMid meet"
            />
          ) : (
            <rect width={item.w} height={item.h} fill="#f1f3f5" />
          )}
        </g>
      );
    case "card": {
      const page = pages.find((p) => p.id === item.pageId);
      return (
        <g transform={transform}>
          <rect
            width={item.w}
            height={item.h}
            rx={10}
            fill="#ffffff"
            stroke="#dee2e6"
            filter="url(#wb-shadow)"
          />
          <rect
            width={6}
            height={item.h}
            rx={3}
            fill={item.fill || "#3b3fd8"}
          />
          <foreignObject
            x={14}
            y={0}
            width={Math.max(1, item.w - 20)}
            height={item.h}
          >
            <div className="wb-card-body">
              <small>
                {page?.kind === "database"
                  ? "Datenbank"
                  : page?.kind === "whiteboard"
                    ? "Whiteboard"
                    : "Seite"}
              </small>
              <strong>{page?.title || "Seite nicht verfügbar"}</strong>
            </div>
          </foreignObject>
        </g>
      );
    }
    case "comment": {
      const count = item.messages?.length || 0;
      return (
        <g
          transform={`translate(${item.x} ${item.y})`}
          opacity={item.resolved ? 0.45 : 1}
        >
          <path
            d="M 16 0 C 25 0 32 7 32 16 C 32 25 25 32 16 32 L 2 32 L 2 16 C 2 7 7 0 16 0 Z"
            fill={item.resolved ? "#adb5bd" : "#f08c00"}
            stroke="#ffffff"
            strokeWidth={2}
            filter="url(#wb-shadow)"
          />
          <text
            x={17}
            y={21}
            textAnchor="middle"
            fontSize={13}
            fontWeight={700}
            fill="#ffffff"
          >
            {count || "+"}
          </text>
        </g>
      );
    }
    case "table": {
      const cells = item.cells?.length ? item.cells : [[""]];
      const cols = Math.max(1, ...cells.map((r) => r.length));
      return (
        <g transform={transform}>
          <rect
            width={item.w}
            height={item.h}
            fill="#ffffff"
            stroke="#adb5bd"
            rx={4}
          />
          <foreignObject
            width={Math.max(1, item.w)}
            height={Math.max(1, item.h)}
          >
            <div
              className="wb-table-grid"
              style={{
                gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
                gridTemplateRows: `repeat(${cells.length}, minmax(0, 1fr))`,
                fontSize: item.fontSize || 14,
              }}
            >
              {cells.flatMap((row, r) =>
                Array.from({ length: cols }, (_, c) => (
                  <div
                    key={`${r}:${c}`}
                    className={`wb-cell${r === 0 && item.header !== false ? " head" : ""}`}
                    data-cell={`${r}:${c}`}
                  >
                    {row[c] || ""}
                  </div>
                )),
              )}
            </div>
          </foreignObject>
        </g>
      );
    }
    case "emoji":
      return (
        <g transform={transform}>
          <foreignObject
            width={Math.max(1, item.w)}
            height={Math.max(1, item.h)}
          >
            <div
              className="wb-emoji-glyph"
              style={{ fontSize: Math.min(item.w, item.h) * 0.8 }}
            >
              {item.emoji}
            </div>
          </foreignObject>
        </g>
      );
  }
}
// Shared definitions (shadow) for every rendering of a board.
export function WhiteboardDefs() {
  return (
    <defs>
      <filter id="wb-shadow" x="-10%" y="-10%" width="130%" height="140%">
        <feDropShadow dx="0" dy="2" stdDeviation="2.5" floodOpacity="0.16" />
      </filter>
      <pattern
        id="wb-grid"
        width="24"
        height="24"
        patternUnits="userSpaceOnUse"
      >
        <circle cx="1" cy="1" r="1" fill="#ced4da" />
      </pattern>
    </defs>
  );
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
// Static board, e.g. embedded in a document.
export function WhiteboardStatic({
  items,
  pages,
  height = 320,
}: {
  items: WhiteboardItem[];
  pages: PageRef[];
  height?: number;
}) {
  const map = new Map(items.map((i) => [i.id, i]));
  const box = contentBounds(items, map);
  const pad = 40;
  const view = box
    ? `${box.x - pad} ${box.y - pad} ${box.w + pad * 2} ${box.h + pad * 2}`
    : "0 0 800 400";
  return (
    <svg
      className="wb-static"
      viewBox={view}
      style={{ height }}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="Whiteboard-Vorschau"
    >
      <WhiteboardDefs />
      {items
        .filter((i) => i.type === "frame")
        .map((item) => (
          <g key={item.id} className={`wb-${item.type}`}>
            <WhiteboardShape item={item} items={map} pages={pages} />
          </g>
        ))}
      {items
        .filter((i) => i.type !== "frame")
        .map((item) => (
          <g key={item.id} className={`wb-${item.type}`}>
            <WhiteboardShape item={item} items={map} pages={pages} />
          </g>
        ))}
    </svg>
  );
}
