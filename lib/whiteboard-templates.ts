import type { WhiteboardItem } from "./whiteboard-model";

// Ready-made boards. Positions are relative to the insertion point; local
// ids ("a", "b", …) connect connectors to items and are replaced on insert.
type Draft = Omit<WhiteboardItem, "z"> & { z?: number };
export const whiteboardTemplates = {
  retro: "Retrospektive",
  kanban: "Kanban",
  mindmap: "Mindmap",
  swot: "SWOT-Analyse",
  flow: "Flussdiagramm",
} as const;
export type WhiteboardTemplate = keyof typeof whiteboardTemplates;
const frame = (
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
  text: string,
  fill = "#ffffff",
): Draft => ({
  id,
  type: "frame",
  x,
  y,
  w,
  h,
  text,
  fill,
});
const note = (
  id: string,
  x: number,
  y: number,
  text: string,
  fill = "#fff6b6",
): Draft => ({
  id,
  type: "sticky",
  x,
  y,
  w: 180,
  h: 180,
  text,
  fill,
  fontSize: 16,
});
const shape = (
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
  text: string,
  kind: WhiteboardItem["shape"],
  fill = "#ffffff",
): Draft => ({
  id,
  type: "shape",
  shape: kind,
  x,
  y,
  w,
  h,
  text,
  fill,
  stroke: "#1f2937",
  strokeWidth: 2,
  fontSize: 16,
});
const link = (
  id: string,
  from: string,
  to: string,
  route: WhiteboardItem["route"] = "straight",
): Draft => ({
  id,
  type: "connector",
  x: 0,
  y: 0,
  w: 0,
  h: 0,
  from: { id: from, x: 0, y: 0 },
  to: { id: to, x: 0, y: 0 },
  stroke: "#1f2937",
  strokeWidth: 2,
  endArrow: true,
  route,
});
export function templateItems(kind: WhiteboardTemplate): Draft[] {
  switch (kind) {
    case "retro":
      return [
        frame("f1", 0, 0, 420, 620, "Was lief gut?", "#ebfbee"),
        frame("f2", 460, 0, 420, 620, "Was können wir verbessern?", "#fff4e6"),
        frame("f3", 920, 0, 420, 620, "Maßnahmen", "#e7f5ff"),
        note("n1", 30, 40, "", "#b2f2bb"),
        note("n2", 490, 40, "", "#ffd8a8"),
        note("n3", 950, 40, "", "#a5d8ff"),
      ];
    case "kanban":
      return [
        frame("f1", 0, 0, 360, 700, "Offen"),
        frame("f2", 400, 0, 360, 700, "In Arbeit"),
        frame("f3", 800, 0, 360, 700, "Erledigt"),
        note("n1", 90, 40, "Aufgabe"),
        note("n2", 490, 40, "Aufgabe", "#a5d8ff"),
        note("n3", 890, 40, "Aufgabe", "#b2f2bb"),
      ];
    case "mindmap":
      return [
        shape("c", 0, 0, 220, 110, "Zentrales Thema", "ellipse", "#e5dbff"),
        shape("a", -380, -220, 180, 80, "Idee", "rounded", "#dbe4ff"),
        shape("b", 420, -220, 180, 80, "Idee", "rounded", "#d3f9d8"),
        shape("d", -380, 250, 180, 80, "Idee", "rounded", "#fff3bf"),
        shape("e", 420, 250, 180, 80, "Idee", "rounded", "#ffe3e3"),
        link("l1", "c", "a", "curved"),
        link("l2", "c", "b", "curved"),
        link("l3", "c", "d", "curved"),
        link("l4", "c", "e", "curved"),
      ];
    case "swot":
      return [
        frame("s", 0, 0, 440, 360, "Stärken", "#ebfbee"),
        frame("w", 480, 0, 440, 360, "Schwächen", "#fff5f5"),
        frame("o", 0, 420, 440, 360, "Chancen", "#e7f5ff"),
        frame("t", 480, 420, 440, 360, "Risiken", "#fff9db"),
      ];
    case "flow":
      return [
        shape("s", 0, 0, 180, 80, "Start", "ellipse", "#d3f9d8"),
        shape("p", 0, 160, 180, 90, "Schritt", "rectangle"),
        shape("d", -10, 330, 200, 130, "Entscheidung?", "diamond", "#fff3bf"),
        shape("y", 300, 350, 180, 90, "Ja-Weg", "rectangle"),
        shape("e", 0, 540, 180, 80, "Ende", "ellipse", "#ffe3e3"),
        link("l1", "s", "p"),
        link("l2", "p", "d"),
        link("l3", "d", "y", "elbow"),
        link("l4", "d", "e"),
      ];
  }
}
