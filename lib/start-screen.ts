import { z } from "zod";

// "Beim Öffnen auf dem Handy" (Settings → Appearance & language → Start):
// what a phone shows when Flowplan is opened fresh.
//   home    – the app as always (the start page or the last workspace).
//   capture – the quick capture (components/start-capture.tsx) first:
//             the title field focused, the target as in the capture
//             (the default capture database), "Noch eins" and "Zur App"
//             after saving. The workspace loads only once it is needed.
// Stored per person on the server (users.start_screen: NULL = home),
// delivered with the bootstrap. Only phones follow it, only on a cold load
// of the bare address: a deep link (#page=…, a notification, a quick
// action, the share target), tablets and computers always open the app.
export const START_SCREENS = ["home", "capture"] as const;
export type StartScreen = (typeof START_SCREENS)[number];
export const DEFAULT_START_SCREEN: StartScreen = "home";
export const startScreenSchema = z.enum(START_SCREENS);

// What a stored value means: anything unknown is the default.
export function startScreenOf(value: unknown): StartScreen {
  return value === "capture" ? "capture" : DEFAULT_START_SCREEN;
}

// The server's first guess from the request: a phone's browser or app.
// iPads ask as a Mac and Android tablets leave out "Mobile", so tablets
// never match; Chromium's client hint Sec-CH-UA-Mobile ("?1") counts too.
export function phoneUserAgent(userAgent: string | null | undefined, chMobile?: string | null): boolean {
  if (chMobile === "?1") return true;
  const ua = userAgent || "";
  if (/\biP(hone|od)\b/.test(ua)) return true;
  return /\bAndroid\b/i.test(ua) && /\bMobile\b/.test(ua);
}

// Phones: the shorter side of the screen in CSS pixels. The smallest iPad
// (mini) has 744, large phones about 440.
export const PHONE_SHORT_SIDE = 600;

export type StartContext = {
  setting: StartScreen;
  // location.pathname, location.search and location.hash on load.
  pathname: string;
  search: string;
  hash: string;
  // The shorter side of the screen in CSS pixels.
  shortSide: number;
  // performance.getEntriesByType("navigation")[0].type: "navigate",
  // "reload", "back_forward" or "prerender".
  navigation?: string;
};

// What opens: the quick capture or the app. The capture only for the bare
// address ("/" without a fragment or parameters – any deep link, the share
// target's hand-over and invitations carry one), on a phone, on a fresh
// load (not when going back to the page from elsewhere).
export function startDecision(context: StartContext): "capture" | "app" {
  if (context.setting !== "capture") return "app";
  if (context.pathname !== "/") return "app";
  if (context.search && context.search !== "?") return "app";
  if (context.hash && context.hash !== "#") return "app";
  if (context.navigation === "back_forward") return "app";
  if (!(context.shortSide > 0 && context.shortSide < PHONE_SHORT_SIDE)) return "app";
  return "capture";
}
