// The typefaces a workspace can choose for its look (#196, lib/workspace-theme.ts):
// Flowplan's own three (public/fonts.css), the system's fonts, and a set
// served with the app from public/fonts/theme (woff2 from the @fontsource
// packages, latin and latin-ext, variable where the face has a variable
// cut; all SIL Open Font License 1.1, see LICENSE-*.txt there). Nothing is
// fetched from a font service. The @font-face rules of a bundled face are
// written only into the look of a workspace that uses it, and a browser
// downloads a face only when text is set in it – the default look loads
// nothing beyond fonts.css. Free of React and the DOM.

export type FontSlot = "ui" | "display" | "mono";
export const FONT_SLOTS: FontSlot[] = ["ui", "display", "mono"];
export type FontCategory = "sans" | "serif" | "mono";

type Face = { style: "normal" | "italic"; weight: string; file: string };
export type BundledFont = {
  id: string;
  name: string;
  category: FontCategory;
  // Faces of public/fonts/theme: `file` without the subset, e.g.
  // "inter-{subset}-wght-normal" for inter-latin-wght-normal.woff2.
  faces: Face[];
  // Flowplan's own faces (already in fonts.css) and the system's fonts.
  builtin?: boolean;
};

const variable = (prefix: string, weight: string, italic = true): Face[] => [
  { style: "normal", weight, file: `${prefix}-{subset}-wght-normal` },
  ...(italic ? [{ style: "italic" as const, weight, file: `${prefix}-{subset}-wght-italic` }] : []),
];

export const SYSTEM_FONT = "system";
export const BUNDLED_FONTS: BundledFont[] = [
  { id: "instrument-sans", name: "Instrument Sans", category: "sans", faces: [], builtin: true },
  { id: "instrument-serif", name: "Instrument Serif", category: "serif", faces: [], builtin: true },
  { id: "jetbrains-mono", name: "JetBrains Mono", category: "mono", faces: [], builtin: true },
  { id: SYSTEM_FONT, name: "System", category: "sans", faces: [], builtin: true },
  // Sans serif
  { id: "inter", name: "Inter", category: "sans", faces: variable("inter", "100 900") },
  { id: "atkinson-hyperlegible-next", name: "Atkinson Hyperlegible Next", category: "sans", faces: variable("atkinson-hyperlegible-next", "200 800") },
  { id: "ibm-plex-sans", name: "IBM Plex Sans", category: "sans", faces: variable("ibm-plex-sans", "100 700") },
  { id: "source-sans-3", name: "Source Sans 3", category: "sans", faces: variable("source-sans-3", "200 900") },
  { id: "nunito-sans", name: "Nunito Sans", category: "sans", faces: variable("nunito-sans", "200 1000") },
  { id: "work-sans", name: "Work Sans", category: "sans", faces: variable("work-sans", "100 900") },
  { id: "lexend", name: "Lexend", category: "sans", faces: variable("lexend", "100 900", false) },
  // Serif
  { id: "source-serif-4", name: "Source Serif 4", category: "serif", faces: variable("source-serif-4", "200 900") },
  { id: "lora", name: "Lora", category: "serif", faces: variable("lora", "400 700") },
  { id: "literata", name: "Literata", category: "serif", faces: variable("literata", "200 900") },
  { id: "merriweather", name: "Merriweather", category: "serif", faces: variable("merriweather", "300 900") },
  { id: "eb-garamond", name: "EB Garamond", category: "serif", faces: variable("eb-garamond", "400 800") },
  // Monospace
  {
    id: "ibm-plex-mono",
    name: "IBM Plex Mono",
    category: "mono",
    faces: [
      ...["400", "500", "600", "700"].map((weight) => ({ style: "normal" as const, weight, file: `ibm-plex-mono-{subset}-${weight}-normal` })),
      { style: "italic", weight: "400", file: "ibm-plex-mono-{subset}-400-italic" },
    ],
  },
  { id: "fira-code", name: "Fira Code", category: "mono", faces: variable("fira-code", "300 700", false) },
  { id: "source-code-pro", name: "Source Code Pro", category: "mono", faces: variable("source-code-pro", "200 900") },
];
export const BUNDLED_FONT_IDS = BUNDLED_FONTS.map((f) => f.id);
export const bundledFont = (id: string | null | undefined) => BUNDLED_FONTS.find((f) => f.id === id);

