// Drawing with a pen: Apple Pencil, Android styluses, Surface and Wacom pens.
// Shared by the whiteboard and the image annotator.
//
// - Pen-only drawing: once a pen has drawn on a device, fingers move and zoom
//   instead of drawing, so a hand resting on the screen leaves no marks (can be
//   switched off; remembered per device).
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
