// A page tree or a whole space as an e-book (EPUB 3): one XHTML chapter per
// page (lib/export-xhtml.ts), pictures as resources, a navigation document
// with the page tree and a small stylesheet. The container is a ZIP whose
// first entry is the uncompressed mimetype, as the standard demands.
import { Readable } from "node:stream";
import { ZipFile } from "yazl";
import { audit } from "./db";
import { HttpError } from "./auth";
import { ct, contentLocale } from "./content-locale";
import { exportName } from "./export-name";
import { collectExportContent, type ExportContent, type ExportFile } from "./export-content";
import { documentXhtml, xml } from "./export-xhtml";
import { exportUrl } from "./export-docx";
import type { Identity } from "./types";

export type EpubChapter = { id: string; title: string; depth: number; body: string };
export type EpubOptions = {
  identifier: string;
  title: string;
  language: string;
  creator?: string;
  chapters: EpubChapter[];
  // Pictures and other resources below OEBPS/ (path → data).
  resources: Map<string, { mime: string; bytes: Buffer }>;
};
export const EPUB_MIME = "application/epub+zip";
const EPUB_LIMIT = 100 * 1024 * 1024;
const XHTML_NS = "http://www.w3.org/1999/xhtml",
  EPUB_NS = "http://www.idpf.org/2007/ops";

export const EPUB_STYLE = `body { font-family: Georgia, "Times New Roman", serif; line-height: 1.5; margin: 0 1em; }
h1, h2, h3, h4, h5, h6 { font-family: Helvetica, Arial, sans-serif; line-height: 1.25; margin: 1.4em 0 0.5em; }
h1 { font-size: 1.8em; } h2 { font-size: 1.4em; } h3 { font-size: 1.2em; }
p { margin: 0 0 0.8em; }
a { color: #1f3fbf; }
img { max-width: 100%; height: auto; }
figure { margin: 1em 0; text-align: center; }
figcaption { font-size: 0.85em; color: #555; }
pre { white-space: pre-wrap; word-wrap: break-word; font-family: Menlo, Consolas, monospace; font-size: 0.85em; background: #f4f4f2; padding: 0.7em; border-radius: 4px; }
code { font-family: Menlo, Consolas, monospace; font-size: 0.9em; background: #f4f4f2; padding: 0 0.2em; }
pre code { background: none; padding: 0; font-size: inherit; }
blockquote { margin: 1em 0; padding: 0 0 0 1em; border-left: 3px solid #ccc; color: #444; }
.callout { margin: 1em 0; padding: 0.7em 1em; border-left: 4px solid #1a73e8; background: #eef3fd; }
.callout-tip { border-color: #188038; background: #e6f4ea; }
.callout-important { border-color: #8430ce; background: #f3e8fd; }
.callout-warning { border-color: #b06000; background: #fef7e0; }
.callout-caution { border-color: #c5221f; background: #fce8e6; }
.callout-title, .toggle-title, .footnotes-title { font-weight: bold; margin-bottom: 0.3em; }
.toggle { margin: 1em 0; padding: 0.5em 1em; border: 1px solid #ddd; border-radius: 4px; }
table { border-collapse: collapse; width: 100%; margin: 1em 0; font-size: 0.95em; }
th, td { border: 1px solid #ccc; padding: 0.3em 0.5em; text-align: left; vertical-align: top; }
th { background: #f0f0ee; }
th > p, td > p { margin: 0; }
ul.task-list { list-style: none; padding-left: 1.2em; }
.task-box { font-family: "Segoe UI Symbol", "Apple Color Emoji", sans-serif; }
.task.done > p { color: #666; }
.due { font-size: 0.85em; color: #666; }
mark { background: #fff3a3; }
hr { border: 0; border-top: 1px solid #ccc; margin: 1.5em 0; }
.columns .column { margin-bottom: 1em; }
.placeholder, .media, .linked-database, .whiteboard { color: #555; font-style: italic; }
.footnotes { margin-top: 2em; padding-top: 0.5em; border-top: 1px solid #ccc; font-size: 0.85em; }
.footnote-ref a { text-decoration: none; }
.bibliography li { margin-bottom: 0.5em; }
.title-page { text-align: center; margin-top: 30%; }
.title-page h1 { font-size: 2.2em; }
.title-page p { color: #555; }
.cover-image { text-align: center; margin: 1em 0; }`;

