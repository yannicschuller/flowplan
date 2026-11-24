// "Schriftart" (#512, Settings → Darstellung & Sprache): the typeface one
// person reads Flowplan in – in the browser, the iPhone/iPad and Android
// app and the desktop app alike. It takes the place of the interface slot
// of the look (--font-ui, lib/workspace-theme.ts), which is also the text
// of documents, records and comments; headings (--font-display), code
// (--font-mono) and pages switched to "Serif" or "Mono" keep their faces.
// Only for this person in the app: a workspace's look still applies to
// everyone else and to forms. Pages the person shares or publishes show
// their visitors the same face (#526, lib/public-appearance.ts).
// Stored per person on the server (users.ui_font: NULL = the default, the
// workspace's interface font or Flowplan's own), delivered with the
// bootstrap and rendered with the page, so the first paint has it.
// Pure: no React, no DOM, no database (lib/user-font.ts stores it).
import { z } from "zod";
import { BUNDLED_FONTS, DEFAULT_FONTS, SYSTEM_FONT, bundledFontFaces, fontStack } from "./theme-fonts";

// The choices: the system's interface font, Flowplan's own interface face
// (also against a workspace's) and the bundled text faces, sans serif and
// serif. Not the monospaced ones nor Instrument Serif (a display face with
// a single weight): whole interfaces and long texts read badly in them.
export const PERSONAL_FONTS: string[] = [
  SYSTEM_FONT,
  DEFAULT_FONTS.ui,
  ...BUNDLED_FONTS.filter((f) => !f.builtin && (f.category === "sans" || f.category === "serif")).map((f) => f.id),
];
export const personalFontSchema = z
  .string()
  .refine((v) => PERSONAL_FONTS.includes(v), "Unbekannte Schrift.")
  .nullable();
export type PersonalFont = string | null;

// What a stored value means: anything not on the list is the default.
export function personalFontOf(value: unknown): PersonalFont {
  return typeof value === "string" && PERSONAL_FONTS.includes(value) ? value : null;
}

// The variables a choice sets on the root: the interface face, and the
// feature settings that go with it (Instrument Sans' stylistic sets are
// other letters in other faces, as in a workspace's look).
export function personalFontVariables(font: PersonalFont): Record<string, string> {
  const id = personalFontOf(font);
  if (!id) return {};
  const stack = fontStack("ui", id);
  if (!stack) return {};
  return { "--font-ui": stack, "font-feature-settings": id === DEFAULT_FONTS.ui ? `"ss01", "cv05"` : "normal" };
}

// The style sheet of a choice: the variables on the root – more specific
// than app/globals.css and a workspace's look (html:root, also in dark
// mode), so they win – and the @font-face rules of a bundled face (the
// browser downloads it only when text is set in it). Empty for the
// default. The values come from the fixed list above, never from input.
export function personalFontCss(font: PersonalFont) {
  const vars = personalFontVariables(font);
  const declarations = Object.entries(vars)
    .map(([k, v]) => `${k}:${v}`)
    .join(";");
  if (!declarations) return "";
  const faces = bundledFontFaces(personalFontOf(font)!);
  return [`html:root:root:root{${declarations}}`, faces].filter(Boolean).join("\n");
}
