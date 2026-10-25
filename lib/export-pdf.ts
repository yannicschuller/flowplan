// A page with its sub-pages, or a whole space, as one print view: a cover,
// a table of contents and every page as a chapter on a new page. The PDF
// itself comes from the browser's print dialog, like "Print / PDF" of a
// single page (components/print-page.ts) – there is no renderer on the
// server. Pictures stay at /api/files/…, which the browser loads with the
// session; renderers that know `target-counter` (Prince, Paged.js) also
// fill in the page numbers of the table of contents.
import { audit } from "./db";
import { ct, contentLocale } from "./content-locale";
import { localeTag } from "./i18n";
import { exportName } from "./export-name";
import { collectExportContent, type ExportContent } from "./export-content";
import { documentXhtml, xml } from "./export-xhtml";
import { exportUrl } from "./export-docx";
import type { Identity } from "./types";

export const PDF_MAX_PAGES = 200;
export const PRINT_STYLE = `@page { size: A4; margin: 18mm 16mm 20mm; @bottom-center { content: counter(page); font: 10pt Helvetica, Arial, sans-serif; color: #666; } }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; background: #fff; }
.print-book { max-width: 760px; margin: 0 auto; padding: 24px 16px; color: #111; font: 11pt/1.5 Georgia, "Times New Roman", serif; }
.print-book h1, .print-book h2, .print-book h3, .print-book h4, .print-book h5, .print-book h6 { font-family: Helvetica, Arial, sans-serif; line-height: 1.25; margin: 1.3em 0 0.4em; break-after: avoid; page-break-after: avoid; }
.print-book h1 { font-size: 20pt; } .print-book h2 { font-size: 15pt; } .print-book h3 { font-size: 13pt; } .print-book h4, .print-book h5, .print-book h6 { font-size: 11pt; }
.print-book p { margin: 0 0 0.7em; orphans: 3; widows: 3; }
.print-book a { color: #1f3fbf; text-decoration: none; }
.print-book a[href^="http"]::after { content: " (" attr(href) ")"; font-size: 8pt; color: #666; word-break: break-all; }
.print-book .cover { min-height: 70vh; display: flex; flex-direction: column; justify-content: center; text-align: center; page-break-after: always; break-after: page; }
.print-book .cover-kind { text-transform: uppercase; letter-spacing: 0.1em; font: 9pt Helvetica, Arial, sans-serif; color: #666; }
.print-book .cover h1 { font-size: 30pt; margin: 0.3em 0; }
.print-book .cover-meta { color: #666; }
.print-book .cover-image img { max-width: 60%; max-height: 40vh; margin-top: 1em; }
.print-book .toc { page-break-after: always; break-after: page; }
.print-book .toc ol { list-style: none; margin: 0; padding: 0 0 0 1.2em; }
.print-book .toc > ol { padding-left: 0; }
.print-book .toc li { margin: 0.25em 0; font-family: Helvetica, Arial, sans-serif; }
.print-book .toc a { color: inherit; display: flex; justify-content: space-between; gap: 1em; }
.print-book .toc a::after { content: target-counter(attr(href url), page); color: #666; }
.print-book .toc .number { color: #666; margin-right: 0.5em; }
.print-book .chapter { page-break-before: always; break-before: page; }
.print-book .chapter-title { font-size: 24pt; margin: 0 0 0.6em; padding-bottom: 0.3em; border-bottom: 2px solid #ddd; }
.print-book .chapter-title .number { color: #999; margin-right: 0.4em; }
.print-book img { max-width: 100%; height: auto; }
.print-book figure { margin: 1em 0; text-align: center; break-inside: avoid; page-break-inside: avoid; }
.print-book figcaption { font-size: 9pt; color: #555; }
.print-book pre { white-space: pre-wrap; word-wrap: break-word; font: 9pt/1.4 Menlo, Consolas, monospace; background: #f4f4f2; padding: 0.7em; border-radius: 4px; break-inside: avoid; page-break-inside: avoid; }
.print-book code { font-family: Menlo, Consolas, monospace; font-size: 0.9em; background: #f4f4f2; padding: 0 0.2em; }
.print-book pre code { background: none; padding: 0; font-size: inherit; }
.print-book blockquote { margin: 1em 0; padding: 0 0 0 1em; border-left: 3px solid #ccc; color: #444; break-inside: avoid; }
.print-book .callout { margin: 1em 0; padding: 0.7em 1em; border-left: 4px solid #1a73e8; background: #eef3fd; break-inside: avoid; page-break-inside: avoid; }
.print-book .callout-tip { border-color: #188038; background: #e6f4ea; }
.print-book .callout-important { border-color: #8430ce; background: #f3e8fd; }
.print-book .callout-warning { border-color: #b06000; background: #fef7e0; }
.print-book .callout-caution { border-color: #c5221f; background: #fce8e6; }
.print-book .callout-title, .print-book .toggle-title, .print-book .footnotes-title { font-weight: bold; margin-bottom: 0.3em; font-family: Helvetica, Arial, sans-serif; }
.print-book .toggle { margin: 1em 0; padding: 0.5em 1em; border: 1px solid #ddd; border-radius: 4px; }
.print-book table { border-collapse: collapse; width: 100%; margin: 1em 0; font-size: 9.5pt; }
.print-book th, .print-book td { border: 1px solid #ccc; padding: 0.3em 0.5em; text-align: left; vertical-align: top; }
.print-book th { background: #f0f0ee; font-family: Helvetica, Arial, sans-serif; }
.print-book tr { break-inside: avoid; page-break-inside: avoid; }
.print-book th > p, .print-book td > p { margin: 0; }
.print-book ul.task-list { list-style: none; padding-left: 1.2em; }
.print-book .task-box { font-family: "Segoe UI Symbol", "Apple Color Emoji", sans-serif; }
.print-book .task.done > p { color: #666; }
.print-book .due { font-size: 9pt; color: #666; }
.print-book mark { background: #fff3a3; }
.print-book hr { border: 0; border-top: 1px solid #ccc; margin: 1.5em 0; }
.print-book .columns { display: flex; gap: 1.5em; }
.print-book .columns .column { flex: 1; min-width: 0; }
.print-book .placeholder, .print-book .media, .print-book .linked-database, .print-book .whiteboard { color: #555; font-style: italic; }
.print-book .footnotes { margin-top: 2em; padding-top: 0.5em; border-top: 1px solid #ccc; font-size: 9pt; }
.print-book .footnotes a::after { content: none; }
.print-book .footnote-ref a::after { content: none; }
.print-book .bibliography li { margin-bottom: 0.5em; }
@media screen { body { background: #e9e9e6; } .print-book { background: #fff; box-shadow: 0 2px 12px rgba(0,0,0,0.12); margin: 24px auto; } }`;

