import { Node } from "@tiptap/core";
import { MAX_DRAWIO_SVG, MAX_DRAWIO_XML } from "./drawio";
// A draw.io diagram (#110, lib/drawio.ts): its XML in data-drawio, its
// picture (cleaned SVG) in data-drawio-svg. Editors and read-only views
// show the picture (lib/drawio-preview.ts); the stored HTML only names it.
const limited = (value: string | null, max: number) => (value && value.length <= max ? value : "");
export const DrawioBlock = Node.create({
  name: "drawioBlock",
  group: "block",
  atom: true,
  draggable: true,
  addAttributes() {
    return {
      xml: { default: "" },
      svg: { default: "" },
    };
  },
  parseHTML: () => [
    {
      tag: "div[data-drawio]",
      getAttrs: (element) => {
        const el = element as HTMLElement;
        return {
          xml: limited(el.getAttribute("data-drawio"), MAX_DRAWIO_XML),
          svg: limited(el.getAttribute("data-drawio-svg"), MAX_DRAWIO_SVG),
        };
      },
    },
  ],
  renderHTML: ({ node }) => [
    "div",
    {
      "data-drawio": node.attrs.xml || "",
      "data-drawio-svg": node.attrs.svg || "",
      class: "drawio-block",
    },
    "draw.io",
  ],
  renderText: () => "",
});