const chapterFile = (index: number) => `chapter-${String(index + 1).padStart(3, "0")}.xhtml`;
const xhtmlDocument = (title: string, language: string, body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n<html xmlns="${XHTML_NS}" xmlns:epub="${EPUB_NS}" lang="${xml(language)}" xml:lang="${xml(language)}"><head><meta charset="utf-8"/><title>${xml(title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head><body>${body}</body></html>`;

// The navigation list: items nested by depth.
function navList(chapters: EpubChapter[]) {
  let html = "",
    depth = -1;
  chapters.forEach((chapter, index) => {
    const link = `<a href="${chapterFile(index)}">${xml(chapter.title || ct("Ohne Titel", "Untitled"))}</a>`;
    if (chapter.depth > depth) {
      html += "<ol>".repeat(chapter.depth - depth) + `<li>${link}`;
    } else {
      html += "</li></ol>".repeat(depth - chapter.depth) + `</li><li>${link}`;
    }
    depth = chapter.depth;
  });
  if (depth >= 0) html += "</li></ol>".repeat(depth + 1);
  return html;
}

export function buildEpub(options: EpubOptions): Promise<Buffer> {
  const language = options.language;
  const modified = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const manifest: string[] = [
    `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`,
    `<item id="style" href="style.css" media-type="text/css"/>`,
    `<item id="title-page" href="title.xhtml" media-type="application/xhtml+xml"/>`,
  ];
  const spine: string[] = [`<itemref idref="title-page"/>`];
  const entries: [string, Buffer][] = [];
  options.chapters.forEach((chapter, index) => {
    const id = `c${index + 1}`;
    manifest.push(`<item id="${id}" href="${chapterFile(index)}" media-type="application/xhtml+xml"/>`);
    spine.push(`<itemref idref="${id}"/>`);
    entries.push([
      `OEBPS/${chapterFile(index)}`,
      Buffer.from(xhtmlDocument(chapter.title, language, `<section epub:type="chapter" id="${xml(chapter.id)}"><h1>${xml(chapter.title || ct("Ohne Titel", "Untitled"))}</h1>${chapter.body}</section>`)),
    ]);
  });
  let resourceCount = 0;
  for (const [path, resource] of options.resources) {
    manifest.push(`<item id="r${++resourceCount}" href="${xml(path)}" media-type="${xml(resource.mime)}"/>`);
    entries.push([`OEBPS/${path}`, resource.bytes]);
  }
  const opf =
    `<?xml version="1.0" encoding="UTF-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id" xml:lang="${xml(language)}">` +
    `<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="pub-id">${xml(options.identifier)}</dc:identifier><dc:title>${xml(options.title)}</dc:title>` +
    `<dc:language>${xml(language)}</dc:language>${options.creator ? `<dc:creator>${xml(options.creator)}</dc:creator>` : ""}<meta property="dcterms:modified">${modified}</meta></metadata>` +
    `<manifest>${manifest.join("")}</manifest><spine>${spine.join("")}</spine></package>`;
  const nav = xhtmlDocument(
    ct("Inhalt", "Contents"),
    language,
    `<nav epub:type="toc" id="toc"><h1>${xml(ct("Inhalt", "Contents"))}</h1>${navList(options.chapters)}</nav>`,
  );
  const titlePage = xhtmlDocument(
    options.title,
    language,
    `<section epub:type="titlepage" class="title-page"><h1>${xml(options.title)}</h1>${options.creator ? `<p>${xml(options.creator)}</p>` : ""}<p>${xml(modified.slice(0, 10))}</p></section>`,
  );
  const container = `<?xml version="1.0" encoding="UTF-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`;
  const zip = new ZipFile();
  // The mimetype first and stored, so a reader finds it at a fixed place.
  zip.addBuffer(Buffer.from(EPUB_MIME), "mimetype", { compress: false });
  zip.addBuffer(Buffer.from(container), "META-INF/container.xml");
  zip.addBuffer(Buffer.from(opf), "OEBPS/content.opf");
  zip.addBuffer(Buffer.from(nav), "OEBPS/nav.xhtml");
  zip.addBuffer(Buffer.from(EPUB_STYLE), "OEBPS/style.css");
  zip.addBuffer(Buffer.from(titlePage), "OEBPS/title.xhtml");
  for (const [path, bytes] of entries) zip.addBuffer(bytes, path);
  zip.end();
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    zip.outputStream.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > EPUB_LIMIT) {
        (zip.outputStream as Readable).destroy(new HttpError(413, "E-Book überschreitet 100 MB."));
        return;
      }
      chunks.push(chunk);
    });
    zip.outputStream.once("error", reject);
    zip.once("error", reject);
    zip.outputStream.once("end", () => resolve(Buffer.concat(chunks)));
  });
}

