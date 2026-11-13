import { escapeInline } from "./inline-markdown";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { posix, resolve } from "node:path";
import Papa from "papaparse";
import { id, one, onTransactionRollback, run, transaction } from "./db";
import { HttpError } from "./auth";
import { requireMember, spaceRole } from "./permissions";
import { readZip } from "./archive";
import { createPage } from "./seed";
import { htmlState } from "./document-server";
import { markdownToHtml, markdownToHtmlAsync } from "./markdown-import";
import { splitFrontmatter } from "./frontmatter";
import { frontmatterAliases, storedAliases } from "./aliases";
import { numberedInFrontmatter } from "./block-captions";
import { applyPortableMeta, canManageScope, frontmatterMeta, memberByName } from "./page-properties-server";
import { enforceQuota } from "./instance-ops";
import { enforceUserStorage } from "./user-limits";
import { boardState, storeBoardImages } from "./whiteboard-import-server";
import { writeWhiteboard } from "./whiteboard";
import { BoardImportError, parseBoardFile, type ImportedBoard } from "./whiteboard-import";
import type { Field, Identity, Space } from "./types";
import { maxImportEntries, maxImportPages, tooManyPages } from "./importers/types";
import { documentAnchors, findAnchor, pendingAnchor, resolvePendingAnchors } from "./import-anchors";
import { forEachAsync } from "./each-async";
import { cleanHtmlAsync } from "./document-server";
import { isNotionHtml, notionHtmlPage, notionOptionColors } from "./importers/notion-html";
import { colorOptions } from "./option-colors";
import type { PageTagColor } from "./page-properties";

// Imports Markdown/CSV exports (Notion, AppFlowy, Obsidian-like folders):
// every .md becomes a document, every .csv a database; a folder named like a
// page holds its subpages; files referenced from Markdown become attachments;
// Excalidraw and draw.io drawings become whiteboards. Notion's HTML export
// (#234) is read the same way: its .html pages become documents
// (lib/importers/notion-html.ts) – with toggles, callouts and colours –, the
// CSV beside a database's HTML table the database.
export const MAX_IMPORT_ROWS = 5000;
const NOTION_ID = /\s+([0-9a-f]{32})$/i;
const mimeTypes: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "text/plain",
  pdf: "application/pdf",
  txt: "text/plain",
  csv: "text/csv",
  zip: "application/zip",
};

type Node = {
  key: string; // path without extension, e.g. "Wiki abc/Seite def"
  path: string;
  kind: "document" | "database" | "whiteboard";
  title: string;
  depth: number;
};
export function exportTitle(name: string) {
  return (
    name
      .replace(/\.(md|html?|csv|excalidraw|drawio)$/i, "")
      .replace(/_all$/i, "")
      .replace(NOTION_ID, "")
      .trim() || "Ohne Titel"
  );
}
function nodeKey(path: string) {
  return path.replace(/\.(md|html?|csv|excalidraw|drawio)$/i, "").replace(/_all$/i, "");
}

// Notion puts a large export into several inner ZIP files.
async function entriesOf(bytes: Buffer) {
  // One budget for the outer ZIP and every inner one.
  const budget = { left: 512 * 1024 * 1024 };
  let entries = await readZip(bytes, { foreign: true, maxEntries: maxImportEntries(), budget });
  const names = [...entries.keys()];
  if (names.length && names.every((n) => /\.zip$/i.test(n))) {
    const merged = new Map<string, Buffer>();
    for (const inner of entries.values())
      for (const [name, data] of await readZip(inner, {
        foreign: true,
        maxEntries: maxImportEntries(),
        budget,
      }))
        merged.set(name, data);
    entries = merged;
  }
  // A single top folder around everything is not a page.
  const tops = new Set([...entries.keys()].map((n) => n.split("/")[0]));
  if (tops.size === 1) {
    const [top] = [...tops];
    if ([...entries.keys()].every((n) => n.startsWith(top + "/")))
      entries = new Map(
        [...entries].map(([n, d]) => [n.slice(top.length + 1), d]),
      );
  }
  return entries;
}

