// The look of typed text boxes as a whole – face, size, colour, bold,
// italic, underline, alignment and line height – and how the editor, the
// SVG and the PDF lay out its lines. Free of React and the DOM.
//
// Alignment works inside the box the text takes (lib/ink/geometry.ts
// textBox: the rough width of its longest line): (x, y) stays its top
// left, the lines are centred on its middle or end at its right edge.
// Changing the alignment or the size so never moves the box.
import { isInkFont, inkFontAdvance, type InkFont } from "./fonts";
import { LINE_HEIGHT, cleanTextLook, type InkItem, type InkText, type InkTextAlign } from "./model";

export type TextAlign = "left" | InkTextAlign;
export const TEXT_ALIGNS: TextAlign[] = ["left", "center", "right"];
export const LINE_HEIGHTS = [1, 1.25, 1.5, 2];

// The look of one text box, every field given.
export type TextLook = {
  font: InkFont | undefined;
  size: number;
  color: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  align: TextAlign;
  lineHeight: number;
};
// A change of the look; `font: undefined` is the default face (Helvetica).
export type TextLookPatch = Partial<TextLook>;
// What several boxes share: `null` where they differ (shown as "—").
export type SharedTextLook = { [K in keyof TextLook]: TextLook[K] | null };

const round2 = (n: number) => Math.round(n * 100) / 100;
const COLOR = /^#[0-9a-f]{6}$/i;

export const lineHeightOf = (item: Pick<InkText, "lineHeight">) => item.lineHeight ?? LINE_HEIGHT.default;
// Bold and italic faces are a little wider (rough, as the advance itself).
export const textAdvance = (item: Pick<InkText, "font" | "bold">) => inkFontAdvance(item.font) * (item.bold ? 1.07 : 1);
// The rough width of the longest line, in page units.
export function textWidth(item: Pick<InkText, "text" | "size" | "font" | "bold">) {
  const longest = Math.max(1, ...item.text.split("\n").map((l) => l.length));
  return longest * item.size * textAdvance(item);
}
// Where the lines are anchored, along the box (before the box's turn):
// x of the start (left), middle (center) or end (right) of each line.
export function textAnchorX(item: InkText) {
  if (item.align === "center") return item.x + textWidth(item) / 2;
  if (item.align === "right") return item.x + textWidth(item);
  return item.x;
}
// The baseline of line `i` (0 first), before the box's turn.
export const baselineY = (item: InkText, i: number) => item.y + item.size * 0.8 + i * item.size * lineHeightOf(item);
// SVG text-anchor / CSS text-align of the box.
export const svgAnchor = (item: Pick<InkText, "align">) => (item.align === "center" ? "middle" : item.align === "right" ? "end" : "start");

export function textLook(item: InkText): TextLook {
  return {
    font: item.font,
    size: item.size,
    color: item.color,
    bold: !!item.bold,
    italic: !!item.italic,
    underline: !!item.underline,
    align: item.align || "left",
    lineHeight: lineHeightOf(item),
  };
}

// What the text boxes among `items` share (null: no text at all).
export function sharedTextLook(items: InkItem[]): SharedTextLook | null {
  const texts = items.filter((i): i is InkText => i.type === "text").map(textLook);
  if (!texts.length) return null;
  const out = { ...texts[0] } as SharedTextLook;
  for (const look of texts.slice(1))
    for (const key of Object.keys(out) as (keyof TextLook)[]) if (out[key] !== null && out[key] !== look[key]) (out as Record<string, unknown>)[key] = null;
  return out;
}

// The text box with a new look: the stored field order of lib/ink/model.ts
// (so a merge compares like with like); defaults are left out.
export function withTextLook(item: InkText, patch: TextLookPatch): InkText {
  const now = textLook(item);
  const next: TextLook = { ...now };
  if ("font" in patch) next.font = isInkFont(patch.font) ? patch.font : undefined;
  if (patch.size !== undefined && Number.isFinite(patch.size)) next.size = round2(Math.min(400, Math.max(2, patch.size)));
  if (patch.color !== undefined && COLOR.test(patch.color)) next.color = patch.color.toLowerCase();
  for (const key of ["bold", "italic", "underline"] as const) if (patch[key] !== undefined) next[key] = !!patch[key];
  if (patch.align && TEXT_ALIGNS.includes(patch.align)) next.align = patch.align;
  if (patch.lineHeight !== undefined && Number.isFinite(patch.lineHeight)) next.lineHeight = patch.lineHeight;
  if ((Object.keys(next) as (keyof TextLook)[]).every((k) => next[k] === now[k])) return item;
  return {
    id: item.id,
    type: "text",
    color: next.color,
    size: next.size,
    x: item.x,
    y: item.y,
    text: item.text,
    ...(next.font ? { font: next.font } : {}),
    ...cleanTextLook({
      ...next,
      bold: next.bold || undefined,
      italic: next.italic || undefined,
      underline: next.underline || undefined,
      align: next.align,
    }),
    ...(item.rotation ? { rotation: item.rotation } : {}),
    ...(item.rec ? { rec: item.rec } : {}),
  };
}

// The new look for every chosen text box (other items stay); the same list
// when nothing changes, so no undo step is made for it.
export function applyTextLook(items: InkItem[], ids: Set<string>, patch: TextLookPatch): InkItem[] {
  let changed = false;
  const next = items.map((item) => {
    if (item.type !== "text" || !ids.has(item.id)) return item;
    const styled = withTextLook(item, patch);
    if (styled !== item) changed = true;
    return styled;
  });
  return changed ? next : items;
}
