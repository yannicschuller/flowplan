// Obsidian vaults: notes become pages, folders parent pages (a folder note
// – "Folder/Folder.md" or "Folder.md" next to the folder – is the folder's
// page), [[Page]], [[Page|label]] and [[Page#Heading]] become links to the
// imported pages ([[Page#Heading]] and [[Page#^blockid]] links to that
// heading or block, whose "^blockid" marker becomes its id, #88),
// ![[image.png]] images and ![[file.pdf]] file links,
// callouts (> [!note]) callouts, and tags from the frontmatter and the
// text (#tag) the page's tags. Frontmatter keys become page properties of
// the type Obsidian registered (.obsidian/types.json) or the notes' values
// show (selects, multi-selects; lib/frontmatter-types.ts, #598) – except
// the dates, icon and cover the page takes itself (#669). ==Highlights==
// become highlights, %%comments%% are left out (#665); what has no
// counterpart (Dataview queries, Bases, Canvas files) is named in the import
// report (#671).
import { ct } from "../content-locale";
import { posix } from "node:path";
import { markdownToRawHtml } from "../markdown-html";
import { blockMarkers } from "../markdown-import";
import { splitFrontmatter, type FrontmatterValue } from "../frontmatter";
import { frontmatterAliases } from "../aliases";
import { inferPropertyTypes, obsidianTypes } from "../frontmatter-types";
import { fileRef, isImage, mimeOf, pageRef } from "./html";
import { nameKey } from "../zip-names";
import { importIcon } from "./write";
import { importReport, isoDate, warningList, type ImportFile, type ImportPage, type ImportTree } from "./types";
import { CANVAS, canvasBoard, readCanvas, type CanvasJson } from "./obsidian-canvas";

const NOTE = /\.(md|markdown)$/i;
const hidden = (path: string) => path.split("/").some((part) => part.startsWith("."));

export function isObsidianVault(entries: Map<string, Buffer>) {
  const names = [...entries.keys()];
  return names.some((n) => n.startsWith(".obsidian/")) || (names.some((n) => NOTE.test(n)) && names.some((n) => NOTE.test(n) && /\[\[[^\]\n]+\]\]/.test(entries.get(n)!.toString("utf8"))));
}

