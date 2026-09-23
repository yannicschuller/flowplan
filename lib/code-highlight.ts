import { all, createLowlight } from "lowlight";
import type { Root, RootContent } from "hast";
const engine = createLowlight(all);
export const MAX_HIGHLIGHT_LENGTH = 50_000;
export const codeLanguages = engine.listLanguages().sort();
export const languageLabel = (language: string | null) =>
  !language || ["plaintext", "text", "txt"].includes(language)
    ? "Klartext"
    : language;
const plain = (text: string): Root => ({
  type: "root",
  children: [{ type: "text", value: text }],
});
export function highlightCode(language: string | null, text: string): Root {
  if (
    !language ||
    text.length > MAX_HIGHLIGHT_LENGTH ||
    !engine.registered(language)
  )
    return plain(text);
  try {
    return engine.highlight(language, text);
  } catch {
    return plain(text);
  }
}
// Explicit languages keep collaborative rendering deterministic and avoid expensive auto-detection.
export const codeHighlighter = {
  highlight: highlightCode,
  highlightAuto: plain,
  listLanguages: () => codeLanguages,
  registered: (language: string) => engine.registered(language),
};
const escape = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
export function renderCode(text: string, language: string | null) {
  const render = (node: RootContent): string => {
    if (node.type === "text") return escape(node.value);
    if (node.type !== "element") return "";
    const classes = (
      Array.isArray(node.properties.className) ? node.properties.className : []
    )
      .filter(
        (value) => typeof value === "string" && /^[a-zA-Z0-9_-]+$/.test(value),
      )
      .join(" ");
    return `<span class="${classes}">${node.children.map(render).join("")}</span>`;
  };
  return highlightCode(language, text).children.map(render).join("");
}
