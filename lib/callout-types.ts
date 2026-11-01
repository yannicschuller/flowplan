import type { CalloutType } from "./document-schema";

type T = (de: string, en: string) => string;
// Names of the five callout kinds (GitHub alerts), for menus and slash commands.
export const calloutLabels = (t: T): Record<CalloutType, string> => ({
  note: t("Hinweis", "Note"),
  tip: t("Tipp", "Tip"),
  important: t("Wichtig", "Important"),
  warning: t("Warnung", "Warning"),
  caution: t("Achtung", "Caution"),
});
export const calloutDescriptions = (t: T): Record<CalloutType, string> => ({
  note: t("Nützliche Information", "Useful information"),
  tip: t("Hilfreicher Rat", "Helpful advice"),
  important: t("Das Wichtigste auf einen Blick", "Key information"),
  warning: t("Braucht Aufmerksamkeit", "Needs attention"),
  caution: t("Risiko oder unerwünschte Folge", "Risk or negative outcome"),
});

// A callout's own colour (issue #72): one of the text colours of the editor
// (lib/text-marks.ts), stored as a name (data-callout-color="green"), never
// as a free value. Without one the kind decides the colour.
export const CALLOUT_COLORS = {
  gray: "#8b8a92",
  brown: "#b5703c",
  orange: "#ec6c0e",
  yellow: "#d9a400",
  green: "#2f9e44",
  blue: "#1c7ed6",
  purple: "#8f4ad9",
  pink: "#d6336c",
  red: "#e03131",
} as const;
export type CalloutColor = keyof typeof CALLOUT_COLORS;
export const CALLOUT_COLOR_NAMES = Object.keys(CALLOUT_COLORS) as CalloutColor[];
export const calloutColor = (value: unknown): CalloutColor | null =>
  typeof value === "string" && Object.hasOwn(CALLOUT_COLORS, value) ? (value as CalloutColor) : null;
export const calloutColorLabels = (t: T): Record<CalloutColor, string> => ({
  gray: t("Grau", "Grey"),
  brown: t("Braun", "Brown"),
  orange: t("Orange", "Orange"),
  yellow: t("Gelb", "Yellow"),
  green: t("Grün", "Green"),
  blue: t("Blau", "Blue"),
  purple: t("Lila", "Purple"),
  pink: t("Pink", "Pink"),
  red: t("Rot", "Red"),
});

const graphemes = (text: string) =>
  typeof Intl.Segmenter === "function"
    ? [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].length
    : Array.from(text).length;
// A callout's own symbol in place of the kind's icon: a single emoji or a
// symbol (★, →, ✓, a flag, a keycap) – one character as seen on screen, no
// letters, digits, punctuation, spaces or markup. Anything else is dropped.
export function calloutIcon(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const icon = value.trim();
  if (!icon || icon.length > 32) return null;
  if (/[<>&"'`\\\s\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(icon)) return null;
  // Something pictographic or a symbol sign; keycaps end in the
  // combining enclosing keycap.
  if (!/[\p{Extended_Pictographic}\p{S}\u20e3]/u.test(icon)) return null;
  // Letters or digits only count inside a keycap; tag sequences of flags
  // (🏴󠁧󠁢󠁳󠁣󠁴󠁿) are format characters, not letters.
  if (/[\p{L}\p{N}]/u.test(icon) && !/^[0-9#*]\ufe0f?\u20e3$/u.test(icon)) return null;
  return graphemes(icon) === 1 ? icon : null;
}
// A light background of a colour (mixed with white), for exports that have
// no color-mix(): "#2f9e44" → "e9f5ec".
export function calloutFill(hex: string, share = 0.1) {
  const value = parseInt(hex.slice(1), 16);
  return [16, 8, 0]
    .map((shift) => Math.round(((value >> shift) & 255) * share + 255 * (1 - share)).toString(16).padStart(2, "0"))
    .join("");
}
