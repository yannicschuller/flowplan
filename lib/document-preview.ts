import sanitize from "sanitize-html";
import { cleanHtml, escaped } from "./document-server";
export type DocumentPreview = {
  html: string;
  text: string;
  hasContent: boolean;
  image?: string;
};
// HTML from imports/legacy rows is untrusted, even when no editor has opened it yet.
export function documentPreview(source: string): DocumentPreview {
  let image: string | undefined;
  const html = cleanHtml(
    source.trimStart().startsWith("<")
      ? source
      : `<p>${escaped(source).replaceAll("\n", "</p><p>")}</p>`,
    (tagName, attribs) => {
      if (
        tagName === "img" &&
        !image &&
        /^\/api\/files\/[0-9a-f-]{36}$/i.test(attribs.src || "")
      )
        image = attribs.src;
      if (tagName === "input")
        return attribs.type === "checkbox"
          ? {
              tagName,
              attribs: {
                type: "checkbox",
                disabled: "",
                ...(attribs.checked !== undefined ? { checked: "" } : {}),
              },
            }
          : { tagName: "span", attribs: {} };
      if (tagName === "video" || tagName === "audio")
        return {
          tagName,
          attribs: { ...attribs, controls: "", preload: "none" },
        };
      return { tagName, attribs };
    },
  );
  const encoded = sanitize(
    html
      .replace(
        /<\/(?:p|h[1-6]|li|blockquote|pre|div|td|th|tr|summary)>/gi,
        "$& ",
      )
      .replace(/<br\s*\/?\s*>/gi, " "),
    { allowedTags: [], allowedAttributes: {} },
  );
  const text = encoded
    .replace(
      /&(?:amp|lt|gt|quot|apos|nbsp);/g,
      (entity) =>
        ({
          "&amp;": "&",
          "&lt;": "<",
          "&gt;": ">",
          "&quot;": '"',
          "&apos;": "'",
          "&nbsp;": " ",
        })[entity]!,
    )
    .replace(/\s+/g, " ")
    .trim();
  return {
    html,
    text,
    ...(image ? { image } : {}),
    hasContent: !!text || /<(?:img|video|audio|iframe|hr|input)\b/i.test(html),
  };
}
