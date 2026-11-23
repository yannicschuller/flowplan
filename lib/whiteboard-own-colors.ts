// Own colours on whiteboards (#455): besides the palettes, every colour of an
// element (fill, line, text) can be picked freely with the colour wheel
// (components/whiteboard/board-color-picker.tsx). Such colours stay as
// chosen on the dark canvas as well: the element lists them in `ownColors`,
// and the board's display palette (lib/whiteboard-display-colors.ts) shows
// those as stored instead of mapping them. Palette colours and colours of
// imported drawings keep the dark canvas's mapping (#399).
import type { BoardPalette } from "./whiteboard-display-colors";
import type { WhiteboardItem } from "./whiteboard-model";

export type OwnColorProp = "fill" | "stroke" | "textColor";
const PROPS: OwnColorProp[] = ["fill", "stroke", "textColor"];
export const MAX_OWN_COLORS = 6;
const HEX = /^#[0-9a-f]{6}$/i;
export const isHexColor = (value: unknown): value is string => typeof value === "string" && HEX.test(value);

// The element's own colours after `prop` gets `color`: only colours it
// still uses, the new one first.
export function withOwnColor(item: Partial<WhiteboardItem>, prop: OwnColorProp, color: string): string[] {
  const c = color.toLowerCase();
  const used = new Set(PROPS.map((p) => (p === prop ? c : typeof item[p] === "string" ? (item[p] as string).toLowerCase() : "")));
  const before = Array.isArray(item.ownColors) ? item.ownColors.filter(isHexColor).map((x) => x.toLowerCase()) : [];
  return [c, ...before.filter((x) => x !== c && used.has(x))].slice(0, MAX_OWN_COLORS);
}
// What to set on an element for an own colour of `prop`.
export function ownColorProps(item: Partial<WhiteboardItem>, prop: OwnColorProp, color: string): Partial<WhiteboardItem> {
  return { [prop]: color.toLowerCase(), ownColors: withOwnColor(item, prop, color) };
}
// The own colours of new elements (pen, notes): the colour when it is not
// one of the palette's.
export const ownColorsFor = (color: string, palette: readonly string[]) =>
  isHexColor(color) && !palette.some((p) => p.toLowerCase() === color.toLowerCase()) ? [color.toLowerCase()] : undefined;

// Every own colour on the board.
export function ownColorSet(items: Pick<WhiteboardItem, "ownColors">[]): Set<string> {
  const out = new Set<string>();
  for (const item of items) if (Array.isArray(item.ownColors)) for (const c of item.ownColors) if (isHexColor(c)) out.add(c.toLowerCase());
  return out;
}
// The palette with the own colours shown as they are.
export function withOwnColors(palette: BoardPalette, own: ReadonlySet<string>): BoardPalette {
  if (!palette.dark || !own.size) return palette;
  const keep = (map: (color: string) => string) => (color: string) => (typeof color === "string" && own.has(color.toLowerCase()) ? color : map(color));
  return {
    ...palette,
    ink: keep(palette.ink),
    fill: keep(palette.fill),
    line: keep(palette.line),
    text: (color, background) => (typeof color === "string" && own.has(color.toLowerCase()) ? color : palette.text(color, background)),
  };
}
