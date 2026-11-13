import { z } from "zod";

// "Seiten in voller Breite anzeigen" (#257, Settings → Appearance &
// language → Editor): pages – and records opened as a page – use the whole
// width of the main area for this person, as if each had "Volle Breite".
// Only the person's view: the pages' own "Volle Breite" switch (the page
// menu) is stored unchanged and still applies for everyone else; while this
// setting is on, the page menu shows the switch as on and explains why.
// Stored per person on the server (users.full_width_pages: NULL = the
// default – off –, 0 = off, 1 = on), delivered with the bootstrap, so the
// first paint already has the width (no jump).
export const DEFAULT_FULL_WIDTH_PAGES = false;
export const fullWidthPagesSchema = z.boolean();

// What a stored value means: only an explicit "on" turns it on.
export function fullWidthPagesOf(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

// Whether a page shows at full width: its own switch or the person's setting.
export function showsFullWidth(pageFullWidth: unknown, personal: boolean): boolean {
  return personal || !!pageFullWidth;
}