const monthNames = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
// Notion writes "September 24, 2026" (optionally with a time) or ISO dates.
export function importDate(value: string): string | null {
  const iso = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?/.exec(value);
  if (iso) return iso[1];
  const long = /^([A-Za-z]+) (\d{1,2}), (\d{4})/.exec(value);
  if (long) {
    const month = monthNames.indexOf(long[1].toLowerCase());
    if (month >= 0)
      return `${long[3]}-${String(month + 1).padStart(2, "0")}-${long[2].padStart(2, "0")}`;
  }
  return null;
}
export function inferField(
  name: string,
  values: string[],
  index: number,
): Field {
  const fid = index === 0 ? "title" : `f${index}`;
  const filled = values.map((v) => v.trim()).filter(Boolean);
  if (index === 0 || !filled.length) return { id: fid, name, type: "text" };
  if (filled.every((v) => /^-?\d+(?:[.,]\d+)?$/.test(v)))
    return { id: fid, name, type: "number" };
  if (filled.every((v) => /^(yes|no|ja|nein|true|false)$/i.test(v)))
    return { id: fid, name, type: "checkbox" };
  if (filled.every((v) => importDate(v)))
    return { id: fid, name, type: "date" };
  const distinct = [...new Set(filled)];
  if (distinct.length <= 12 && filled.length >= distinct.length * 2)
    return { id: fid, name, type: "select", options: distinct.slice(0, 100) };
  return { id: fid, name, type: "text" };
}
function cellValue(field: Field, raw: string) {
  const value = raw.trim();
  if (!value) return field.type === "checkbox" ? false : null;
  if (field.type === "number") return Number(value.replace(",", "."));
  if (field.type === "checkbox") return /^(yes|ja|true)$/i.test(value);
  if (field.type === "date") return importDate(value);
  // A CSV is plain text: formatted text properties (#126, every text
  // property but the title) keep "*" and "_" as written.
  if (field.type === "text" && field.id !== "title") return escapeInline(value.slice(0, 10000));
  return value.slice(0, 10000);
}
// Row pages repeat the properties as "Name: value" lines below the title.
function rowBody(markdown: string) {
  const lines = markdown.replace(/^﻿/, "").split("\n");
  let i = 0;
  if (/^#\s/.test(lines[0] || "")) i++;
  while (i < lines.length && !lines[i].trim()) i++;
  while (i < lines.length && /^[^:\n]{1,100}: /.test(lines[i])) i++;
  return lines.slice(i).join("\n").trim();
}

// Day files of journals in a Flowplan export: <journal folder>/YYYY/MM/
// YYYY-MM-DD.md below a Markdown page (the journal: <folder>/index.md or
// <folder>.md). The heading is the day's title; a second file of the same
// journal and date is left out instead of becoming another day.
function flowplanDays(nodes: Map<string, Node>, text: (path: string) => string) {
  const days = new Map<string, { journal: string; date: string; title: string; skip?: boolean }>();
  const seen = new Set<string>();
  for (const node of [...nodes.values()].sort((a, b) => a.key.localeCompare(b.key))) {
    if (node.kind !== "document") continue;
    const match = /^(?:(.*)\/)?(\d{4})\/(\d{2})\/((\d{4})-(\d{2})-(\d{2}))$/.exec(node.key);
    if (!match || match[2] !== match[5] || match[3] !== match[6]) continue;
    const date = match[4];
    if (new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) continue;
    const folder = match[1] || "";
    const journal = [folder, folder ? `${folder}/index` : "index"].find((key) => key && nodes.get(key)?.kind === "document");
    if (!journal) continue;
    const heading = /^#\s+([^\n]+)/m.exec(splitFrontmatter(text(node.path)).body)?.[1]?.trim();
    const key = `${journal}\u0000${date}`;
    days.set(node.key, { journal, date, title: (heading || date).slice(0, 500), skip: seen.has(key) });
    seen.add(key);
  }
  return days;
}

// Flowplan's own Markdown export (lib/markdown-export.ts; README.txt and
// index.md at the top). A page export: index.md is the page, pages/ holds
// every page below it side by side, with "## Unterseiten" lists naming each
// page's children; a database is pages/<title>-<id>.md plus tables/<id>.csv
// and its record documents records/<id>/*.md. A space export holds one such
// folder (<title>-<id>/) per top-level page and an index.md listing them.
// Returns each page's parent and title from that structure, the records of
// each database, and leaves out what is no page (the space's list, comments
// and versions of the history option).
const SUBPAGES = /\n+## (?:Unterseiten|Sub-pages)\n([\s\S]*)$/;
function flowplanLayout(entries: Map<string, Buffer>, nodes: Map<string, Node>, text: (path: string) => string) {
  if (!entries.has("index.md") || !/^﻿?Flowplan Markdown/.test(entries.get("README.txt")?.toString("utf8") || "")) return null;
  const units = [...nodes.keys()].filter((key) => /^[^/]+\/index$/.test(key)).map((key) => key.slice(0, -"index".length));
  // A space export: the space's own list is no page.
  if (units.length) nodes.delete("index");
  else units.push("");
  const unitOf = (key: string) => units.find((unit) => key.startsWith(unit));
  const parents = new Map<string, string>(),
    records = new Map<string, string[]>(),
    recordTitles = new Map<string, string>(),
    databases = new Map<string, string>(),
    // Record documents: their "## Unterseiten" lists name their sub-pages (#231).
    recordNodes = new Map<string, string>();
  const heading = (path: string | null) => (path ? /^#\s+([^\n]+)/m.exec(splitFrontmatter(text(path)).body)?.[1]?.trim() : undefined);
  // A database's own Markdown file once its CSV took its place.
  const markdownOf = (node: Node) => (/\.md$/i.test(node.path) ? node.path : entries.has(`${node.key}.md`) ? `${node.key}.md` : null);
  for (const node of [...nodes.values()]) {
    const unit = unitOf(node.key);
    if (unit === undefined || /\.comments$|\.versions\//.test(node.key)) {
      if (unit !== undefined) nodes.delete(node.key);
      continue;
    }
    const rest = node.key.slice(unit.length);
    // tables/<id>.csv: the database of pages/<title>-<id>.md, or of index.md.
    const table = /^tables\/([0-9a-f-]{36})$/.exec(rest);
    if (table && node.kind === "database") {
      nodes.delete(node.key);
      const page = [...nodes.values()].find((n) => n.kind === "document" && n.key.startsWith(`${unit}pages/`) && n.key.endsWith(`-${table[1]}`)) || nodes.get(`${unit}index`);
      if (page && !databases.has(page.key)) {
        Object.assign(page, { kind: "database", path: node.path });
        databases.set(page.key, table[1]);
      }
      continue;
    }
    const record = /^records\/([0-9a-f-]{36})\/[^/]+$/.exec(rest);
    if (record && node.kind === "document") {
      nodes.delete(node.key);
      recordNodes.set(node.key, node.path);
      const list = records.get(`${unit}\u0000${record[1]}`) || [];
      list.push(node.key);
      records.set(`${unit}\u0000${record[1]}`, list);
      const data = splitFrontmatter(text(node.path)).data as Record<string, unknown>;
      recordTitles.set(node.key, typeof data.title === "string" ? data.title : heading(node.path) || "");
      continue;
    }
    const title = heading(markdownOf(node));
    if (title) node.title = title.slice(0, 500);
    else if (rest.startsWith("pages/")) node.title = node.title.replace(/-[0-9a-f-]{36}$/, "") || node.title;
  }
  // Parents from the "## Unterseiten" lists.
  const ancestor = (key: string, of: string) => {
    for (let at: string | undefined = key; at; at = parents.get(at)) if (at === of) return true;
    return false;
  };
  for (const node of [...nodes.values(), ...[...recordNodes].map(([key, path]) => ({ key, path, kind: "document" as const }))]) {
    const markdown = recordNodes.has(node.key) ? node.path : markdownOf(node as Node);
    const list = (markdown && SUBPAGES.exec(text(markdown))?.[1]) || "";
    for (const link of list.matchAll(/^- \[[^\n]*\]\(<?([^>\n)]+\.md)>?\)$/gm)) {
      let target: string;
      try {
        target = nodeKey(posix.normalize(posix.join(posix.dirname(node.key), decodeURIComponent(link[1]))));
      } catch {
        continue;
      }
      if (target !== node.key && nodes.has(target) && !parents.has(target) && !ancestor(node.key, target)) parents.set(target, node.key);
    }
  }
  const rowPages = new Map<string, string[]>();
  for (const [key, dbId] of databases) rowPages.set(key, records.get(`${unitOf(key)}\u0000${dbId}`) || []);
  return { parents, rowPages, recordTitles };
}

export async function importZip(
  user: Identity,
  workspaceId: string,
  spaceId: string,
  bytes: Buffer,
) {
  await requireMember(user, workspaceId, "editor");
  const space = await one<Space>(
    "SELECT * FROM spaces WHERE id=? AND workspace_id=? AND deleted_at IS NULL",
    spaceId,
    workspaceId,
  );
  if (!space || !["editor", "owner"].includes(await spaceRole(user, space) || ""))
    throw new HttpError(403, "Keine Schreibrechte im Zielbereich.");
  const entries = await entriesOf(bytes);
  // An Obsidian vault (its settings folder): wikilinks, embeds, folder
  // notes and tags need the vault importer (lib/importers/obsidian.ts).
  if ([...entries.keys()].some((name) => name.startsWith(".obsidian/"))) {
    const { parseObsidian } = await import("./importers/obsidian");
    const { writeImport } = await import("./importers/write");
    const result = await writeImport(user, workspaceId, spaceId, parseObsidian(entries));
    return { rootIds: result.rootIds, pages: result.pages + result.folders, rows: 0, files: result.files };
  }
  // Notion exports "Name.csv" (current view) and "Name_all.csv" (all rows).
  // HTML pages count where they are Notion's, or where the ZIP has no
  // Markdown at all; a database's HTML table gives way to its CSV.
  const nodes = new Map<string, Node>();
  const withMarkdown = [...entries.keys()].some((path) => /\.md$/i.test(path));
  const isHtml = (path: string) => /\.html?$/i.test(path);
  for (const path of entries.keys()) {
    const kind = /\.md$/i.test(path)
      ? "document"
      : isHtml(path)
        ? !withMarkdown || isNotionHtml(entries.get(path)!.subarray(0, 64 * 1024).toString("utf8"))
          ? "document"
          : null
        : /\.csv$/i.test(path)
          ? "database"
          : /\.(excalidraw|drawio)$/i.test(path)
            ? "whiteboard"
            : null;
    if (!kind) continue;
    const key = nodeKey(path);
    const existing = nodes.get(key);
    const replaces = existing && ((kind === "database" && (/_all\.csv$/i.test(path) || isHtml(existing.path))) || (kind === "document" && !isHtml(path) && isHtml(existing.path)));
    if (existing && !replaces)
      continue;
    nodes.set(key, {
      key,
      path,
      kind,
      title: exportTitle(posix.basename(path)),
      depth: key.split("/").length,
    });
  }
  const text = (path: string) =>
    entries.get(path)!.toString("utf8").replace(/^﻿/, "");
  // Notion's HTML pages, read once: their title and content.
  const htmlPages = new Map<string, ReturnType<typeof notionHtmlPage>>();
  const htmlPage = (path: string) => {
    if (!htmlPages.has(path)) htmlPages.set(path, notionHtmlPage(text(path)));
    return htmlPages.get(path)!;
  };
  for (const node of nodes.values())
    if (node.kind === "document" && isHtml(node.path)) node.title = (htmlPage(node.path).title || node.title).slice(0, 500);
  // The file of each document (record pages leave the list of nodes below).
  const documentPath = new Map([...nodes.values()].filter((node) => node.kind === "document").map((node) => [node.key, node.path]));
  const layout = flowplanLayout(entries, nodes, text);
  // Markdown pages inside a database folder are its records.
  const rowPages = new Map<string, string[]>(layout?.rowPages);
  for (const node of [...nodes.values()]) {
    const parent = nodes.get(posix.dirname(node.key));
    if (node.kind === "document" && parent?.kind === "database") {
      rowPages.set(parent.key, [...(rowPages.get(parent.key) || []), node.key]);
      nodes.delete(node.key);
    }
  }
  // The pages of a record (#231): Notion puts them in a folder named like
  // the record page, next to it in the database's folder (a Flowplan
  // export lists them in the record's document). They go below the record
  // – created below its database, placed under the record once it exists.
  const recordDatabase = new Map<string, string>();
  for (const [database, keys] of rowPages) for (const key of keys) recordDatabase.set(key, database);
  if (!nodes.size)
    throw new HttpError(
      400,
      "Die ZIP-Datei enthält keine Markdown-, CSV-, Excalidraw- oder draw.io-Dateien.",
    );
  // The same page limit as the other importers (#82).
  if (nodes.size > maxImportPages()) throw new HttpError(413, tooManyPages(nodes.size));
  // Journals of a Flowplan export (#49): days at <journal folder>/2026/10/
  // 2026-10-27.md become the days of that journal again, one per date.
  const days = flowplanDays(nodes, text);
  for (const [key, day] of days) if (day.skip) nodes.delete(key);
  // A page's parent: a journal for its days, in a Flowplan export the page
  // whose list names it, otherwise the page of its folder.
  const folderKey = (key: string) => days.get(key)?.journal ?? layout?.parents.get(key) ?? posix.dirname(key);
  // Below a record: its database is the page's parent.
  const parentKey = (key: string) => recordDatabase.get(folderKey(key)) ?? folderKey(key);
  const recordOf = (key: string) => (recordDatabase.has(folderKey(key)) ? folderKey(key) : undefined);
  if (layout)
    for (const node of nodes.values()) {
      node.depth = 1;
      for (let at = parentKey(node.key); nodes.has(at) && node.depth <= nodes.size; at = parentKey(at)) node.depth++;
    }
  const withSubpages = new Set(layout ? [...nodes.keys()].map(parentKey) : []);
  // Drawings are read before anything is written; one that cannot be read
  // becomes a board with a note saying why.
  const boards = new Map<string, ImportedBoard>();
  for (const node of nodes.values())
    if (node.kind === "whiteboard")
      try {
        boards.set(node.key, await parseBoardFile(node.path, text(node.path)));
      } catch (error) {
        if (!(error instanceof BoardImportError)) throw error;
        boards.set(node.key, {
          format: /\.drawio$/i.test(node.path) ? "drawio" : "excalidraw",
          images: [],
          replaced: 1,
          items: [{ id: "n", type: "sticky", x: 0, y: 0, w: 320, h: 160, text: `${posix.basename(node.path)}: ${error.message}`, fill: "#ffc9c9", fontSize: 14 }],
        });
      }
  const journals = new Set([...days.values()].filter((d) => !d.skip).map((d) => d.journal));
  return await transaction(async () => {
    const pageIds = new Map<string, string>();
    const ordered = [...nodes.values()].sort(
      (a, b) => a.depth - b.depth || a.key.localeCompare(b.key, "de"),
    );
    for (const node of ordered) {
      const day = days.get(node.key);
      const parent = pageIds.get(parentKey(node.key)) || null;
      const created = await createPage(
        workspaceId,
        spaceId,
        user.id,
        day ? day.title : node.title,
        journals.has(node.key) ? "journal" : node.kind,
        parent,
      );
      if (day && parent)
        await run(
          "UPDATE pages SET journal_date=?,icon='day',position=? WHERE id=?",
          day.date,
          -Number(day.date.replaceAll("-", "")),
          created,
        );
      pageIds.set(node.key, created);
    }
    const dir = resolve(process.env.FLOWPLAN_DATA_DIR || "./data", "uploads");
    const uploaded = new Map<string, string>();
    let bytesAdded = 0;
    // Notion links to its pages (and their blocks) by the id at the end of
    // a file name: https://www.notion.so/Title-<id>#<block>.
    const notionPages = new Map<string, string>();
    for (const node of ordered) {
      const match = NOTION_ID.exec(posix.basename(node.key));
      if (match && !notionPages.has(match[1].toLowerCase())) notionPages.set(match[1].toLowerCase(), pageIds.get(node.key)!);
    }
    // Resolves a Markdown link relative to its file inside the export.
    // Links to a block or heading (other.md#^id, other.md#Heading, #Heading
    // on the same page; #88) wait for the targets' ids (resolvePendingAnchors).
    const resolver =
      (from: string, pageId: string, self?: string) =>
      async (href: string, kind: "link" | "image") => {
        const notion = kind === "link" ? /^https?:\/\/(?:www\.)?notion\.so\/[^?#\s]*?([0-9a-f]{32})(?:\?[^#\s]*)?(?:#([0-9a-f]{32}))?$/i.exec(href) : null;
        const notionPage = notion && notionPages.get(notion[1].toLowerCase());
        if (notionPage) return notion![2] ? pendingAnchor(`/#page=${notionPage}`, notion![2]) : `/#page=${notionPage}`;
        if (/^(https?:|mailto:)/i.test(href)) return href;
        if (href.startsWith("#") && self && kind === "link" && href.length > 1) return pendingAnchor(`/#page=${self}`, href.slice(1));
        if (/^[a-z]+:/i.test(href) || href.startsWith("#")) return null;
        const fragment = href.includes("#") ? href.slice(href.indexOf("#") + 1) : "";
        let target: string;
        try {
          target = posix.normalize(
            posix.join(
              posix.dirname(from),
              decodeURIComponent(href.split("#")[0]),
            ),
          );
        } catch {
          return null;
        }
        const page = pageIds.get(nodeKey(target));
        if (page && kind === "link") return fragment ? pendingAnchor(`/#page=${page}`, fragment) : `/#page=${page}`;
        const data = entries.get(target);
        if (!data || /\.(md|csv)$/i.test(target)) return null;
        if (uploaded.has(target)) return uploaded.get(target)!;
        const fid = id(),
          ext = target.split(".").pop()!.toLowerCase();
        bytesAdded += data.length;
        await enforceQuota(workspaceId, bytesAdded);
        await enforceUserStorage(user, bytesAdded, workspaceId);
        mkdirSync(dir, { recursive: true });
        writeFileSync(resolve(dir, fid), data);
        onTransactionRollback(() => unlinkSync(resolve(dir, fid)));
        await run(
          "INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)",
          fid,
          pageId,
          posix.basename(target).slice(0, 200),
          mimeTypes[ext] || "application/octet-stream",
          data.length,
          user.id,
        );
        const url = `/api/files/${fid}`;
        uploaded.set(target, url);
        return url;
      };
    // A Notion HTML page: its links and images resolved like Markdown's,
    // the result sanitised; what cannot be resolved loses its address.
    const htmlDocument = (path: string, pageId: string, self?: string) => {
      const resolve = resolver(path, pageId, self);
      return cleanHtmlAsync(htmlPage(path).html, async (tagName, attribs) => {
        const key = tagName === "a" ? "href" : tagName === "img" ? "src" : null;
        if (!key || !attribs[key]) return { tagName, attribs };
        const target = await resolve(attribs[key], tagName === "a" ? "link" : "image");
        const { [key]: _dropped, ...rest } = attribs;
        return { tagName, attribs: target ? { ...rest, [key]: target } : rest };
      });
    };
    const manageProperties = await canManageScope(user, workspaceId, spaceId),
      people = await memberByName(workspaceId);
    let rowCount = 0,
      boardImages = 0;
    const anchors = new Map<string, Map<string, string>>();
    const documents: { pid: string; html: string }[] = [];
    const recordDocs: { rid: string; html: string }[] = [];
    // The record made of each record page (for the pages below it).
    const recordIds = new Map<string, string>();
    const imageBytes = { bytes: 0 };
    for (const node of ordered) {
      const pid = pageIds.get(node.key)!;
      if (node.kind === "whiteboard") {
        imageBytes.bytes = bytesAdded;
        const urls = await storeBoardImages(user, pid, workspaceId, boards.get(node.key)!, imageBytes);
        bytesAdded = imageBytes.bytes;
        boardImages += urls.size;
        await writeWhiteboard(pid, boardState(boards.get(node.key)!, urls));
        continue;
      }
      if (node.kind === "document" && isHtml(node.path)) {
        const converted = documentAnchors(await htmlDocument(node.path, pid, pid), node.title, false);
        anchors.set(pid, converted.anchors);
        documents.push({ pid, html: converted.html });
        continue;
      }
      if (node.kind === "document") {
        // Obsidian aliases in the frontmatter become the page's aliases; a
        // frontmatter with nothing else (as Flowplan exports it) is dropped.
        const { data, body: rest } = splitFrontmatter(text(node.path));
        const aliases = frontmatterAliases(data);
        if (aliases.length) await run("UPDATE pages SET aliases=? WHERE id=?", storedAliases(aliases), pid);
        if (numberedInFrontmatter(data)) await run("UPDATE pages SET caption_numbers=1 WHERE id=?", pid);
        // Tags and properties (#70): known properties by name; other keys
        // become properties when the person manages them.
        const { meta, consumed } = await frontmatterMeta(data, workspaceId, people, { createDefinitions: manageProperties, spaceId });
        await applyPortableMeta(user, { id: pid, workspace_id: workspaceId, space_id: spaceId }, meta, { createDefinitions: manageProperties });
        // Flowplan's own keys (a journal day's id and date) go too.
        const taken = new Set(consumed.map((key) => key.trim().toLowerCase()));
        const keys = Object.keys(data).map((key) => key.trim().toLowerCase());
        const onlyAliases =
          (aliases.length || keys.includes("flowplan") || taken.size > 0) && keys.every((key) => ["aliases", "alias", "flowplan"].includes(key) || taken.has(key));
        // The first heading repeats the page title.
        let body = (onlyAliases ? rest.replace(/^\s*\n/, "") : text(node.path)).replace(/^#\s+[^\n]*\n?/, "");
        // A journal lists its days below; they are its days again.
        // So does a page of a Flowplan export its subpages.
        if (journals.has(node.key) || withSubpages.has(node.key)) body = body.replace(/\n+## (Unterseiten|Sub-pages)\n[\s\S]*$/, "\n");
        // Stored once all documents are read (block links, #88).
        const converted = documentAnchors(await markdownToHtmlAsync(body, resolver(node.path, pid, pid)), node.title, false);
        anchors.set(pid, converted.anchors);
        documents.push({ pid, html: converted.html });
        continue;
      }
      const parsed = Papa.parse<string[]>(text(node.path), {
        skipEmptyLines: true,
      });
      const [header = ["Name"], ...records] = parsed.data;
      if (records.length > MAX_IMPORT_ROWS)
        throw new HttpError(
          413,
          `Maximal ${MAX_IMPORT_ROWS} Einträge je Tabelle.`,
        );
      rowCount += records.length;
      const fields = header.slice(0, 80).map((name, i) =>
        inferField(
          (name || `Spalte ${i + 1}`).slice(0, 200),
          records.map((r) => r[i] || ""),
          i,
        ),
      );
      // Option colours (#242): Notion's HTML export has them on the
      // database's table and its record pages; otherwise in turn.
      const htmlSources = [
        ...[...entries.keys()].filter((path) => isHtml(path) && nodeKey(path) === node.key),
        ...(rowPages.get(node.key) || []).map((key) => documentPath.get(key) || "").filter(isHtml),
      ];
      const notionColors = new Map<string, Map<string, PageTagColor>>();
      for (const path of htmlSources) if (entries.has(path)) notionOptionColors(text(path), notionColors);
      for (const f of fields) {
        const colors = notionColors.get(f.name);
        if (f.type === "select" && colors)
          f.optionColors = Object.fromEntries((f.options || []).flatMap((o) => (colors.has(o) ? [[o, colors.get(o)!]] : [])));
      }
      colorOptions(fields);
      // Default views may refer to default properties; start with a table.
      await run(
        "UPDATE databases SET fields=?,views=? WHERE page_id=?",
        JSON.stringify(fields),
        JSON.stringify([
          { id: id(), name: "Tabelle", type: "table", filters: [], sorts: [] },
        ]),
        pid,
      );
      // Record pages are matched by title in order of appearance.
      const pagesByTitle = new Map<string, string[]>();
      for (const key of rowPages.get(node.key) || []) {
        const path = documentPath.get(key);
        const title = layout?.recordTitles.get(key) ?? (path && isHtml(path) ? htmlPage(path).title : null) ?? exportTitle(posix.basename(key));
        pagesByTitle.set(title, [...(pagesByTitle.get(title) || []), key]);
      }
      await forEachAsync(records, async (record, i) => {
        const cells = Object.fromEntries(
          fields.map((f, j) => [f.id, cellValue(f, record[j] || "")]),
        );
        const title = String(cells.title || "");
        const pageKey = pagesByTitle.get(title)?.shift();
        // Flowplan's record documents: properties in the frontmatter (and
        // the CSV), the text below the heading.
        // A Notion HTML record page: its body (the properties are above it).
        const path = pageKey ? documentPath.get(pageKey) || `${pageKey}.md` : "";
        const markdown = !pageKey || isHtml(path)
          ? ""
          : layout
            ? splitFrontmatter(text(path)).body.replace(/^\s*#\s[^\n]*\n?/, "").replace(SUBPAGES, "\n").trim()
            : rowBody(text(path));
        const html = pageKey && isHtml(path)
          ? htmlPage(path).html.trim() ? await htmlDocument(path, pid) : ""
          : markdown
            ? await markdownToHtmlAsync(markdown, resolver(path, pid))
            : "";
        const rid = id();
        if (pageKey) recordIds.set(pageKey, rid);
        await run(
          "INSERT INTO rows(id,page_id,cells,position,created_by,updated_by,content) VALUES(?,?,?,?,?,?,?)",
          rid,
          pid,
          JSON.stringify(cells),
          i,
          user.id,
          user.id,
          html,
        );
        if (html) recordDocs.push({ rid, html });
      });
    }
    // Pages of records below their record (#231); one whose record page
    // matched no row of the table stays below the database.
    for (const node of ordered) {
      const record = recordOf(node.key);
      const rid = record && recordIds.get(record);
      if (rid) await run("UPDATE pages SET parent_row_id=? WHERE id=?", rid, pageIds.get(node.key)!);
    }
    // Links to blocks and headings, now that every document has its ids.
    const lookup = (pageId: string, anchor: string) => findAnchor(anchors.get(pageId), anchor);
    for (const doc of documents) {
      const html = resolvePendingAnchors(doc.html, lookup);
      await run("UPDATE documents SET html=?,state=? WHERE page_id=?", html, htmlState(html), doc.pid);
    }
    for (const record of recordDocs) {
      const html = resolvePendingAnchors(record.html, lookup);
      if (html !== record.html) await run("UPDATE rows SET content=? WHERE id=?", html, record.rid);
      await run("INSERT INTO row_documents(row_id,state,html,generation) VALUES(?,?,?,?)", record.rid, htmlState(html), html, id());
    }
    return {
      rootIds: ordered
        .filter((n) => !pageIds.has(parentKey(n.key)))
        .map((n) => pageIds.get(n.key)!),
      pages: ordered.length,
      rows: rowCount,
      files: uploaded.size + boardImages,
    };
  }, user);
}
