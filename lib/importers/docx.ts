// A minimal Word (DOCX) to HTML conversion for imports – the reverse of
// lib/export-docx.ts: paragraphs, headings (Title, Heading1–6 or styles
// named "heading n"), bold/italic/underline/strike, links, bulleted and
// numbered lists (word/numbering.xml), tables and embedded images.
import { posix } from "node:path";
import { readZip } from "../archive";
import { attr, children, esc, fileRef, find, isElement, mimeOf, nestedList, parseXml, text, type Element, type ListItem } from "./html";
import type { ImportFile } from "./types";

const REL_IMAGE = /\/image$/;
const REL_LINK = /\/hyperlink$/;

export async function docxToHtml(bytes: Buffer, key: string, budget?: { left: number }) {
  const entries = await readZip(bytes, { foreign: true, maxEntries: 2000, budget });
  return docxEntriesToHtml(entries, key);
}

export function docxEntriesToHtml(entries: Map<string, Buffer>, key: string) {
  const xml = (name: string) => (entries.has(name) ? parseXml(entries.get(name)!.toString("utf8")) : null);
  const document = xml("word/document.xml");
  const files = new Map<string, ImportFile>();
  if (!document) return { html: "", files, title: "" };
  // Relationships: images and links.
  const rels = new Map<string, { type: string; target: string; external: boolean }>();
  const relDoc = xml("word/_rels/document.xml.rels");
  if (relDoc)
    for (const rel of find(relDoc.children, (el) => el.name === "Relationship"))
      rels.set(attr(rel, "Id"), { type: attr(rel, "Type"), target: attr(rel, "Target"), external: attr(rel, "TargetMode") === "External" });
  // Heading levels by style id.
  const headingOf = new Map<string, number>();
  const styles = xml("word/styles.xml");
  if (styles)
    for (const style of find(styles.children, (el) => el.name === "w:style" && attr(el, "w:type") === "paragraph")) {
      const nameEl = children(style).find((c) => c.name === "w:name");
      const name = nameEl ? attr(nameEl, "w:val").toLowerCase() : "";
      const level = name === "title" ? 1 : Number(/^heading (\d)$/.exec(name)?.[1] || 0);
      if (level) headingOf.set(attr(style, "w:styleId"), level);
    }
  for (let i = 1; i <= 6; i++) if (!headingOf.has(`Heading${i}`)) headingOf.set(`Heading${i}`, i);
  if (!headingOf.has("Title")) headingOf.set("Title", 1);
  // Numbered or bulleted, per list and level.
  const ordered = new Map<string, boolean>();
  const numbering = xml("word/numbering.xml");
  if (numbering) {
    const abstract = new Map<string, Map<string, boolean>>();
    for (const def of find(numbering.children, (el) => el.name === "w:abstractNum")) {
      const levels = new Map<string, boolean>();
      for (const lvl of children(def).filter((c) => c.name === "w:lvl")) {
        const fmt = children(lvl).find((c) => c.name === "w:numFmt");
        levels.set(attr(lvl, "w:ilvl"), !!fmt && !["bullet", "none"].includes(attr(fmt, "w:val")));
      }
      abstract.set(attr(def, "w:abstractNumId"), levels);
    }
    for (const num of find(numbering.children, (el) => el.name === "w:num")) {
      const ref = children(num).find((c) => c.name === "w:abstractNumId");
      const levels = ref ? abstract.get(attr(ref, "w:val")) : undefined;
      for (const [lvl, isOrdered] of levels || []) ordered.set(`${attr(num, "w:numId")}:${lvl}`, isOrdered);
    }
  }
  const image = (rid: string) => {
    const rel = rels.get(rid);
    if (!rel || !REL_IMAGE.test(rel.type) || rel.external) return "";
    const path = posix.normalize(posix.join("word", rel.target.replace(/^\//, "")));
    const data = entries.get(path) || entries.get(rel.target.replace(/^\//, ""));
    if (!data) return "";
    const fileKey = `${key}/${path}`;
    files.set(fileKey, { key: fileKey, name: posix.basename(path), mime: mimeOf(path), data });
    return `<img src="${fileRef(fileKey)}" alt="">`;
  };
  const on = (props: Element | undefined, name: string) => {
    const el = props && children(props).find((c) => c.name === name);
    return !!el && !["0", "false", "none"].includes(attr(el, "w:val"));
  };
  const runHtml = (r: Element): string => {
    const props = children(r).find((c) => c.name === "w:rPr");
    let out = "";
    for (const part of children(r)) {
      if (part.name === "w:t") out += esc(text(part));
      else if (part.name === "w:tab") out += " ";
      else if (part.name === "w:br" || part.name === "w:cr") out += "<br>";
      else if (part.name === "w:drawing" || part.name === "w:pict") {
        for (const blip of find(part, (el) => el.name === "a:blip" || el.name === "v:imagedata")) out += image(attr(blip, "r:embed") || attr(blip, "r:id"));
      }
    }
    if (!out) return "";
    if (on(props, "w:strike") || on(props, "w:dstrike")) out = `<s>${out}</s>`;
    if (on(props, "w:u")) out = `<u>${out}</u>`;
    if (on(props, "w:i")) out = `<em>${out}</em>`;
    if (on(props, "w:b")) out = `<strong>${out}</strong>`;
    return out;
  };
  const inline = (p: Element): string =>
    children(p)
      .map((node) => {
        if (node.name === "w:r") return runHtml(node);
        if (node.name === "w:hyperlink") {
          const rel = rels.get(attr(node, "r:id"));
          const content = inline(node);
          return rel && REL_LINK.test(rel.type) && /^(https?:|mailto:)/i.test(rel.target) ? `<a href="${esc(rel.target)}">${content}</a>` : content;
        }
        if (["w:ins", "w:smartTag", "w:sdt", "w:sdtContent", "w:fldSimple"].includes(node.name)) return inline(node);
        return "";
      })
      .join("");
  const blocks = (parent: Element): string => {
    let out = "";
    let list: ListItem[] = [];
    const flush = () => {
      if (list.length) out += nestedList(list);
      list = [];
    };
    for (const node of children(parent)) {
      if (node.name === "w:p") {
        const props = children(node).find((c) => c.name === "w:pPr");
        const style = props && children(props).find((c) => c.name === "w:pStyle");
        const numPr = props && children(props).find((c) => c.name === "w:numPr");
        const content = inline(node).trim();
        if (numPr) {
          const numIdEl = children(numPr).find((c) => c.name === "w:numId");
          const ilvl = children(numPr).find((c) => c.name === "w:ilvl");
          const numId = numIdEl ? attr(numIdEl, "w:val") : "0";
          const level = Math.min(8, Number(ilvl ? attr(ilvl, "w:val") : 0) || 0);
          if (numId !== "0") {
            list.push({ level, ordered: ordered.get(`${numId}:${level}`) ?? false, html: content });
            continue;
          }
        }
        flush();
        const heading = style ? headingOf.get(attr(style, "w:val")) : undefined;
        if (!content) continue;
        out += heading ? `<h${Math.min(3, heading)}>${content}</h${Math.min(3, heading)}>` : `<p>${content}</p>`;
      } else if (node.name === "w:tbl") {
        flush();
        const rows = children(node).filter((c) => c.name === "w:tr");
        out += `<table><tbody>${rows
          .map(
            (tr) =>
              `<tr>${children(tr)
                .filter((c) => c.name === "w:tc")
                .map((tc) => {
                  const tcPr = children(tc).find((c) => c.name === "w:tcPr");
                  const span = tcPr && children(tcPr).find((c) => c.name === "w:gridSpan");
                  const colspan = span && Number(attr(span, "w:val")) > 1 ? ` colspan="${Math.min(50, Number(attr(span, "w:val")))}"` : "";
                  return `<td${colspan}>${blocks(tc) || "<p></p>"}</td>`;
                })
                .join("")}</tr>`,
          )
          .join("")}</tbody></table>`;
      } else if (node.name === "w:sdt") {
        flush();
        const content = children(node).find((c) => c.name === "w:sdtContent");
        if (content) out += blocks(content);
      }
    }
    flush();
    return out;
  };
  const body = find(document.children, (el) => el.name === "w:body")[0];
  const html = body ? blocks(body) : "";
  // The document's own title (core properties), if any.
  const core = xml("docProps/core.xml");
  const titleEl = core && find(core.children, (el) => el.name === "dc:title")[0];
  return { html, files, title: titleEl && isElement(titleEl) ? text(titleEl).trim() : "" };
}
