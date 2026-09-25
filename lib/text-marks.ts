import { Mark } from "@tiptap/core";

// Colours as in AppFlowy: text colours and lighter highlight colours.
export const textColors = [
  ["Grau", "#787774"],
  ["Braun", "#9f6b53"],
  ["Orange", "#d9730d"],
  ["Gelb", "#cb912f"],
  ["Grün", "#448361"],
  ["Blau", "#337ea9"],
  ["Lila", "#9065b0"],
  ["Pink", "#c14c8a"],
  ["Rot", "#d44c47"],
] as const;
export const highlightColors = [
  ["Grau", "#f1f1ef"],
  ["Braun", "#f4eeee"],
  ["Orange", "#fbecdd"],
  ["Gelb", "#fbf3db"],
  ["Grün", "#edf3ec"],
  ["Blau", "#e7f3f8"],
  ["Lila", "#f6f3f9"],
  ["Pink", "#faf1f5"],
  ["Rot", "#fdebec"],
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
