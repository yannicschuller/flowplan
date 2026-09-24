import { Marked, type Tokens } from "marked";
import { cleanHtml, escaped } from "./document-server";

// GitHub-flavoured Markdown to editor HTML. `resolve` maps link and image
// targets (e.g. files inside an export) and may drop them by returning null.
export function markdownToHtml(
  markdown: string,
  resolve: (href: string, kind: "link" | "image") => string | null = (href) =>
    href,
) {
  const marked = new Marked({ gfm: true, breaks: false, async: false });
  marked.use({
    renderer: {
      link({ href, tokens }: Tokens.Link) {
        const text = this.parser.parseInline(tokens);
        const target = resolve(href, "link");
        return target ? `<a href="${escaped(target)}">${text}</a>` : text;
      },
      image({ href, text }: Tokens.Image) {
        const target = resolve(href, "image");
        return target
          ? `<img src="${escaped(target)}" alt="${escaped(text)}">`
          : escaped(text);
      },
      // Raw HTML in Markdown is shown as text, never interpreted.
      html({ text }: Tokens.HTML | Tokens.Tag) {
        return escaped(text);
      },
    },
  });
  const html = (marked.parse(markdown) as string)
    // Task list items become editor task items.
    .replace(
      /<ul>\s*((?:<li><input[^>]*type="checkbox"[^>]*>[\s\S]*?<\/li>\s*)+)<\/ul>/g,
      (_, items: string) =>
        `<ul data-type="taskList">${items.replace(
          /<li><input([^>]*)>\s*([\s\S]*?)<\/li>/g,
          (_m: string, attrs: string, body: string) =>
            `<li data-type="taskItem" data-checked="${/checked/.test(attrs)}"><p>${body.replace(/^<p>|<\/p>$/g, "")}</p></li>`,
        )}</ul>`,
    );
  return cleanHtml(html);
}
