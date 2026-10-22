// Evernote export (.enex, one file per notebook; several in a ZIP): every
// note becomes a page with its ENML turned into HTML, its resources
// (base64 with MIME type, referenced by MD5 hash from <en-media>) become
// files, and its tags, dates and source address are kept.
import { createHash } from "node:crypto";
import { attr, children, esc, fileRef, isElement, mergeLists, parseHtml, parseXml, renderNodes, text, type Element } from "./html";
import { EXT_BY_MIME, find, byTag, taskItem } from "./html";
import { isoDate, warningList, type ImportFile, type ImportPage, type ImportTree } from "./types";

const child = (el: Element, name: string) => children(el).find((c) => c.name === name);
const childText = (el: Element, name: string) => {
  const found = child(el, name);
  return found ? text(found).trim() : "";
};

export function parseEnex(files: { name: string; xml: string }[]): ImportTree {
  const warnings = warningList();
  const pages: ImportPage[] = [];
  const stored = new Map<string, ImportFile>();
  const notebooks = files.length > 1;
  for (const [index, file] of files.entries()) {
    const notebook = file.name.replace(/^.*\//, "").replace(/\.enex$/i, "") || "Evernote";
    const notebookKey = `notebook:${index}`;
    if (notebooks) pages.push({ key: notebookKey, parent: null, title: notebook, html: "", folder: true });
    const doc = parseXml(file.xml);
    const notes = find(doc.children, byTag("note"));
    if (!notes.length) warnings.add(`${file.name}: keine Notizen gefunden.`);
    for (const [n, note] of notes.entries()) {
      const key = `${notebookKey}/note:${n}`;
      // Resources by hash (the MD5 of the data, as hex).
      const resources = new Map<string, ImportFile>();
      for (const [r, resource] of find(note, byTag("resource")).entries()) {
        const dataEl = child(resource, "data");
        if (!dataEl) continue;
        const data = Buffer.from(text(dataEl).replace(/\s+/g, ""), "base64");
        const mime = childText(resource, "mime").toLowerCase() || "application/octet-stream";
        const attributes = child(resource, "resource-attributes");
        const ext = EXT_BY_MIME[mime] || "bin";
        const name = (attributes && childText(attributes, "file-name")) || `datei-${r + 1}.${ext}`;
        const hash = createHash("md5").update(data).digest("hex");
        const fileKey = `${key}/${hash}`;
        const entry = { key: fileKey, name, mime, data };
        resources.set(hash, entry);
        stored.set(fileKey, entry);
      }
      const used = new Set<string>();
      const enml = childText(note, "content");
      const body = parseHtml(enml.replace(/<\?xml[^>]*\?>/, "").replace(/<!DOCTYPE[^>]*>/i, ""));
      const html = mergeLists(
        renderNodes(body.children, {
          inline: new Set(["en-media", "en-todo"]),
          rule(el, inner) {
            if (el.name === "en-media") {
              const hash = attr(el, "hash").toLowerCase();
              const resource = resources.get(hash);
              if (!resource) {
                warnings.add("Verweis auf eine fehlende Ressource übersprungen.");
                return "";
              }
              used.add(hash);
              return `<img src="${fileRef(resource.key)}" alt="${esc(resource.name)}">`;
            }
            if (el.name === "en-crypt") {
              warnings.add("Verschlüsselter Text kann nicht übernommen werden.");
              return "";
            }
            if (el.name === "en-todo") return "";
            // A line starting with a checkbox is a task.
            if (["div", "p"].includes(el.name)) {
              const first = el.children.find((c) => !(c.type === "text" && !c.data.trim()));
              if (isElement(first) && first.name === "en-todo") {
                const checked = attr(first, "checked") === "true";
                const content = inner().trim();
                return taskItem(checked, content);
              }
            }
            return undefined;
          },
        }),
      );
      // Attachments the text does not show come at the end.
      const rest = [...resources].filter(([hash]) => !used.has(hash));
      const attachments = rest.length
        ? `<p>${rest.map(([, r]) => `<a href="${fileRef(r.key)}">${esc(r.name)}</a>`).join("<br>")}</p>`
        : "";
      const attributes = child(note, "note-attributes");
      pages.push({
        key,
        parent: notebooks ? notebookKey : null,
        title: childText(note, "title").slice(0, 200) || "Ohne Titel",
        html: html + attachments,
        created: isoDate(childText(note, "created")),
        updated: isoDate(childText(note, "updated")),
        tags: [...new Set(children(note).filter((c) => c.name === "tag").map((c) => text(c).trim().slice(0, 100)).filter(Boolean))],
        url: attributes ? childText(attributes, "source-url") || undefined : undefined,
      });
    }
  }
  return {
    source: "evernote",
    title: files.length === 1 ? files[0].name.replace(/^.*\//, "").replace(/\.enex$/i, "") || "Evernote" : "Evernote",
    pages,
    files: stored,
    warnings: warnings.list(),
  };
}
