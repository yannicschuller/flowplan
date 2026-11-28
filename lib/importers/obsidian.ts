// Obsidian vaults: notes become pages, folders parent pages (a folder note
// – "Folder/Folder.md" or "Folder.md" next to the folder – is the folder's
// page), [[Page]], [[Page|label]] and [[Page#Heading]] become links to the
// imported pages ([[Page#Heading]] and [[Page#^blockid]] links to that
// heading or block, whose "^blockid" marker becomes its id, #88),
// ![[image.png]] images and ![[file.pdf]] file links,
// callouts (> [!note]) callouts, and tags from the frontmatter and the
// text (#tag) the page's tags. Frontmatter keys become page properties of
// the type Obsidian registered (.obsidian/types.json) or the notes' values
// show (selects, multi-selects; lib/frontmatter-types.ts, #598).
// Daily notes go into the journal and the templates folder becomes saved
// templates (#668, lib/importers/obsidian-daily.ts); embedded notes are
// inserted as content when switched on (#672, lib/importers/obsidian-embeds.ts).
import { ct } from "../content-locale";
import { posix } from "node:path";
import { markdownToRawHtml } from "../markdown-html";
import { blockMarkers } from "../markdown-import";
import { splitFrontmatter, type FrontmatterValue } from "../frontmatter";
import { frontmatterAliases } from "../aliases";
import { inferPropertyTypes, obsidianTypes } from "../frontmatter-types";
import { fileRef, mimeOf, pageRef } from "./html";
import { nameKey } from "../zip-names";
import { importReport, warningList, type ImportFile, type ImportPage, type ImportTemplate, type ImportTree } from "./types";
import { specialNotes, templateVariables, vaultConfig } from "./obsidian-daily";
import { countNoteEmbeds, embedTranscluder } from "./obsidian-embeds";

// What the import preview switches (#668, #672): daily notes into the
// journal and the templates folder as templates (on unless false), embedded
// notes as content (off unless true).
export type ObsidianOptions = { dailyNotes?: boolean; templates?: boolean; embeds?: boolean };

const NOTE = /\.(md|markdown)$/i;
const hidden = (path: string) => path.split("/").some((part) => part.startsWith("."));

export function isObsidianVault(entries: Map<string, Buffer>) {
  const names = [...entries.keys()];
  return names.some((n) => n.startsWith(".obsidian/")) || (names.some((n) => NOTE.test(n)) && names.some((n) => NOTE.test(n) && /\[\[[^\]\n]+\]\]/.test(entries.get(n)!.toString("utf8"))));
}

