import { Node } from "@tiptap/core";
import { blockText, storedBlockData } from "./plugin-protocol";
// A block of a block extension (lib/plugins.ts). The stored HTML names the
// plugin and block type, keeps the plugin's data (JSON, at most 64 KB) and
// the plain text it handed over for search and exports; the frame is drawn
// by components/plugin-block.ts.
const PLACEHOLDER = "Erweiterung";
export const PluginBlock = Node.create({
  name: "pluginBlock",
  group: "block",
  atom: true,
  draggable: true,
  addAttributes() {
    return {
      pluginId: { default: "" },
      blockType: { default: "" },
      label: { default: "" },
      data: { default: "null" },
      text: { default: "" },
    };
  },
  parseHTML: () => [
    {
      tag: "div[data-plugin]",
      getAttrs: (element) => {
        const el = element as HTMLElement;
        const pluginId = el.getAttribute("data-plugin") || "";
        if (!/^[0-9a-f-]{36}$/i.test(pluginId)) return false;
        const label = (el.getAttribute("data-plugin-label") || "").slice(0, 60);
        const text = blockText(el.textContent || "");
        return {
          pluginId,
          blockType: (el.getAttribute("data-plugin-type") || "").slice(0, 40),
          label,
          data: storedBlockData(el.getAttribute("data-plugin-data")),
          // Without text of its own the label stands in (see renderHTML).
          text: text === label || text === PLACEHOLDER ? "" : text,
        };
      },
    },
  ],
  renderHTML: ({ node }) => [
    "div",
    {
      "data-plugin": node.attrs.pluginId,
      "data-plugin-type": node.attrs.blockType,
      "data-plugin-label": node.attrs.label,
      "data-plugin-data": storedBlockData(node.attrs.data),
      class: "plugin-block",
    },
    // The searchable text (lib/search-index.ts reads the document's text).
    blockText(node.attrs.text) || node.attrs.label || PLACEHOLDER,
  ],
});