// Chapter numbers like 1, 1.1, 1.2, 2 from the depth of every page.
function numbers(pages: ExportContent["pages"]) {
  const counters: number[] = [];
  return pages.map((entry) => {
    counters.length = entry.depth + 1;
    counters[entry.depth] = (counters[entry.depth] || 0) + 1;
    return counters.join(".");
  });
}

export function printHtml(content: ExportContent, author: string) {
  const locale = contentLocale();
  const anchors = new Map(content.pages.map((entry) => [entry.page.id, `#p-${entry.page.id}`]));
  const image = (raw: string) => (content.fileInfo(raw) ? raw.replace(/^https?:\/\/[^/]+/, "") : /^https:\/\//.test(raw) ? raw : null);
  const url = (raw: string) => {
    const target = content.readable(raw);
    if (target && anchors.has(target.id) && /#page=/.test(raw)) return anchors.get(target.id)!;
    return exportUrl(raw, content.readable, content.pageUrl, content.fileInfo);
  };
  const svgData = (svg: string) => `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  const chapterNumbers = numbers(content.pages);
  const chapters = content.pages.map((entry, index) => {
    const title = entry.title || ct("Ohne Titel", "Untitled");
    let body = "";
    if (entry.cover) body += `<p class="cover-image"><img src="${xml(entry.cover)}" alt=""></p>`;
    if (entry.page.kind === "whiteboard")
      body += entry.svg
        ? `<figure class="whiteboard"><img src="${xml(svgData(entry.svg))}" alt="${xml(title)}"></figure>`
        : `<p class="placeholder">${xml(ct("Dieses Whiteboard ist leer.", "This whiteboard is empty."))}</p>`;
    else
      body += documentXhtml(entry.html, {
        url,
        image,
        prefix: `c${index + 1}`,
        whiteboard: (pageId) => {
          const page = content.readable(pageId);
          if (!page || page.kind !== "whiteboard") return null;
          const svg = content.boardSvg(page.id);
          return { title: page.title, image: svg ? svgData(svg) : null, url: anchors.get(page.id) || content.pageUrl(page.id) };
        },
        linked: (source) => {
          const db = content.readable(source);
          return db && db.kind === "database" ? { title: db.title, url: anchors.get(db.id) || content.pageUrl(db.id) } : null;
        },
        ink: (attrs) => {
          const picture = content.ink(entry.page.id, attrs);
          return picture && { image: picture.svg ? svgData(picture.svg) : null, text: picture.text };
        },
      });
    return `<article class="chapter" id="p-${entry.page.id}"><h1 class="chapter-title"><span class="number">${chapterNumbers[index]}</span>${xml(title)}</h1>${body}</article>`;
  });
  // The table of contents nested like the page tree.
  let toc = "",
    depth = -1;
  content.pages.forEach((entry, index) => {
    const link = `<a href="#p-${entry.page.id}"><span><span class="number">${chapterNumbers[index]}</span>${xml(entry.title || ct("Ohne Titel", "Untitled"))}</span></a>`;
    if (entry.depth > depth) toc += "<ol>".repeat(entry.depth - depth) + `<li>${link}`;
    else toc += "</li></ol>".repeat(depth - entry.depth) + `</li><li>${link}`;
    depth = entry.depth;
  });
  if (depth >= 0) toc += "</li></ol>".repeat(depth + 1);
  const title = content.name || ct("Ohne Titel", "Untitled");
  const date = new Date().toLocaleDateString(localeTag(locale), { year: "numeric", month: "long", day: "numeric" });
  const cover = content.root?.cover && content.pages[0]?.cover ? `<p class="cover-image"><img src="${xml(content.pages[0].cover)}" alt=""></p>` : "";
  return (
    `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${xml(title)}</title><style>${PRINT_STYLE}</style></head>` +
    `<body><main class="print-book">` +
    `<section class="cover"><p class="cover-kind">${xml(content.space ? ct("Bereich", "Space") : ct("Seite mit Unterseiten", "Page with sub-pages"))}</p><h1>${xml(title)}</h1>${cover}` +
    `<p class="cover-meta">${xml(author)} · ${xml(date)} · ${content.pages.length} ${xml(content.pages.length === 1 ? ct("Seite", "page") : ct("Seiten", "pages"))}</p></section>` +
    `<nav class="toc"><h2>${xml(ct("Inhalt", "Contents"))}</h2>${toc}</nav>` +
    chapters.join("") +
    `</main></body></html>`
  );
}

export function exportPrintHtml(user: Identity, options: { pageId?: string; spaceId?: string; children?: boolean }) {
  const content = collectExportContent(user, { ...options, maxPages: PDF_MAX_PAGES, format: "PDF" });
  const html = printHtml(content, user.name);
  if (content.space) audit(user.id, "space.pdf.export", content.space.id);
  else audit(user.id, "page.pdf.export", content.root!.id);
  return { html, name: `${exportName(content.name)}.html` };
}
