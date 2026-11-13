import { z } from "zod";

// "Animationen" (#260, Settings → Appearance & language): how much the
// interface moves, independent of the system's "reduce motion".
//   normal  – the standard (app/globals.css, "Motion"): menus and dialogs
//             fade and scale from 98 %, side panels and sheets slide in.
//   reduced – only short opacity fades: nothing scales or slides.
//   off     – nothing animates (as with the system's "reduce motion").
// Toggles, drag and drop and side panels work the same in every mode.
// Stored per person on the server (users.motion: NULL = the default), so
// it follows the person to every device; applied as data-motion on <html>
// and on the app's root (first paint) – see lib/motion-pref-client.ts.
export const MOTION_PREFS = ["normal", "reduced", "off"] as const;
export type MotionPref = (typeof MOTION_PREFS)[number];
export const DEFAULT_MOTION: MotionPref = "normal";
export const motionPrefSchema = z.enum(MOTION_PREFS);

// What a stored value means: anything unknown is the default.
export function motionPrefOf(value: unknown): MotionPref {
  return value === "reduced" || value === "off" ? value : DEFAULT_MOTION;
}

// The motion that applies: the person's choice, never more than the
// system allows (its "reduce motion" turns everything off).
export function effectiveMotion(pref: MotionPref, systemReduce: boolean): MotionPref {
  return systemReduce ? "off" : pref;
}

// The attribute value on <html> and the app's root: none for the default.
export function motionAttribute(pref: MotionPref): string | undefined {
  return pref === DEFAULT_MOTION ? undefined : pref;
}
