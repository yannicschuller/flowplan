// Keyboard shortcut hints (⌘K badges, "(⌘ ⌥ E)" in titles, the keys in the
// quick search and the onboarding) only where someone can press them. A
// phone or tablet without a keyboard – in the browser or in the apps
// (lib/native-app.ts) – shows none; a touch screen gains them as soon as a
// trackpad or mouse is attached (any-pointer: fine) or a hardware keyboard
// gives itself away (a key with ⌘/Ctrl/Alt, Tab, Escape or an arrow, or a
// key command of the iPad app: lib/app-shortcuts.ts).
//
// One place decides: `<html data-keyboard-hints="on|off">` hides every kbd /
// .keycap / .kbd-hint outside the shortcut overview (app/globals.css; before
// the script runs the media query does the same), and useKeyboardHints()
// gives text hints for titles and sentences, written for this device's
// system (⌘ ⌥ ⇧ ⌃ on Apple devices, Ctrl/Alt/Shift elsewhere).
import { useSyncExternalStore } from "react";
import { formatCombo, isMacPlatform, shortcutHint, type ShortcutAction } from "./keymap";

export type HintEnvironment = {
  // (hover: none) and (pointer: coarse): the main input is a finger.
  touchOnly: boolean;
  // (any-pointer: fine): a mouse or trackpad is attached as well.
  finePointer: boolean;
  // Inside the iPhone/iPad/Android app (window.FlowplanApp or its user agent).
  mobileApp: boolean;
  // A hardware keyboard was used in this session.
  hardwareKeyboard: boolean;
};

// Pure, for the tests.
export function hintsVisible(env: HintEnvironment): boolean {
  if (env.hardwareKeyboard || env.finePointer) return true;
  if (env.mobileApp) return false;
  return !env.touchOnly;
}

// A key press that a software keyboard does not send.
export function fromHardwareKeyboard(e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey"> & { isComposing?: boolean }): boolean {
  if (e.isComposing || !e.key || e.key === "Unidentified" || e.key === "Process") return false;
  if (e.metaKey || e.ctrlKey || e.key === "Meta" || e.key === "Control") return true;
  if (e.altKey && e.key !== "Alt") return true;
  return /^(Tab|Escape|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|F\d{1,2})$/.test(e.key);
}

export type KeyboardHints = {
  visible: boolean;
  // ⌘ ⌥ ⇧ ⌃ instead of Ctrl, Alt, Shift.
  mac: boolean;
};

const SERVER: KeyboardHints = { visible: true, mac: false };
const STORE_KEY = "flowplan:hardware-keyboard";
let state: KeyboardHints = SERVER;
let installed = false;
let hardware = false;
const listeners = new Set<() => void>();

function mobileApp() {
  const w = window as unknown as { FlowplanApp?: unknown };
  return !!w.FlowplanApp || /FlowplanMobile\//.test(navigator.userAgent);
}
const media = (query: string) => typeof matchMedia === "function" && matchMedia(query).matches;

function compute() {
  const next: KeyboardHints = {
    visible: hintsVisible({
      touchOnly: media("(hover: none) and (pointer: coarse)"),
      finePointer: media("(any-pointer: fine)"),
      mobileApp: mobileApp(),
      hardwareKeyboard: hardware,
    }),
    mac: isMacPlatform(),
  };
  document.documentElement.dataset.keyboardHints = next.visible ? "on" : "off";
  if (next.visible !== state.visible || next.mac !== state.mac) {
    state = next;
    listeners.forEach((listener) => listener());
  }
}

// Remembers for this session that a hardware keyboard is there.
export function noteHardwareKeyboard() {
  if (hardware) return;
  hardware = true;
  try {
    sessionStorage.setItem(STORE_KEY, "1");
  } catch {}
  if (installed) compute();
}

export function installKeyboardHints() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  try {
    hardware = hardware || sessionStorage.getItem(STORE_KEY) === "1";
  } catch {}
  window.addEventListener(
    "keydown",
    (e) => {
      if (!hardware && fromHardwareKeyboard(e)) noteHardwareKeyboard();
    },
    { capture: true, passive: true },
  );
  for (const query of ["(hover: none) and (pointer: coarse)", "(any-pointer: fine)"])
    try {
      matchMedia(query).addEventListener("change", compute);
    } catch {}
  compute();
}

function subscribe(listener: () => void) {
  installKeyboardHints();
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
export function keyboardHints(): KeyboardHints {
  if (typeof window === "undefined") return SERVER;
  installKeyboardHints();
  return state;
}

// For components: whether to show hints and how to write them. `keys`
// formats a combination ("Mod+Alt+E" → "⌥ ⌘ E" / "Ctrl + Alt + E", "" when
// hidden); `suffix` the same in brackets for titles (" (⌘ Z)"); `action`
// the current combination of a global action.
export function useKeyboardHints() {
  const hints = useSyncExternalStore(subscribe, () => state, () => SERVER);
  const keys = (combo: string) => (hints.visible && combo ? formatCombo(combo, hints.mac) : "");
  const suffix = (combo: string) => {
    const text = keys(combo);
    return text ? ` (${text})` : "";
  };
  // The person's own combination of a global action (lib/keymap.ts).
  const action = (name: ShortcutAction) => (hints.visible ? shortcutHint(name, hints.mac) : "");
  return { ...hints, keys, suffix, action };
}
