import { Mark } from "@tiptap/core";

// Text colours strong enough to stand out on the light and the dark
// background; highlight colours clearly tinted (the text on them stays
// dark, also in the dark theme – see globals.css).
export const textColors = [
  ["Grau", "#8b8a92"],
  ["Braun", "#b5703c"],
  ["Orange", "#ec6c0e"],
  ["Gelb", "#d9a400"],
  ["Grün", "#2f9e44"],
  ["Blau", "#1c7ed6"],
  ["Lila", "#8f4ad9"],
  ["Pink", "#d6336c"],
  ["Rot", "#e03131"],
] as const;
export const highlightColors = [
  ["Grau", "#e2e1dd"],
  ["Braun", "#efd9c7"],
  ["Orange", "#ffd8a8"],
  ["Gelb", "#ffec99"],
  ["Grün", "#c3eecb"],
  ["Blau", "#c5e0fa"],
  ["Lila", "#e3d3fa"],
  ["Pink", "#fcc9dc"],
  ["Rot", "#ffcaca"],
] as const;
const HEX = /^#[0-9a-f]{6}$/i;
function styleColor(element: HTMLElement) {
  const value = /(?:^|;)\s*color\s*:\s*(#[0-9a-f]{6})\b/i.exec(
    element.getAttribute("style") || "",
  )?.[1];
  return value && HEX.test(value) ? value.toLowerCase() : null;
}
declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    textColor: {
      setTextColor: (color: string) => ReturnType;
      unsetTextColor: () => ReturnType;
    };
    superscript: { toggleSuperscript: () => ReturnType };
    subscript: { toggleSubscript: () => ReturnType };
  }
}
// Stored as <span style="color:#rrggbb">; only 6-digit hex colours.
export const TextColor = Mark.create({
  name: "textColor",
  addAttributes() {
    return { color: { default: null } };
  },
  parseHTML: () => [
    {
      tag: "span[style]",
      getAttrs: (element) => {
        const color = styleColor(element as HTMLElement);
        return color ? { color } : false;
      },
    },
  ],
  renderHTML: ({ mark }) =>
    HEX.test(mark.attrs.color || "")
      ? ["span", { style: `color: ${mark.attrs.color}` }, 0]
      : ["span", {}, 0],
  addCommands() {
    return {
      setTextColor:
        (color) =>
        ({ commands }) =>
          HEX.test(color) && commands.setMark(this.name, { color }),
      unsetTextColor:
        () =>
        ({ commands }) =>
          commands.unsetMark(this.name),
    };
  },
});
export const Superscript = Mark.create({
  name: "superscript",
  excludes: "subscript",
  parseHTML: () => [{ tag: "sup" }],
  renderHTML: () => ["sup", 0],
  addCommands() {
    return {
      toggleSuperscript:
        () =>
        ({ commands }) =>
          commands.toggleMark(this.name),
    };
  },
  addKeyboardShortcuts() {
    return { "Mod-.": () => this.editor.commands.toggleSuperscript() };
  },
});
export const Subscript = Mark.create({
  name: "subscript",
  excludes: "superscript",
  parseHTML: () => [{ tag: "sub" }],
  renderHTML: () => ["sub", 0],
  addCommands() {
    return {
      toggleSubscript:
        () =>
        ({ commands }) =>
          commands.toggleMark(this.name),
    };
  },
  addKeyboardShortcuts() {
    return { "Mod-,": () => this.editor.commands.toggleSubscript() };
  },
});
