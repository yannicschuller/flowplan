// Ends of connectors: arrowheads for flowcharts and UML (open and closed
// triangles, diamonds, circles) and crow's-foot ends for ER diagrams. Drawn
// as SVG markup so the board (components/whiteboard/render.tsx) and the
// export (lib/whiteboard-svg.ts) show exactly the same.
import type { Point, WhiteboardItem } from "./whiteboard-model";
import { markerKinds, type MarkerKind } from "./whiteboard-diagram-model";

// The ends a connector shows. Boards from before the markers only know
// startArrow/endArrow; a marker counts while its arrow switch is on.
export function connectorEnds(item: Pick<WhiteboardItem, "startArrow" | "endArrow" | "startMarker" | "endMarker">): {
  start: MarkerKind;
  end: MarkerKind;
} {
  const valid = (m: unknown): m is MarkerKind => typeof m === "string" && (markerKinds as readonly string[]).includes(m);
  const end: MarkerKind = item.endArrow === false ? "none" : valid(item.endMarker) ? item.endMarker : "arrow";
  const start: MarkerKind =
    item.startArrow === false ? "none" : valid(item.startMarker) ? item.startMarker : item.startArrow ? "arrow" : "none";
  return { start, end };
}
// The properties that make a connector end show `kind`.
export function markerProps(side: "start" | "end", kind: MarkerKind): Partial<WhiteboardItem> {
  if (side === "end")
    return kind === "none" ? { endArrow: false, endMarker: undefined } : { endArrow: true, endMarker: kind === "arrow" ? undefined : kind };
  return kind === "none" ? { startArrow: false, startMarker: undefined } : { startArrow: true, startMarker: kind === "arrow" ? undefined : kind };
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const esc = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
// SVG markup of one end at `at`, the line arriving in direction `dir`.
export function markerSvg(kind: MarkerKind, at: Point, dir: Point, width: number, color: string, background = "#ffffff") {
  if (kind === "none") return "";
  const len = Math.hypot(dir.x, dir.y) || 1;
  const u = { x: dir.x / len, y: dir.y / len },
    n = { x: -u.y, y: u.x };
  const crow = ["one", "onlyOne", "zeroOrOne", "many", "oneOrMany", "zeroOrMany"].includes(kind);
  const s = crow ? 10 + width * 2 : 8 + width * 2;
  const p = (back: number, side = 0) => `${r2(at.x - u.x * back + n.x * side)} ${r2(at.y - u.y * back + n.y * side)}`;
  const c = esc(color),
    bg = esc(background);
  const sw = r2(Math.max(1, width));
  const path = (d: string, fill: string) =>
    `<path d="${d}" fill="${fill}" stroke="${fill === c ? "none" : c}" stroke-width="${sw}" stroke-linejoin="round" stroke-linecap="round"/>`;
  const line = (d: string) => `<path d="${d}" fill="none" stroke="${c}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/>`;
  const circle = (back: number, r: number, fill: string) => {
    const [x, y] = p(back).split(" ");
    return `<circle cx="${x}" cy="${y}" r="${r2(r)}" fill="${fill}" stroke="${c}" stroke-width="${sw}"/>`;
  };
  const bar = (back: number) => line(`M ${p(back, s * 0.6)} L ${p(back, -s * 0.6)}`);
  const foot = () => line(`M ${p(0, s * 0.6)} L ${p(s)} L ${p(0, -s * 0.6)} M ${p(0)} L ${p(s)}`);
  switch (kind) {
    case "arrow":
      return path(`M ${p(0)} L ${p(s, s * 0.55)} L ${p(s, -s * 0.55)} Z`, c);
    case "open":
      return line(`M ${p(s, s * 0.55)} L ${p(0)} L ${p(s, -s * 0.55)}`);
    case "triangle":
      return path(`M ${p(0)} L ${p(s * 1.2, s * 0.6)} L ${p(s * 1.2, -s * 0.6)} Z`, bg);
    case "diamond":
    case "filledDiamond":
      return path(`M ${p(0)} L ${p(s * 0.9, s * 0.45)} L ${p(s * 1.8)} L ${p(s * 0.9, -s * 0.45)} Z`, kind === "diamond" ? bg : c);
    case "circle":
      return circle(s * 0.45, s * 0.45, bg);
    case "dot":
      return circle(s * 0.4, s * 0.4, c);
    case "cross":
      return line(`M ${p(s * 0.2, s * 0.45)} L ${p(s * 1.1, -s * 0.45)} M ${p(s * 0.2, -s * 0.45)} L ${p(s * 1.1, s * 0.45)}`);
    case "one":
      return bar(s * 0.8);
    case "onlyOne":
      return bar(s * 0.6) + bar(s * 1.1);
    case "zeroOrOne":
      return bar(s * 0.6) + circle(s * 1.45, s * 0.38, bg);
    case "many":
      return foot();
    case "oneOrMany":
      return foot() + bar(s * 1.3);
    case "zeroOrMany":
      return foot() + circle(s * 1.55, s * 0.38, bg);
  }
}