// The look as it is without a choice (app/globals.css).
export const DEFAULT_FONTS: Record<FontSlot, string> = { ui: "instrument-sans", display: "instrument-serif", mono: "jetbrains-mono" };

const CJK_SANS = `"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC"`;
const FALLBACK: Record<FontCategory, string> = {
  sans: `ui-sans-serif, system-ui, -apple-system, "Segoe UI", ${CJK_SANS}, sans-serif`,
  serif: `"Iowan Old Style", Georgia, "Songti SC", "Noto Serif SC", serif`,
  mono: `ui-monospace, "SF Mono", Menlo, "PingFang SC", monospace`,
};
// "System" in each slot: the platform's own interface, serif and code faces.
const SYSTEM_STACK: Record<FontSlot, string> = {
  ui: `system-ui, -apple-system, "Segoe UI", Roboto, ${CJK_SANS}, sans-serif`,
  display: `ui-serif, "Iowan Old Style", Georgia, "Songti SC", "Noto Serif SC", serif`,
  mono: `ui-monospace, "SF Mono", Menlo, Consolas, "PingFang SC", monospace`,
};
const SLOT_CATEGORY: Record<FontSlot, FontCategory> = { ui: "sans", display: "serif", mono: "mono" };

// A workspace's own uploaded face: "custom:<id>" (lib/workspace-fonts.ts).
export const CUSTOM_PREFIX = "custom:";
export const customFontId = (ref: string | null | undefined) =>
  typeof ref === "string" && ref.startsWith(CUSTOM_PREFIX) ? ref.slice(CUSTOM_PREFIX.length) : null;
// The family name of an uploaded face in CSS: from its id only, never
// from the name its owner gave it.
export const customFamily = (id: string) => `wsf-${id.replace(/[^0-9a-f-]/gi, "")}`;

// The CSS font-family list for a choice in a slot.
export function fontStack(slot: FontSlot, ref: string, custom?: { category?: FontCategory }) {
  const id = customFontId(ref);
  if (id) return `"${customFamily(id)}", ${FALLBACK[custom?.category ?? SLOT_CATEGORY[slot]]}`;
  if (ref === SYSTEM_FONT) return SYSTEM_STACK[slot];
  const font = bundledFont(ref);
  if (!font) return null;
  return `"${font.name}", ${FALLBACK[font.category]}`;
}

const LATIN = "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD";
const LATIN_EXT = "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF";
export const FONT_DIR = "/fonts/theme";

// The @font-face rules of a bundled face (none for the built-in ones).
export function bundledFontFaces(id: string) {
  const font = bundledFont(id);
  if (!font) return "";
  return font.faces
    .flatMap((face) =>
      (
        [
          ["latin", LATIN],
          ["latin-ext", LATIN_EXT],
        ] as const
      ).map(
        ([subset, range]) =>
          `@font-face{font-family:"${font.name}";font-style:${face.style};font-display:swap;font-weight:${face.weight};src:url("${FONT_DIR}/${face.file.replace("{subset}", subset)}.woff2") format("woff2");unicode-range:${range}}`,
      ),
    )
    .join("\n");
}
// Every file of public/fonts/theme the catalogue names (tests check both ways).
export const bundledFontFiles = () =>
  BUNDLED_FONTS.flatMap((f) => f.faces.flatMap((face) => ["latin", "latin-ext"].map((subset) => `${face.file.replace("{subset}", subset)}.woff2`)));
