// Handwriting recognition on the device (the iPhone and iPad app,
// flowplan-app). Inside the app, `window.FlowplanApp.recognizeInk(request)`
// exists; elsewhere (browsers, the desktop app) there is no recognition and
// nothing here does anything.
//
// The contract:
//
//   window.FlowplanApp.recognizeInk({
//     id: string,
//     width: number, height: number,              // the sheet or block, in pt
//     strokes: [{ points: [[x, y], …] }, …],      // pen strokes only, pt, top left origin
//   })
//
// The app answers asynchronously with
//
//   window.dispatchEvent(new CustomEvent("flowplan:ink-recognized", {
//     detail: { id, text: string, lines: [{ text: string, box: [x, y, w, h] }] },
//   }))
//
// (boxes in the same pt coordinates). Used for search (the text is saved
// with the ink, lib/ink/recognized.ts) and for "Convert to text" on a lasso
// selection. Safe for the server: no DOM access at import time.
import { nativeApp } from "../native-app";
import type { PageSize } from "./coords";
import type { InkItem } from "./model";
import { cleanRecognizedText, RECOGNIZED_LIMITS } from "./recognized";

export const INK_RECOGNIZED_EVENT = "flowplan:ink-recognized";
export type InkRecognitionRequest = {
  id: string;
  width: number;
  height: number;
  strokes: { points: [number, number][] }[];
};
export type InkRecognitionLine = { text: string; box: [number, number, number, number] };
export type InkRecognitionResult = { id: string; text: string; lines: InkRecognitionLine[] };

export const recognitionAvailable = () => typeof nativeApp()?.recognizeInk === "function";

const r2 = (n: number) => Math.round(n * 100) / 100;
// The request for some ink: its pen strokes (highlighter and text are not
// handwriting to read). Null when there is no pen stroke.
export function recognitionRequest(id: string, size: PageSize, items: InkItem[]): InkRecognitionRequest | null {
  const strokes = items.flatMap((item) => {
    if (item.type !== "pen") return [];
    const points: [number, number][] = [];
    for (let i = 0; i + 2 < item.points.length; i += 3) points.push([r2(item.points[i]), r2(item.points[i + 1])]);
    return points.length ? [{ points }] : [];
  });
  if (!strokes.length) return null;
  return { id, width: r2(size.width), height: r2(size.height), strokes };
}

// The app's answer, checked: text only, boxes of four finite numbers.
export function parseRecognition(detail: unknown): InkRecognitionResult | null {
  if (!detail || typeof detail !== "object") return null;
  const value = detail as { id?: unknown; text?: unknown; lines?: unknown };
  if (typeof value.id !== "string" || !value.id) return null;
  const lines: InkRecognitionLine[] = [];
  if (Array.isArray(value.lines))
    for (const raw of value.lines.slice(0, 500)) {
      const line = raw as { text?: unknown; box?: unknown };
      const text = cleanRecognizedText(line?.text, RECOGNIZED_LIMITS.convert);
      const box = Array.isArray(line?.box) ? line.box.slice(0, 4) : [];
      if (!text || box.length !== 4 || !box.every((n) => typeof n === "number" && Number.isFinite(n))) continue;
      lines.push({ text, box: box.map(r2) as [number, number, number, number] });
    }
  const text = cleanRecognizedText(value.text, RECOGNIZED_LIMITS.convert) || lines.map((l) => l.text).join("\n");
  return { id: value.id, text, lines };
}

let counter = 0;
export const recognitionId = (purpose: string) => `${purpose}-${Date.now().toString(36)}-${(++counter).toString(36)}`;

// Asks the app; null without recognition, on failure or after `timeout` ms.
export function recognizeInk(request: InkRecognitionRequest, timeout = 20000): Promise<InkRecognitionResult | null> {
  const app = nativeApp();
  if (typeof window === "undefined" || typeof app?.recognizeInk !== "function") return Promise.resolve(null);
  return new Promise((resolve) => {
    const done = (result: InkRecognitionResult | null) => {
      window.removeEventListener(INK_RECOGNIZED_EVENT, listen);
      clearTimeout(timer);
      resolve(result);
    };
    const listen = (event: Event) => {
      const result = parseRecognition((event as CustomEvent).detail);
      if (result?.id === request.id) done(result);
    };
    const timer = setTimeout(() => done(null), timeout);
    window.addEventListener(INK_RECOGNIZED_EVENT, listen);
    try {
      app.recognizeInk!(request);
    } catch {
      done(null);
    }
  });
}

// Where converted text goes on the page: the top left of the strokes, in a
// size read from the recognised lines (or the strokes' height).
export function convertedTextPlacement(result: InkRecognitionResult, box: { x: number; y: number; w: number; h: number }) {
  const lineCount = Math.max(1, result.text.split("\n").length);
  const heights = result.lines.map((l) => l.box[3]).filter((h) => h > 0).sort((a, b) => a - b);
  const lineHeight = heights.length ? heights[Math.floor(heights.length / 2)] : box.h / lineCount;
  const size = Math.round(Math.min(48, Math.max(8, lineHeight * 0.75)) * 10) / 10;
  return { x: r2(box.x), y: r2(box.y), size };
}
