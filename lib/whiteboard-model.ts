// Client-safe model of whiteboards. A board is a Yjs document with one map
// "items": id → Y.Map of the properties below. Every property is a plain
// JSON value, so moving, resizing and editing text of the same item by
// different people merge property by property.
export const whiteboardItemTypes = [
  "sticky",
  "text",
  "shape",
  "connector",
  "pen",
  "image",
  "frame",
  "card",
  "emoji",
  "comment",
  "table",
] as const;
export type WhiteboardItemType = (typeof whiteboardItemTypes)[number];
export const shapeKinds = [
  "rectangle",
  "rounded",
  "ellipse",
  "triangle",
  "diamond",
  "star",
  "hexagon",
  "parallelogram",
  "arrow",
  "cloud",
] as const;
export type ShapeKind = (typeof shapeKinds)[number];
export type Point = { x: number; y: number };
export type ConnectorEnd = { id?: string; x: number; y: number };
export type WhiteboardItem = {
  id: string;
  type: WhiteboardItemType;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  rotation?: number;
  text?: string;
  fontSize?: number;
  align?: "left" | "center" | "right";
  bold?: boolean;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  textColor?: string;
  shape?: ShapeKind;
  points?: number[];
  from?: ConnectorEnd;
  to?: ConnectorEnd;
  route?: "straight" | "elbow" | "curved";
  startArrow?: boolean;
  endArrow?: boolean;
  dashed?: boolean;
  src?: string;
  pageId?: string;
  emoji?: string;
  locked?: boolean;
  // Covered for everyone until someone uncovers it (workshops: collect
  // answers hidden, then reveal together). Its content is not rendered.
  covered?: boolean;
  author?: string;
  // Tables: cell texts by row; the first row can be a header.
  cells?: string[][];
  header?: boolean;
  // Comment pins: the thread, and whether it is done.
  messages?: WhiteboardMessage[];
  resolved?: boolean;
  // Votes by person (voting sessions).
  votes?: Record<string, boolean>;
};
export type WhiteboardMessage = {
  id: string;
  author: string;
  name: string;
  text: string;
  at: number;
};
// Board-wide state shared by everyone: voting session and timer.
export type WhiteboardMeta = {
  voting?: { active: boolean; max: number };
  timer?: { endsAt: number | null; remaining: number; duration: number };
};
export const stickyColors = [
  "#fff6b6",
  "#ffd8a8",
  "#ffc9c9",
  "#fcc2d7",
  "#d0bfff",
  "#bac8ff",
  "#a5d8ff",
  "#b2f2bb",
  "#d8f5a2",
  "#e9ecef",
];
export const strokeColors = [
  "#1f2937",
  "#e03131",
  "#f08c00",
  "#2f9e44",
  "#1971c2",
  "#7048e8",
  "#c2255c",
  "#868e96",
];
export const fillColors = [
  "transparent",
  "#ffffff",
  "#fff3bf",
  "#ffe8cc",
  "#ffe3e3",
  "#e5dbff",
  "#dbe4ff",
  "#d3f9d8",
  "#f1f3f5",
];
// Images on boards only come from the workspace or public HTTPS addresses.
export const safeImageSource = (src?: string) =>
  !!src &&
  (/^\/api\/files\/[\w-]+$/.test(src) ||
    /^\/api\/share\/[\w-]+\/files\/[\w-]+$/.test(src) ||
    /^https:\/\//i.test(src));
export function itemText(item: Partial<WhiteboardItem>) {
  return [
    item.text,
    item.emoji,
    ...(item.cells || []).flat(),
    ...(item.messages || []).map((m) => m.text),
  ]
    .filter(Boolean)
    .join(" ")
    .trim();
}
export const emptyTable = (rows = 3, cols = 3) =>
  Array.from({ length: rows }, () => Array.from({ length: cols }, () => ""));
// Bounding box of an item (connectors and pens span their points).
export function itemBounds(
  item: WhiteboardItem,
  items?: Map<string, WhiteboardItem>,
) {
  if (item.type === "connector") {
    const a = connectorPoint(item.from, items),
      b = connectorPoint(item.to, items);
    return {
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      w: Math.abs(a.x - b.x),
      h: Math.abs(a.y - b.y),
    };
  }
  return { x: item.x, y: item.y, w: item.w, h: item.h };
}
// Connector ends attached to an item follow its centre, clipped to its edge.
export function connectorPoint(
  end: ConnectorEnd | undefined,
  items?: Map<string, WhiteboardItem>,
  toward?: Point,
): Point {
  if (!end) return { x: 0, y: 0 };
  const target = end.id ? items?.get(end.id) : undefined;
  if (!target || target.type === "connector") return { x: end.x, y: end.y };
  const cx = target.x + target.w / 2,
    cy = target.y + target.h / 2;
  if (!toward) return { x: cx, y: cy };
  const dx = toward.x - cx,
    dy = toward.y - cy;
  if (!dx && !dy) return { x: cx, y: cy };
  const scale = Math.min(
    dx ? target.w / 2 / Math.abs(dx) : Infinity,
    dy ? target.h / 2 / Math.abs(dy) : Infinity,
  );
  return { x: cx + dx * scale, y: cy + dy * scale };
}
