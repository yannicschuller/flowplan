import { z } from "zod";

// "Formatierungsleiste" (#235, Settings → Appearance & language → Editor):
// whether pages and records show the fixed formatting toolbar above the
// text. Hidden, the text menu over a selection (components/text-menu.tsx)
// offers the whole formatting set – as in focus mode – and the rare
// toolbar actions stay in its "…", the block menu and the slash menu. On a
// phone the row docked on the keyboard stays: there it is the keyboard's
// formatting row, not a toolbar over the page. Stored per person on the
// server (users.formatting_toolbar: NULL = the default), so the choice
// follows the person to every device.
export const FORMATTING_TOOLBAR_PREFS = ["show", "hide"] as const;
export type FormattingToolbarPref = (typeof FORMATTING_TOOLBAR_PREFS)[number];
export const DEFAULT_FORMATTING_TOOLBAR: FormattingToolbarPref = "show";
export const formattingToolbarSchema = z.enum(FORMATTING_TOOLBAR_PREFS);

// What a stored value means: anything unknown is the default.
export function formattingToolbarOf(value: unknown): FormattingToolbarPref {
  return value === "hide" ? "hide" : DEFAULT_FORMATTING_TOOLBAR;
}

// Whether an editor shows its toolbar: hidden by the setting, except on a
// touch phone, where it docks on the keyboard and holds the formatting the
// system's selection menu does not have.
export function showsFormattingToolbar(pref: FormattingToolbarPref, touchPhone: boolean): boolean {
  return pref === "show" || touchPhone;
}
