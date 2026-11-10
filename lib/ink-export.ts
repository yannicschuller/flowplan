// Handwriting in read-only places on the server: published pages and the
// exports (PDF print view, EPUB, Word, Markdown). Drawing blocks and
// notebook sheets become SVG pictures (lib/ink/svg.ts) with their typed and
// recognised text; callers have checked that the page may be read.
import { drawBlockHeight, drawBlockId, drawBlockPaper, DRAW_BLOCK_WIDTH } from "./draw-block-node";
import { blockPaperLayout, effectivePaper, paperImageOf, paperLayout, paperSize, paperSvg } from "./notebook-paper";
import { imageDataUrls, pageFileIds } from "./notebook-library";
import { notebookPaper, notebookSheets } from "./notebook";
import { pageInkDocs } from "./page-ink-store";
import { inkSvg } from "./ink/svg";
import { inkFiles, inkText, type InkItem } from "./ink/model";
import { ct } from "./content-locale";
import { escaped } from "./document-server";
import { publicFile } from "./publication";
import type { Page } from "./types";
import { mapAsync, replaceAsync } from "./each-async";

export type InkPicture = { svg: string | null; text: string; width: number; height: number };

async function pictureUrls(pageId: string, items: InkItem[], paperFile?: string) {
  const files = inkFiles({ format: "flowplan-ink", version: 1, unit: "pt", pages: { s: items } });
  if (paperFile) files.push(paperFile);
  return files.length ? await imageDataUrls(files, await pageFileIds(pageId)) : new Map<string, string>();
}

// A drawing block of a document (attributes as stored in its HTML) or a
// sheet of a notebook; null when the page has no such surface.
export async function inkPicture(page: Pick<Page, "id" | "kind" | "title">, attrs: { id?: unknown; height?: unknown; paper?: unknown }): Promise<InkPicture | null> {
  const surface = drawBlockId(attrs.id);
  if (!surface) return null;
  const ink = (await pageInkDocs(page.id)).get(surface);
  const items = ink?.doc.pages[surface] || [];
  const text = [inkText(ink?.doc || { format: "flowplan-ink", version: 1, unit: "pt", pages: {} }), ink?.recognized || ""].filter(Boolean).join("\n");
  if (page.kind === "notebook") {
    const sheet = (await notebookSheets(page.id)).find((s) => s.id === surface);
    if (!sheet) return null;
    const paper = effectivePaper(await notebookPaper(page.id), sheet.paper);
    const size = sheet.background ? { width: sheet.background.width, height: sheet.background.height } : paperSize(paper);
    // A PDF page as background cannot be drawn here: plain paper of its size.
    const layout = sheet.background ? paperLayout({ ...paper, template: "blank", color: "light" }, size) : paperLayout(paper, size);
    // Pictures go into the picture itself (the export leaves Flowplan).
    const urls = await pictureUrls(page.id, items, layout.image?.file);
    const imageHref = (file: string) => urls.get(file) ?? null;
    return { svg: inkSvg(items, size, { paper: paperSvg(layout, { imageHref }), title: page.title, dark: !sheet.background && paper.color === "dark", imageHref }), text, ...size };
  }
  const size = { width: DRAW_BLOCK_WIDTH, height: drawBlockHeight(attrs.height) };
  if (!items.length) return { svg: null, text, ...size };
  const layout = blockPaperLayout(drawBlockPaper(attrs.paper), size);
  return { svg: inkSvg(items, size, { paper: `<rect width="${size.width}" height="${size.height}" fill="#ffffff"/>` + paperSvg(layout), title: ct("Handschrift", "Handwriting") }), text, ...size };
}