// Code blocks and inline code stay as they are (or go through `code`).
function outsideCode(markdown: string, fn: (text: string) => string, code = (text: string) => text) {
  let fence: string | null = null;
  return markdown
    .split("\n")
    .map((line) => {
      const opening = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
      if (fence) {
        if (opening && opening[1][0] === fence[0] && opening[1].length >= fence.length) fence = null;
        return code(line);
      }
      if (opening) {
        fence = opening[1];
        return code(line);
      }
      return line
        .split(/(`+[^`]*`+)/)
        .map((part, i) => (i % 2 ? code(part) : fn(part)))
        .join("");
    })
    .join("\n");
}

// Obsidian's comments (%%…%%, inline or over several lines) outside code
// are left out, a line holding nothing else with them; an unclosed %% stays
// text (#665).
export function stripComments(markdown: string) {
  // The same text with code blanked out, so a %% in code is not one.
  const masked = outsideCode(markdown, (text) => text, (code) => "\0".repeat(code.length));
  let out = "",
    at = 0,
    count = 0;
  for (const match of masked.matchAll(/%%[\s\S]*?%%/g)) {
    let start = match.index,
      end = start + match[0].length;
    const lineStart = markdown.lastIndexOf("\n", start - 1) + 1,
      newline = markdown.indexOf("\n", end),
      lineEnd = newline < 0 ? markdown.length : newline;
    if (lineStart >= at && !markdown.slice(lineStart, start).trim() && !markdown.slice(end, lineEnd).trim()) {
      start = lineStart;
      end = newline < 0 ? lineEnd : newline + 1;
    }
    out += markdown.slice(at, start);
    at = end;
    count++;
  }
  return { markdown: out + markdown.slice(at), count };
}

// ==text== outside code as a highlight (<mark>, lib/markdown-html.ts keeps
// it; the text inside keeps its formatting, #665).
export const highlights = (markdown: string) =>
  outsideCode(markdown, (text) => text.replace(/(?<![=\\])==(?![\s=])([^\n]*?[^\s=\\])==(?!=)/g, "<mark>$1</mark>"));

// Dataview queries outside other code: ```dataview / ```dataviewjs blocks
// and inline `= …` / `$= …` queries (#671). They stay code, not run.
export function dataviewQueries(markdown: string) {
  let blocks = 0,
    inline = 0,
    fence: string | null = null;
  for (const line of markdown.split("\n")) {
    const opening = /^\s{0,3}(`{3,}|~{3,})\s*([^\s`]*)/.exec(line);
    if (fence) {
      if (opening && opening[1][0] === fence[0] && opening[1].length >= fence.length) fence = null;
      continue;
    }
    if (opening) {
      fence = opening[1];
      if (/^dataview(js)?$/i.test(opening[2])) blocks++;
      continue;
    }
    for (const span of line.match(/`[^`]+`/g) || []) if (/^`\$?=(?!=)\s*[^\s`]/.test(span)) inline++;
  }
  return { blocks, inline };
}

const mdEscape = (text: string) => text.replace(/([\\[\]])/g, "\\$1");
export type WikiTarget = { href: string; kind: "page" | "file" } | null;
// [[…]] and ![[…]] as Markdown links to what `lookup` finds; links to
// nothing stay as their text.
// `self`: the note itself, for [[#Heading]] and [[#^blockid]].
// In a table the pipe before the label is escaped: [[Page\|label]] (#659).
// `onMissingEmbed`: an ![[…]] whose target is not in the vault (#660).
export function convertWikilinks(
  markdown: string,
  lookup: (target: string) => WikiTarget,
  onEmbedNote?: () => void,
  self?: string,
  onMissingEmbed?: (target: string) => void,
) {
  return outsideCode(markdown, (text) =>
    text.replace(/(!?)\[\[([^\]\n|]*?)(?:\\?\|([^\]\n]*))?\]\]/g, (_, embed: string, rawTarget: string, label?: string) => {
      const cut = rawTarget.search(/[#^]/);
      const target = cut < 0 ? rawTarget : rawTarget.slice(0, cut),
        anchor = cut < 0 ? "" : rawTarget.slice(cut);
      const alias = label && !/^\d+(x\d+)?$/.test(label) ? label : "";
      let shown = alias || (target ? target.replace(/^.*\//, "") : anchor.replace(/^[#^]/, ""));
      // "#Heading#Subheading": the last heading; "#^id" (or "^id"): the block.
      const part = anchor.replace(/^#/, "").split("#").pop()!.trim();
      if (!target.trim()) return self && part ? `[${mdEscape(shown)}](${self}#${encodeURIComponent(part)})` : mdEscape(shown);
      const found = lookup(target.trim());
      if (!found) {
        if (embed) onMissingEmbed?.(target.trim());
        return mdEscape(shown);
      }
      // [[Page.md]] shows the page's title, as Obsidian does (#657).
      if (!alias && found.kind === "page") shown = shown.replace(NOTE, "");
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
  // A colour in the text (#ff00aa, #1a2b3c, #ff00aa80) is no tag: six or
  // eight hex digits mixing letters and digits (#661). #fff, #cafe, #face
  // stay tags, as in Obsidian.
  const colour = (tag: string) => /^(?:[0-9a-f]{6}|[0-9a-f]{8})$/i.test(tag) && /\d/.test(tag) && /[a-f]/i.test(tag);
  for (const [key, value] of Object.entries(data))
    if (["tags", "tag"].includes(key.trim().toLowerCase()))
      for (const item of Array.isArray(value) ? value : [value]) if (typeof item === "string") item.split(/[,\s]+/).forEach(add);
  outsideCode(body, (text) => {
    for (const match of text.matchAll(/(?:^|[\s(])#([\p{L}\p{N}_/-]+)/gu)) if (!colour(match[1])) add(match[1]);
    return text;
  });
  return [...tags];
}

// Frontmatter keys the page takes itself (#669), folded ("Date created",
// "date_created" and "date-created" alike): when it was created and last
// changed, its icon (an emoji) and its cover (an image of the vault, as a
// path, [[image.png]] or ![](image.png)). A key whose value does not fit
// stays a property.
const metaKey = (key: string) => key.replace(/[\s_-]+/g, " ").trim().toLowerCase();
const CREATED = ["created", "date created", "creation date", "created at", "created on"],
  UPDATED = ["updated", "modified", "date modified", "last modified", "updated at", "modified at", "updated on"],
  ICON = ["icon", "emoji"],
  COVER = ["cover", "banner", "image"];
function frontmatterDate(value: FrontmatterValue) {
  if (typeof value !== "string") return undefined;
  const text = value.trim().replace(/^\[\[(.*)\]\]$/, "$1");
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? isoDate(text) : undefined;
}
// The vault path a cover names; links elsewhere (https:…) are not files of
// the import.
function coverTarget(value: FrontmatterValue) {
  const text = Array.isArray(value) ? value[0] : value;
  if (typeof text !== "string") return null;
  const raw = text.trim();
  const wiki = /^!?\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]$/.exec(raw),
    markdown = /^!?\[[^\]]*\]\(<?([^)>]+?)>?\)$/.exec(raw);
  let target = wiki?.[1] ?? markdown?.[1] ?? raw;
  try {
    if (markdown) target = decodeURIComponent(target);
  } catch {
    return null;
  }
  target = target.trim();
  return !target || /^[a-z][a-z0-9+.-]*:/i.test(target) ? null : target;
}
export function pageMeta(data: Record<string, FrontmatterValue>, image: (target: string) => string | null) {
  const meta: Pick<ImportPage, "created" | "updated" | "icon" | "cover"> = {};
  const properties: Record<string, FrontmatterValue> = {};
  for (const [key, value] of Object.entries(data)) {
    const name = metaKey(key);
    if (!meta.created && CREATED.includes(name) && (meta.created = frontmatterDate(value))) continue;
    if (!meta.updated && UPDATED.includes(name) && (meta.updated = frontmatterDate(value))) continue;
    if (!meta.icon && ICON.includes(name) && (meta.icon = importIcon(value) ?? undefined)) continue;
    if (!meta.cover && COVER.includes(name)) {
      const target = coverTarget(value);
      if (target && (meta.cover = image(target) ?? undefined)) continue;
    }
    properties[key] = value;
  }
  for (const key of Object.keys(meta) as (keyof typeof meta)[]) if (!meta[key]) delete meta[key];
  return { meta, properties };
}

// The candidate closest to the note `from` (#663): fewest folders up and
// down between them (the same folder first), then the one sharing more of
// the path, then the first by path.
export function closestPath(from: string, candidates: string[] | undefined) {
  if (!candidates?.length) return undefined;
  const parts = (path: string) => posix.dirname(path).split("/").filter((part) => part && part !== ".").map(nameKey);
  const here = parts(from);
  let best = candidates[0],
    bestSteps = Infinity,
    bestShared = -1;
  for (const candidate of candidates) {
    const there = parts(candidate);
    let shared = 0;
    while (shared < here.length && shared < there.length && here[shared] === there[shared]) shared++;
    const steps = here.length - shared + there.length - shared;
    if (steps < bestSteps || (steps === bestSteps && shared > bestShared)) {
      best = candidate;
      bestSteps = steps;
      bestShared = shared;
    }
  }
  return best;
}

export function parseObsidian(entries: Map<string, Buffer>, name = "Obsidian"): ImportTree {
  const warnings = warningList();
  const report = importReport();
  const paths = [...entries.keys()].filter((p) => !hidden(p)).sort((a, b) => a.localeCompare(b));
  const notes = paths.filter((p) => NOTE.test(p));
  const attachments = paths.filter((p) => !NOTE.test(p) && !/\.canvas$/i.test(p));
  // NFC as well: macOS names are NFD, the links in the notes mostly NFC (#556).
  const lower = nameKey;
  // Obsidian resolves a name by its path, else by the file name anywhere.
  const notesByPath = new Map(notes.map((p) => [lower(p.replace(NOTE, "")), p]));
  // Every path of a name: the closest one wins (#663).
  const byName = (list: string[], name: (path: string) => string) => {
    const out = new Map<string, string[]>();
    for (const p of list) {
      const key = lower(name(p));
      out.set(key, [...(out.get(key) || []), p]);
    }
    return out;
  };
  const notesByName = byName(notes, (p) => posix.basename(p).replace(NOTE, ""));
  const filesByPath = new Map(attachments.map((p) => [lower(p), p]));
  const filesByName = byName(attachments, (p) => posix.basename(p));
  // Canvases (#667) become whiteboards, found by path or name like notes;
  // one that is no JSON Canvas is left out and reported.
  const canvases = new Map<string, CanvasJson>();
  for (const p of paths.filter((p) => CANVAS.test(p))) {
    const canvas = readCanvas(entries.get(p)!);
    if ("error" in canvas) report.add("other", `${canvas.error}: ${p.slice(0, 200)}`);
    else canvases.set(p, canvas);
  }
  const canvasesByPath = new Map([...canvases.keys()].map((p) => [lower(p), p]));
  const canvasesByName = byName([...canvases.keys()], (p) => posix.basename(p));
  const files = new Map<string, ImportFile>();
  const useFile = (path: string) => {
    if (!files.has(path)) files.set(path, { key: path, name: posix.basename(path), mime: mimeOf(path), data: entries.get(path)! });
    return fileRef(path);
  };
  // The note or file a link from `from` names.
  const resolve = (from: string, target: string) => {
    const clean = lower(target.replace(/\\/g, "/").replace(/^\.?\//, ""));
    const relative = lower(posix.normalize(posix.join(posix.dirname(from), target)));
    const note =
      notesByPath.get(clean.replace(NOTE, "")) ||
      notesByPath.get(relative.replace(NOTE, "")) ||
      closestPath(from, notesByName.get(posix.basename(clean).replace(NOTE, "")));
    if (note) return { path: note, kind: "page" as const };
    const canvas = canvasesByPath.get(clean) || canvasesByPath.get(relative) || closestPath(from, canvasesByName.get(posix.basename(clean)));
    if (canvas) return { path: canvas, kind: "page" as const };
    const file = filesByPath.get(clean) || filesByPath.get(relative) || closestPath(from, filesByName.get(posix.basename(clean)));
    return file ? { path: file, kind: "file" as const } : null;
  };
  const lookup = (from: string) => (target: string) => {
    const found = resolve(from, target);
    if (!found) return null;
    return found.kind === "page" ? { href: pageRef(found.path), kind: "page" as const } : { href: useFile(found.path), kind: "file" as const };
  };
  // Folder pages, or the folder note that stands for the folder: in it or
  // beside it, named as the folder in any case, .md or .markdown (#662).
  const dirs = new Map<string, string>();
  for (const p of paths) {
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      if (!dirs.has(lower(dir))) dirs.set(lower(dir), dir);
    }
  }
  const folderNote = (dir: string) => notesByPath.get(lower(`${dir}/${posix.basename(dir)}`)) ?? notesByPath.get(lower(dir));
  // The folder a folder note stands for.
  const folderOfNote = (path: string) => {
    const dir = posix.dirname(path);
    if (dir !== "." && folderNote(dir) === path) return dir;
    const same = dirs.get(lower(path.replace(NOTE, "")));
    return same && folderNote(same) === path ? same : null;
  };
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
    const source = entries.get(path)!.toString("utf8");
    const { data: frontmatter, body: raw } = splitFrontmatter(source);
    // An image of the vault as the cover (#669).
    const { meta, properties: data } = pageMeta(frontmatter, (target) => {
      const found = resolve(path, target);
      if (found?.kind !== "file" || !isImage(mimeOf(found.path))) return null;
      useFile(found.path);
      return found.path;
    });
    frontmatters.push(data);
    const title = posix.basename(path).replace(NOTE, "").normalize("NFC");
    const folder = folderOfNote(path);
    const parent = folderKey(posix.dirname(folder ?? path));
    const comments = stripComments(raw);
    const body = comments.markdown;
    if (comments.count) {
      warnings.add("Kommentare (%%…%%) werden nicht übernommen.");
      report.add("other", ct(`Kommentare (%%…%%) entfernt: ${comments.count}`, `Comments (%%…%%) removed: ${comments.count}`), path);
    }
    const dataview = dataviewQueries(body);
    if (dataview.blocks + dataview.inline) {
      warnings.add("Dataview-Abfragen werden als Code übernommen, nicht ausgeführt.");
      if (dataview.blocks) report.add("block", ct("Dataview-Abfrage als Codeblock übernommen (wird nicht ausgeführt)", "Dataview query kept as a code block (not run)"), path);
      if (dataview.inline) report.add("block", ct("Dataview-Inline-Abfrage als Code übernommen (wird nicht ausgeführt)", "Inline Dataview query kept as code (not run)"), path);
    }
    const text = highlights(body.normalize("NFC").replace(new RegExp(`^\\s*#\\s+${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\n`), ""));
    const markdown = convertWikilinks(
      text,
      lookup(path),
      () => {
        warnings.add("Eingebettete Notizen werden als Link übernommen.");
        report.add("embed", ct("Eingebettete Notiz als Link übernommen", "Embedded note kept as a link"), path);
      },
      pageRef(path),
      (target) => {
        warnings.add("Eingebettete Datei fehlt im Tresor.");
        const name = target.slice(0, 200);
        report.add(
          "file",
          isImage(mimeOf(target))
            ? ct(`Bild „${name}“ fehlt im Tresor`, `Image “${name}” is missing from the vault`)
            : ct(`Eingebettete Datei „${name}“ fehlt im Tresor`, `Embedded file “${name}” is missing from the vault`),
          path,
        );
      },
    );
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
    pages.push({ key: path, parent, title, html, ...meta, tags: noteTags(data, body), aliases: frontmatterAliases(data), properties: data });
  }
  for (const [path, canvas] of canvases) {
    const { board, problems } = canvasBoard(canvas, {
      // Notes and canvases only: lookup() takes other files along.
      page: (target) => ((NOTE.test(target) || CANVAS.test(target)) && lookup(path)(target)?.href) || null,
      file: (target) => {
        const clean = lower(target.replace(/\\/g, "/").replace(/^\.?\//, ""));
        const file = filesByPath.get(clean) || closestPath(path, filesByName.get(posix.basename(clean)));
        return file ? { name: file, data: entries.get(file)! } : null;
      },
    });
    for (const problem of problems) report.add(problem.kind, problem.detail, path);
    pages.push({ key: path, parent: folderKey(posix.dirname(path)), title: posix.basename(path).replace(CANVAS, "").normalize("NFC"), html: "", kind: "whiteboard", board });
  }
  if (!notes.length && !canvases.size) warnings.add("Keine Notizen (.md) gefunden.");
  // Obsidian Bases have no counterpart (#671).
  for (const path of paths.filter((p) => /\.base$/i.test(p))) {
    warnings.add("Obsidian-Bases (.base) werden nicht übernommen.");
    report.add("other", ct(`Obsidian-Base „${path.slice(0, 200)}“ nicht übernommen`, `Obsidian Base “${path.slice(0, 200)}” not carried over`));
  }
  const propertyTypes = inferPropertyTypes(frontmatters, obsidianTypes(entries.get(".obsidian/types.json")?.toString("utf8")));
  return { source: "obsidian", title: name, pages, files, warnings: warnings.list(), report, propertyTypes };
}
