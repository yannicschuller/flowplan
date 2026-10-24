// Drawing with a pen: Apple Pencil, Android styluses, Surface and Wacom pens.
// Shared by the whiteboard and the image annotator.
//
// - Pen-only drawing: once a pen has drawn on a device, fingers move and zoom
//   instead of drawing, so a hand resting on the screen leaves no marks (can be
//   switched off; remembered per device).
// - Palm rejection: a touch while the pen draws, hovers or was lifted a
//   moment ago is the hand holding it – it never draws, also with pen-only
//   drawing switched off.
// - Pressure sets the stroke width; readings of 0 (the first contact) and
//   jitter are evened out (pushPressure).
// - Scribble (handwriting into text fields) runs past a field's edges: the
//   pen next to the focused field writes, it does not draw (writingInField).
// - The eraser end or button of a pen erases.
// - Fast strokes keep every point the device measured (coalesced events).
// - Apple Pencil double-tap and squeeze reach the page from the iPad app
//   (flowplan-app) as "flowplan:pencil" events with the action set in the
//   system settings.
import type { PointerEvent as ReactPointerEvent } from "react";

const PEN_ONLY = "flowplan-pen-only";

// "on", "off" or "auto" (not decided yet: switches on with the first pen).
export function penOnlySetting(): "on" | "off" | "auto" {
  try {
    const value = localStorage.getItem(PEN_ONLY);
    return value === "1" ? "on" : value === "0" ? "off" : "auto";
  } catch {
    return "auto";
  }
}
export function setPenOnly(on: boolean) {
  try {
    localStorage.setItem(PEN_ONLY, on ? "1" : "0");
  } catch {}
}
// A pen touched the screen: from now on fingers navigate, unless switched off.
export function notePen(event: { pointerType: string }) {
  if (event.pointerType !== "pen" || penOnlySetting() !== "auto") return false;
  setPenOnly(true);
  return true;
}
// Should this pointer draw, when pen-only drawing is on?
export const drawsWith = (event: { pointerType: string }, penOnly: boolean) => !penOnly || event.pointerType !== "touch";

// The eraser end of a pen (or its eraser button): buttons bit 32 / button 5.
export const isEraser = (event: { pointerType: string; buttons: number; button: number }) =>
  event.pointerType === "pen" && ((event.buttons & 32) !== 0 || event.button === 5);

// A pen hovering above the screen (Apple Pencil hover, pens with hover).
export const isHovering = (event: { pointerType: string; buttons: number }) => event.pointerType === "pen" && event.buttons === 0;

export type StylusSample = { clientX: number; clientY: number; pressure: number };
// Every point since the last event, oldest first.
export function samples(event: ReactPointerEvent | PointerEvent): StylusSample[] {
  const native = ("nativeEvent" in event ? event.nativeEvent : event) as PointerEvent;
  const list = typeof native.getCoalescedEvents === "function" ? native.getCoalescedEvents() : [];
  return (list.length ? list : [native]).map((e) => ({ clientX: e.clientX, clientY: e.clientY, pressure: e.pressure }));
}

// What the Apple Pencil's double-tap or squeeze should do (Settings → Apple
// Pencil on the iPad).
export type PencilAction = {
  gesture: "tap" | "squeeze";
  preferred: "switchEraser" | "switchPrevious" | "showColorPalette" | "showInkAttributes" | "showContextualPalette" | "ignore";
};
export const PENCIL_EVENT = "flowplan:pencil";
export function onPencilAction(listener: (action: PencilAction) => void) {
  const handle = (event: Event) => {
    const detail = (event as CustomEvent<PencilAction>).detail;
    if (detail && (detail.gesture === "tap" || detail.gesture === "squeeze")) listener(detail);
  };
  window.addEventListener(PENCIL_EVENT, handle);
  return () => window.removeEventListener(PENCIL_EVENT, handle);
}

// ---- Palm rejection ----

// How long after the pen was last seen (drawing, hovering, lifting) a touch
// still counts as the palm.
export const PALM_MS = 600;
let lastPen = Number.NEGATIVE_INFINITY;
export function notePenActivity(event: { pointerType: string }, now = Date.now()) {
  if (event.pointerType === "pen") lastPen = now;
}
// A finger on the screen while the pen is near: the hand holding it.
export const palmLikely = (event: { pointerType: string }, now = Date.now()) => event.pointerType === "touch" && now - lastPen < PALM_MS;
// Changing the setting starts over (the next finger is meant).
export function forgetPen() {
  lastPen = Number.NEGATIVE_INFINITY;
}

// ---- Pressure ----

// The pressures of a stroke, one per point (0–1, two decimals; 0.5 for pens
// without pressure). A pen often reports 0 at first contact and now and then
// in between: those points take the last value, and the first real reading
// fills in the points before it. Changes are smoothed a little, so the
// outline does not wobble with the sensor's noise.
export type PressureTrack = { pressures: number[]; measured?: boolean };
const UNKNOWN_PRESSURE = 0.5;
const MIN_PRESSURE = 0.05;
// The share of a new reading in the next value.
const PRESSURE_SMOOTHING = 0.6;
const round2 = (n: number) => Math.round(n * 100) / 100;
export function pushPressure(track: PressureTrack, raw: number) {
  const list = track.pressures;
  const value = Number.isFinite(raw) && raw > 0 ? Math.min(1, Math.max(MIN_PRESSURE, raw)) : null;
  if (value === null) {
    list.push(list.length ? list[list.length - 1] : UNKNOWN_PRESSURE);
    return;
  }
  if (!track.measured) {
    track.measured = true;
    list.fill(round2(value));
    list.push(round2(value));
    return;
  }
  const last = list[list.length - 1];
  list.push(round2(last + (value - last) * PRESSURE_SMOOTHING));
}

// ---- Scribble ----

// How far handwriting may run past the edges of the field it goes into.
export const SCRIBBLE_MARGIN = 40;
type Box = { left: number; top: number; right: number; bottom: number };
export const nearBox = (x: number, y: number, box: Box | null | undefined, margin = SCRIBBLE_MARGIN) =>
  !!box && x >= box.left - margin && x <= box.right + margin && y >= box.top - margin && y <= box.bottom + margin;
// A pen coming down next to the focused text field is writing into it
// (Scribble on the iPad): the board leaves it alone, and the field stays
// open should the browser take the focus away for it (stillWriting).
let lastWriting = Number.NEGATIVE_INFINITY;
export function writingInField(event: { pointerType: string; clientX: number; clientY: number }, now = Date.now()) {
  if (event.pointerType !== "pen" || typeof document === "undefined") return false;
  const field = document.activeElement as HTMLElement | null;
  if (!field?.matches?.("input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=button]), textarea, [contenteditable=''], [contenteditable='true']"))
    return false;
  if (!nearBox(event.clientX, event.clientY, field.getBoundingClientRect())) return false;
  lastWriting = now;
  return true;
}
// A field losing the focus right after such a pen: it keeps it.
export const stillWriting = (now = Date.now()) => now - lastWriting < 400;
