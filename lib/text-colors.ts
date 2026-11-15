// Text colours strong enough to stand out on the light and the dark
// background (the document editor's palette). `id` names the colour in
// inline Markdown ("[text]{.color-blue}", lib/inline-markdown.ts) and in
// the class that shows it (.text-color-blue in globals.css) – no style
// attributes, so the strict CSP of published pages holds.
export const textColorList = [
  { id: "gray", de: "Grau", hex: "#8b8a92" },
  { id: "brown", de: "Braun", hex: "#b5703c" },
  { id: "orange", de: "Orange", hex: "#ec6c0e" },
  { id: "yellow", de: "Gelb", hex: "#d9a400" },
  { id: "green", de: "Grün", hex: "#2f9e44" },
  { id: "blue", de: "Blau", hex: "#1c7ed6" },
  { id: "purple", de: "Lila", hex: "#8f4ad9" },
  { id: "pink", de: "Pink", hex: "#d6336c" },
  { id: "red", de: "Rot", hex: "#e03131" },
] as const;
export type TextColorId = (typeof textColorList)[number]["id"];
const ids = new Set<string>(textColorList.map((c) => c.id));
export const isTextColorId = (value: unknown): value is TextColorId => typeof value === "string" && ids.has(value);
// A colour of the palette by its hex value (pasted from the document editor).
export const textColorByHex = (hex: string): TextColorId | undefined => textColorList.find((c) => c.hex === hex.toLowerCase())?.id;