// Code blocks and inline code stay as they are.
function outsideCode(markdown: string, fn: (text: string) => string) {
  let fence: string | null = null;
  return markdown
    .split("\n")
    .map((line) => {
      const opening = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
      if (fence) {
        if (opening && opening[1][0] === fence[0] && opening[1].length >= fence.length) fence = null;
        return line;
      }
      if (opening) {
        fence = opening[1];
        return line;
      }
      return line
        .split(/(`+[^`]*`+)/)
        .map((part, i) => (i % 2 ? part : fn(part)))
        .join("");
    })
    .join("\n");
}

const mdEscape = (text: string) => text.replace(/([\\[\]])/g, "\\$1");
export type WikiTarget = { href: string; kind: "page" | "file" } | null;
// [[…]] and ![[…]] as Markdown links to what `lookup` finds; links to
// nothing stay as their text.
// `self`: the note itself, for [[#Heading]] and [[#^blockid]].
export function convertWikilinks(markdown: string, lookup: (target: string) => WikiTarget, onEmbedNote?: () => void, self?: string) {
  return outsideCode(markdown, (text) =>
    text.replace(/(!?)\[\[([^\]\n|]*?)(?:\|([^\]\n]*))?\]\]/g, (_, embed: string, rawTarget: string, label?: string) => {
      const cut = rawTarget.search(/[#^]/);
      const target = cut < 0 ? rawTarget : rawTarget.slice(0, cut),
        anchor = cut < 0 ? "" : rawTarget.slice(cut);
      const shown = (label && !/^\d+(x\d+)?$/.test(label) ? label : "") || (target ? target.replace(/^.*\//, "") : anchor.replace(/^[#^]/, ""));
      // "#Heading#Subheading": the last heading; "#^id" (or "^id"): the block.
      const part = anchor.replace(/^#/, "").split("#").pop()!.trim();
      if (!target.trim()) return self && part ? `[${mdEscape(shown)}](${self}#${encodeURIComponent(part)})` : mdEscape(shown);
      const found = lookup(target.trim());
      if (!found) return mdEscape(shown);
      if (embed && found.kind === "file") return `![${mdEscape(shown)}](${found.href})`;
      if (embed && found.kind === "page") onEmbedNote?.();
      return `[${mdEscape(shown)}](${found.href}${found.kind === "page" && part ? `#${encodeURIComponent(part)}` : ""})`;
    }),
  );
}

// Tags from the frontmatter (tags: [a, b] or "a b") and #tags in the text.
export function noteTags(data: Record<string, FrontmatterValue>, body: string) {
  const tags = new Set<string>();
  const add = (value: string) => {
    const tag = value.trim().replace(/^#/, "").slice(0, 100);
    if (tag && !/^\d+$/.test(tag)) tags.add(tag);
  };
  for (const [key, value] of Object.entries(data))
    if (["tags", "tag"].includes(key.trim().toLowerCase()))
      for (const item of Array.isArray(value) ? value : [value]) if (typeof item === "string") item.split(/[,\s]+/).forEach(add);
  outsideCode(body, (text) => {
    for (const match of text.matchAll(/(?:^|[\s(])#([\p{L}\p{N}_/-]+)/gu)) add(match[1]);
    return text;
  });
  return [...tags];
}

export function parseObsidian(entries: Map<string, Buffer>, name = "Obsidian", options: ObsidianOptions = {}): ImportTree {
  const warnings = warningList();
  const report = importReport();
  const paths = [...entries.keys()].filter((p) => !hidden(p)).sort((a, b) => a.localeCompare(b));
  const notes = paths.filter((p) => NOTE.test(p));
  const attachments = paths.filter((p) => !NOTE.test(p) && !/\.canvas$/i.test(p));
  // NFC as well: macOS names are NFD, the links in the notes mostly NFC (#556).
  const lower = nameKey;
  // Obsidian resolves a name by its path, else by the file name anywhere.
  const notesByPath = new Map(notes.map((p) => [lower(p.replace(NOTE, "")), p]));
  const notesByName = new Map<string, string>();
  for (const p of notes) if (!notesByName.has(lower(posix.basename(p).replace(NOTE, "")))) notesByName.set(lower(posix.basename(p).replace(NOTE, "")), p);
  const filesByPath = new Map(attachments.map((p) => [lower(p), p]));
  const filesByName = new Map<string, string>();
  for (const p of attachments) if (!filesByName.has(lower(posix.basename(p)))) filesByName.set(lower(posix.basename(p)), p);
  const files = new Map<string, ImportFile>();
  const useFile = (path: string) => {
    if (!files.has(path)) files.set(path, { key: path, name: posix.basename(path), mime: mimeOf(path), data: entries.get(path)! });
    return fileRef(path);
  };
  const findNote = (from: string, target: string) => {
    const clean = lower(target.replace(/\\/g, "/").replace(/^\.?\//, ""));
    const relative = lower(posix.normalize(posix.join(posix.dirname(from), target)));
    return notesByPath.get(clean.replace(NOTE, "")) || notesByPath.get(relative.replace(NOTE, "")) || notesByName.get(posix.basename(clean).replace(NOTE, "")) || null;
  };
  const lookup = (from: string) => (target: string) => {
    const clean = lower(target.replace(/\\/g, "/").replace(/^\.?\//, ""));
    const relative = lower(posix.normalize(posix.join(posix.dirname(from), target)));
    const note = findNote(from, target);
    if (note) return { href: pageRef(note), kind: "page" as const };
    const file = filesByPath.get(clean) || filesByPath.get(relative) || filesByName.get(posix.basename(clean));
    if (file) return { href: useFile(file), kind: "file" as const };
    return null;
  };
  // Folder pages, or the folder note that stands for the folder.
  const dirs = new Set(paths.flatMap((p) => p.split("/").slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join("/"))));
  const folderNote = (dir: string) => {
    const inside = `${dir}/${posix.basename(dir)}.md`,
      beside = `${dir}.md`;
    return entries.has(inside) ? inside : entries.has(beside) ? beside : undefined;
  };
  // The folder a folder note stands for.
  const folderOfNote = (path: string) => {
    const dir = posix.dirname(path);
    if (dir !== "." && folderNote(dir) === path) return dir;
    const same = path.replace(NOTE, "");
    return dirs.has(same) && folderNote(same) === path ? same : null;
  };
  // A note's text as imported: no frontmatter, no heading repeating its title.
  const noteText = (path: string) => {
    const source = entries.get(path)?.toString("utf8");
    if (source === undefined) return null;
    const { data, body } = splitFrontmatter(source);
    const title = posix.basename(path).replace(NOTE, "").normalize("NFC");
    return { data, body, title, text: body.normalize("NFC").replace(new RegExp(`^\\s*#\\s+${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\n`), "") };
  };
  // Daily notes and templates (#668).
  const special = specialNotes(notes, vaultConfig(entries), { dailyNotes: options.dailyNotes !== false, templates: options.templates !== false }, report, (w) => warnings.add(w));
  const templates: ImportTemplate[] = [];
  // Embedded notes as content (#672).
  const embeds = options.embeds === true ? embedTranscluder({ body: (p) => (NOTE.test(p) ? (noteText(p)?.text ?? null) : null), resolve: findNote }, report) : null;
  let noteEmbeds = 0;
  const pages: ImportPage[] = [];
  const frontmatters: Record<string, FrontmatterValue>[] = [];
  const folderPages = new Set<string>();
  const folderKey = (dir: string): string | null => {
    if (!dir || dir === ".") return null;
    const note = folderNote(dir);
    if (note) return note;
    const key = `folder:${dir}`;
    if (!folderPages.has(dir)) {
      folderPages.add(dir);
      pages.push({ key, parent: folderKey(posix.dirname(dir)), title: posix.basename(dir), html: "", folder: true });
    }
    return key;
  };
  for (const path of notes) {
    const { data, body, title, text: own } = noteText(path)!;
    frontmatters.push(data);
    const folder = folderOfNote(path);
    const asTemplate = special.templates.has(path);
    const journalDate = folder || asTemplate ? undefined : special.journal.get(path);
    // Journal days and templates live outside the page tree.
    const parent = journalDate || asTemplate ? null : folderKey(posix.dirname(folder ?? path));
    noteEmbeds += countNoteEmbeds(own, path, findNote);
    let text = asTemplate ? templateVariables(own, path, report) : own;
    if (embeds) text = embeds.transclude(text, path);
    const markdown = convertWikilinks(text, lookup(path), () => {
      warnings.add("Eingebettete Notizen werden als Link übernommen.");
      report.add("embed", ct("Eingebettete Notiz als Link übernommen", "Embedded note kept as a link"), path);
    }, pageRef(path));
    const html = blockMarkers(markdownToRawHtml(markdown, (href, kind) => {
      if (href.startsWith("fp-import://")) return href;
      if (/^(https?:|mailto:)/i.test(href)) return href;
      // [text](#Heading) on the same note, [text](Other.md#^id) (#88).
      const anchor = href.includes("#") ? href.slice(href.indexOf("#") + 1) : "";
      if (href.startsWith("#")) return anchor && kind === "link" ? `${pageRef(path)}#${anchor}` : null;
      if (/^[a-z]+:/i.test(href)) return null;
      let target: string;
      try {
        target = decodeURIComponent(href.split("#")[0]);
      } catch {
        return null;
      }
      const found = lookup(path)(target);
      if (!found && kind === "image") {
        warnings.add("Bild ohne Datei im Tresor übersprungen.");
        report.add("file", ct(`Bild „${target.slice(0, 200)}“ fehlt im Tresor`, `Image “${target.slice(0, 200)}” is missing from the vault`), path);
      }
      return found ? found.href + (found.kind === "page" && anchor ? `#${anchor}` : "") : null;
    }));
    if (asTemplate) {
      templates.push({ key: path, name: title, kind: "document", html, tags: noteTags(data, body) });
      continue;
    }
    pages.push({ key: path, parent, title, html, tags: noteTags(data, body), aliases: frontmatterAliases(data), properties: data, ...(journalDate ? { journalDate } : {}) });
  }
  if (!notes.length) warnings.add("Keine Notizen (.md) gefunden.");
  if (embeds?.fallbacks) warnings.add("Einige eingebettete Notizen bleiben Links (Schleife, mehr als drei Ebenen oder zu viel Inhalt).");
  const propertyTypes = inferPropertyTypes(frontmatters, obsidianTypes(entries.get(".obsidian/types.json")?.toString("utf8")));
  return {
    source: "obsidian",
    title: name,
    pages,
    files,
    warnings: warnings.list(),
    report,
    propertyTypes,
    ...(templates.length ? { templates } : {}),
    ...(special.dailyNotes ? { dailyNotes: special.dailyNotes } : {}),
    ...(special.templateNotes ? { templateNotes: special.templateNotes } : {}),
    ...(noteEmbeds ? { noteEmbeds } : {}),
  };
}
