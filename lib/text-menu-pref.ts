import { z } from "zod";

// "Menü bei Textauswahl" (#200, Settings → Appearance › Editor): whether
// selecting text shows Flowplan's text menu above the selection.
//   always   – on every selection (the behaviour before #200)
//   computer – only for a selection made with a mouse, trackpad or keyboard
//              (the default)
//   never    – never on selecting; a right click still opens it
// Stored per person on the server (users.text_menu, NULL = the default), so
// the choice follows the person to every device.
export const TEXT_MENU_PREFS = ["always", "computer", "never"] as const;
export type TextMenuPref = (typeof TEXT_MENU_PREFS)[number];
export const DEFAULT_TEXT_MENU_PREF: TextMenuPref = "computer";
export const textMenuPrefSchema = z.enum(TEXT_MENU_PREFS);

// What a stored value means: anything unknown is the default.
export function textMenuPrefOf(value: unknown): TextMenuPref {
  return (TEXT_MENU_PREFS as readonly unknown[]).includes(value) ? (value as TextMenuPref) : DEFAULT_TEXT_MENU_PREF;
}

// The input a selection was made with.
export type SelectionInput = "mouse" | "keyboard" | "touch" | "pen";

// "Computer" or not is decided by the input of the selection, not by the
// device or the screen width: a selection made by touch (a finger on a phone
// or tablet, the iOS/Android app's web view) or with a pen is "not a
// computer" – the system's own selection menu and the toolbar docked on the
// keyboard handle it there. A selection made with a mouse or trackpad, or
// with Shift + arrow keys, is "a computer". So an iPad with a trackpad shows
// the menu when the trackpad selects and not when a finger does.
export function showsMenuOnSelection(pref: TextMenuPref, input: SelectionInput): boolean {
  if (pref === "always") return true;
  if (pref === "never") return false;
  return input === "mouse" || input === "keyboard";
}

// The input of the latest press: the PointerEvent's pointerType ("mouse",
// "touch", "pen"; "" or unknown when the browser does not say). Without a
// press yet (a selection made by the system, e.g. a long press that sent
// nothing to the page), a device whose primary pointer is coarse counts as
// touch.
export function pointerInput(pointerType: string | null | undefined, coarse: boolean): SelectionInput {
  if (pointerType === "mouse") return "mouse";
  if (pointerType === "touch") return "touch";
  if (pointerType === "pen") return "pen";
  return coarse ? "touch" : "mouse";
}
