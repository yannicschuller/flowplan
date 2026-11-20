import { z } from "zod";

// "Whiteboard-Fläche" (#399, Settings → Appearance & language and the
// board's "… → Ansicht und Aktionen"): whether the board's canvas follows
// the colour scheme – dark in dark mode, the default – or always stays
// light. Display only: the boards' colours are stored unchanged
// (lib/whiteboard-display-colors.ts), everyone sees their own choice and
// the exports stay light. Stored per person on the server
// (users.whiteboard_canvas: NULL = the default – "theme" –, or "light"),
// delivered with the bootstrap.
export const WHITEBOARD_CANVAS_PREFS = ["theme", "light"] as const;
export type WhiteboardCanvasPref = (typeof WHITEBOARD_CANVAS_PREFS)[number];
export const DEFAULT_WHITEBOARD_CANVAS: WhiteboardCanvasPref = "theme";
export const whiteboardCanvasSchema = z.enum(WHITEBOARD_CANVAS_PREFS);

// What a stored value means: only an explicit "light" keeps the canvas light.
export function whiteboardCanvasOf(value: unknown): WhiteboardCanvasPref {
  return value === "light" ? "light" : DEFAULT_WHITEBOARD_CANVAS;
}

// Whether the canvas is shown dark: in dark mode, unless kept light.
export function showsDarkCanvas(pref: WhiteboardCanvasPref, darkTheme: boolean): boolean {
  return darkTheme && pref !== "light";
}
