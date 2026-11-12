// Block colours (#238): a text colour or a background colour for a whole
// block, chosen in its menu (Notion's ten: "default" and nine colours, the
// same nine as the text marks of lib/text-marks.ts). Stored as a name –
// data-block-color="red" or "red-background" – never as a colour value, so
// the theme decides the shade (globals.css, light and dark) and a pasted
// or imported value cannot inject styles. In Markdown a comment before the
// block keeps it: <!-- flowplan:color red --> (lib/markdown.ts,
// lib/markdown-html.ts); other Markdown tools ignore it.
import { Extension } from "@tiptap/core";

export const BLOCK_COLOR_NAMES = ["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"] as const;
export type BlockColorName = (typeof BLOCK_COLOR_NAMES)[number];
// The blocks that take a colour; a list takes it on its items.
export const BLOCK_COLOR_TYPES = ["paragraph", "heading", "listItem", "taskItem", "blockquote", "toggle"];

// A valid colour value, or null.
export function blockColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const [name, kind, rest] = value.split("-");
  if (rest !== undefined || (kind !== undefined && kind !== "background")) return null;
  return (BLOCK_COLOR_NAMES as readonly string[]).includes(name) ? value : null;
}
export const BLOCK_COLOR_VALUES = BLOCK_COLOR_NAMES.flatMap((name) => [name, `${name}-background`]);

export function blockColorLabels(t: (de: string, en: string) => string): Record<BlockColorName, string> {
  return {
    gray: t("Grau", "Grey"),
    brown: t("Braun", "Brown"),
    orange: t("Orange", "Orange"),
    yellow: t("Gelb", "Yellow"),
    green: t("Grün", "Green"),
    blue: t("Blau", "Blue"),
    purple: t("Lila", "Purple"),
    pink: t("Pink", "Pink"),
    red: t("Rot", "Red"),
  };
}

export const BlockColorAttribute = Extension.create({
  name: "blockColor",
  addGlobalAttributes() {
    return [
      {
        types: BLOCK_COLOR_TYPES,
        attributes: {
          blockColor: {
            default: null,
            parseHTML: (element) => blockColor(element.getAttribute("data-block-color")),
            renderHTML: (attributes) => {
              const color = blockColor(attributes.blockColor);
              return color ? { "data-block-color": color } : {};
            },
          },
        },
      },
    ];
  },
});

// The comment lib/markdown.ts writes before a coloured block.
export const blockColorComment = (value: unknown) => {
  const color = blockColor(value);
  return color ? `<!-- flowplan:color ${color} -->` : "";
};
export const BLOCK_COLOR_COMMENT = /^<!-- flowplan:color ([a-z]+(?:-background)?) -->\s*$/;