// The chapters of an export: every page as XHTML, pictures collected as
// resources, links between the pages relative within the book.
export function epubChapters(content: ExportContent) {
  const resources = new Map<string, { mime: string; bytes: Buffer }>();
  const chapterOf = new Map(content.pages.map((entry, index) => [entry.page.id, chapterFile(index)]));
  const picture = (raw: string) => {
    const file = content.file(raw);
    if (!file || !/^image\/(png|jpeg|gif|webp|svg\+xml)$/.test(file.mime)) return null;
    const path = `images/${file.id}.${file.ext}`;
    if (!resources.has(path)) resources.set(path, { mime: file.mime, bytes: file.bytes });
    return path;
  };
  const board = (page: { id: string; title: string }, svg: string | null) => {
    if (!svg) return null;
    const path = `images/board-${page.id}.svg`;
    if (!resources.has(path)) resources.set(path, { mime: "image/svg+xml", bytes: Buffer.from(svg) });
    return path;
  };
  const url = (raw: string) => {
    const target = content.readable(raw);
    if (target && chapterOf.has(target.id) && /#page=/.test(raw)) return chapterOf.get(target.id)!;
    return exportUrl(raw, content.readable, content.pageUrl, content.fileInfo);
  };
  const chapters: EpubChapter[] = content.pages.map((entry, index) => {
    let body = "";
    const cover = entry.cover && picture(entry.cover);
    if (cover) body += `<p class="cover-image"><img src="${xml(cover)}" alt=""/></p>`;
    if (entry.page.kind === "whiteboard") {
      const image = board(entry.page, entry.svg);
      body += image
        ? `<figure class="whiteboard"><img src="${xml(image)}" alt="${xml(entry.title || "Whiteboard")}"/></figure>`
        : `<p class="placeholder">${xml(ct("Dieses Whiteboard ist leer.", "This whiteboard is empty."))}</p>`;
    } else
      body += documentXhtml(entry.html, {
        url,
        image: (raw) => picture(raw) || (/^https:\/\//.test(raw) ? raw : null),
        prefix: `c${index + 1}`,
        whiteboard: (pageId) => {
          const page = content.readable(pageId);
          if (!page || page.kind !== "whiteboard") return null;
          return { title: page.title, image: board(page, content.boardSvg(page.id)), url: chapterOf.get(page.id) || content.pageUrl(page.id) };
        },
        linked: (source) => {
          const db = content.readable(source);
          return db && db.kind === "database" ? { title: db.title, url: chapterOf.get(db.id) || content.pageUrl(db.id) } : null;
        },
      });
    return { id: `page-${entry.page.id}`, title: entry.title, depth: entry.depth, body };
  });
  return { chapters, resources };
}

export const EPUB_MAX_PAGES = 200;
export async function exportEpub(user: Identity, options: { pageId?: string; spaceId?: string; children?: boolean }) {
  const content = collectExportContent(user, { ...options, maxPages: EPUB_MAX_PAGES, format: "EPUB" });
  const { chapters, resources } = epubChapters(content);
  const bytes = await buildEpub({
    identifier: `urn:uuid:${content.space ? content.space.id : content.root!.id}`,
    title: content.name || ct("Ohne Titel", "Untitled"),
    language: contentLocale(),
    creator: user.name,
    chapters,
    resources,
  });
  if (content.space) audit(user.id, "space.epub.export", content.space.id);
  else audit(user.id, "page.epub.export", content.root!.id);
  return { bytes, name: `${exportName(content.name)}.epub`, mime: EPUB_MIME };
}