// A notebook as document HTML for the exports: per sheet a heading and a
// drawing block that the exporters turn into the sheet's picture.
export async function notebookExportHtml(page: Pick<Page, "id">) {
  return (await notebookSheets(page.id))
    .map((sheet, index) => {
      const label = sheet.background ? ct(`Blatt ${index + 1} (PDF-Seite ${sheet.background.page})`, `Sheet ${index + 1} (PDF page ${sheet.background.page})`) : ct(`Blatt ${index + 1}`, `Sheet ${index + 1}`);
      return `<h2>${escaped(label)}</h2><div data-ink-block="${sheet.id}" data-ink-height="0" data-ink-paper="blank"></div>`;
    })
    .join("");
}

// Published pages: the placeholders of drawing blocks get their picture
// (generated here from parsed ink: numbers, checked colours, escaped text).
export function withInkPictures(html: string, page: Pick<Page, "id" | "kind" | "title">) {
  if (!html.includes("data-ink-block")) return html;
  return replaceAsync(html, /<div([^>]*\bdata-ink-block="([\w-]{1,40})"[^>]*)>([\s\S]*?)<\/div>/g, async (match, attrs: string, blockId: string) => {
    const attr = (name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1];
    const picture = await inkPicture(page, { id: blockId, height: attr("data-ink-height"), paper: attr("data-ink-paper") });
    if (!picture) return match;
    const body = picture.svg
      ? picture.svg.replace("<svg ", `<svg class="ink-block-picture" preserveAspectRatio="xMidYMid meet" style="aspect-ratio:${picture.width}/${picture.height}" `)
      : `<p class="ink-block-empty">${escaped(ct("Leere Zeichnung", "Empty drawing"))}</p>`;
    return `<div${attrs.replace(/\bclass="[^"]*"/, "")} class="ink-block-static">${body}</div>`;
  });
}

// The sheets of a published notebook: pictures, or the published PDF page
// with the ink over it.
export async function publicNotebookSheets(page: Pick<Page, "id" | "title">, token: string) {
  const defaults = await notebookPaper(page.id);
  const inks = await pageInkDocs(page.id);
  return await mapAsync(await notebookSheets(page.id), async (sheet, index) => {
    const items = inks.get(sheet.id)?.doc.pages[sheet.id] || [];
    const paper = effectivePaper(defaults, sheet.paper);
    const size = sheet.background ? { width: sheet.background.width, height: sheet.background.height } : paperSize(paper);
    const label = ct(`Blatt ${index + 1}`, `Sheet ${index + 1}`);
    // Files of the published page only (pictures, own paper, PDF pages).
    const shared = new Map<string, string | null>();
    const shareUrl = async (file: string) => {
      if (!shared.has(file))
        shared.set(
          file,
          await publicFile(token, file)
            .then(() => `/api/share/${token}/files/${file}`)
            .catch(() => null),
        );
      return shared.get(file)!;
    };
    for (const file of inkFiles({ format: "flowplan-ink", version: 1, unit: "pt", pages: { s: items } })) await shareUrl(file);
    const imageHref = (file: string) => shared.get(file) ?? null;
    let src: string | null = null;
    if (sheet.background) src = await shareUrl(sheet.background.file);
    if (sheet.background && src)
      return { id: sheet.id, label, ...size, background: { src, page: sheet.background.page }, ink: inkSvg(items, size, { title: label, imageHref }) };
    // An own template that is a PDF page: drawn like a PDF background.
    const own = !sheet.background ? paperImageOf(paper) : null;
    if (own) await shareUrl(own.file);
    const ownSrc = own ? shared.get(own.file) : null;
    if (own?.kind === "pdf" && ownSrc)
      return { id: sheet.id, label, ...size, background: { src: ownSrc, page: 1 }, ink: inkSvg(items, size, { title: label, imageHref }) };
    const layout = sheet.background ? paperLayout({ ...paper, template: "blank", color: "light" }, size) : paperLayout(paper, size);
    return { id: sheet.id, label, ...size, svg: inkSvg(items, size, { paper: paperSvg(layout, { imageHref }), title: label, dark: !sheet.background && paper.color === "dark", imageHref }) };
  });
}
