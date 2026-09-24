import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { posix, resolve } from "node:path";
import Papa from "papaparse";
import { id, one, onTransactionRollback, run, transaction } from "./db";
import { HttpError } from "./auth";
import { requireMember, spaceRole } from "./permissions";
import { readZip } from "./archive";
import { createPage } from "./seed";
import { htmlState } from "./document-server";
import { markdownToHtml } from "./markdown-import";
import { enforceQuota } from "./instance-ops";
import type { Field, Identity, Space } from "./types";

// Imports Markdown/CSV exports (Notion, AppFlowy, Obsidian-like folders):
// every .md becomes a document, every .csv a database; a folder named like a
// page holds its subpages; files referenced from Markdown become attachments.
export const MAX_IMPORT_PAGES = 500;
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
  kind: "document" | "database";
  title: string;
  depth: number;
};
export function exportTitle(name: string) {
  return (
    name
      .replace(/\.(md|csv)$/i, "")
      .replace(/_all$/i, "")
      .replace(NOTION_ID, "")
      .trim() || "Ohne Titel"
  );
}
function nodeKey(path: string) {
  return path.replace(/\.(md|csv)$/i, "").replace(/_all$/i, "");
}

// Notion puts a large export into several inner ZIP files.
async function entriesOf(bytes: Buffer) {
  let entries = await readZip(bytes, { foreign: true, maxEntries: 5000 });
  const names = [...entries.keys()];
  if (names.length && names.every((n) => /\.zip$/i.test(n))) {
    const merged = new Map<string, Buffer>();
    for (const inner of entries.values())
      for (const [name, data] of await readZip(inner, {
        foreign: true,
        maxEntries: 5000,
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

export async function importZip(
  user: Identity,
  workspaceId: string,
  spaceId: string,
  bytes: Buffer,
) {
  requireMember(user, workspaceId, "editor");
  const space = one<Space>(
    "SELECT * FROM spaces WHERE id=? AND workspace_id=? AND deleted_at IS NULL",
    spaceId,
    workspaceId,
  );
  if (!space || !["editor", "owner"].includes(spaceRole(user, space) || ""))
    throw new HttpError(403, "Keine Schreibrechte im Zielbereich.");
  const entries = await entriesOf(bytes);
  // Notion exports "Name.csv" (current view) and "Name_all.csv" (all rows).
  const nodes = new Map<string, Node>();
  for (const path of entries.keys()) {
    const kind = /\.md$/i.test(path)
      ? "document"
      : /\.csv$/i.test(path)
        ? "database"
        : null;
    if (!kind) continue;
    const key = nodeKey(path);
    const existing = nodes.get(key);
    if (existing && !(kind === "database" && /_all\.csv$/i.test(path)))
      continue;
    nodes.set(key, {
      key,
      path,
      kind,
      title: exportTitle(posix.basename(path)),
      depth: key.split("/").length,
    });
  }
  // Markdown pages inside a database folder are its records.
  const rowPages = new Map<string, string[]>();
  for (const node of [...nodes.values()]) {
    const parent = nodes.get(posix.dirname(node.key));
    if (node.kind === "document" && parent?.kind === "database") {
      rowPages.set(parent.key, [...(rowPages.get(parent.key) || []), node.key]);
      nodes.delete(node.key);
    }
  }
  if (!nodes.size)
    throw new HttpError(
      400,
      "Die ZIP-Datei enthält keine Markdown- oder CSV-Dateien.",
    );
  if (nodes.size > MAX_IMPORT_PAGES)
    throw new HttpError(413, `Maximal ${MAX_IMPORT_PAGES} Seiten je Import.`);
  const text = (path: string) =>
    entries.get(path)!.toString("utf8").replace(/^﻿/, "");
  return transaction(() => {
    const pageIds = new Map<string, string>();
    const ordered = [...nodes.values()].sort(
      (a, b) => a.depth - b.depth || a.key.localeCompare(b.key, "de"),
    );
    for (const node of ordered) {
      const parent = pageIds.get(posix.dirname(node.key)) || null;
      pageIds.set(
        node.key,
        createPage(
          workspaceId,
          spaceId,
          user.id,
          node.title,
          node.kind,
          parent,
        ),
      );
    }
    const dir = resolve(process.env.FLOWPLAN_DATA_DIR || "./data", "uploads");
    const uploaded = new Map<string, string>();
    let bytesAdded = 0;
    // Resolves a Markdown link relative to its file inside the export.
    const resolver =
      (from: string, pageId: string) =>
      (href: string, kind: "link" | "image") => {
        if (/^(https?:|mailto:)/i.test(href)) return href;
        if (/^[a-z]+:/i.test(href) || href.startsWith("#")) return null;
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
        if (page && kind === "link") return `/#page=${page}`;
        const data = entries.get(target);
        if (!data || /\.(md|csv)$/i.test(target)) return null;
        if (uploaded.has(target)) return uploaded.get(target)!;
        const fid = id(),
          ext = target.split(".").pop()!.toLowerCase();
        bytesAdded += data.length;
        enforceQuota(workspaceId, bytesAdded);
        mkdirSync(dir, { recursive: true });
        writeFileSync(resolve(dir, fid), data);
        onTransactionRollback(() => unlinkSync(resolve(dir, fid)));
        run(
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
    let rowCount = 0;
    for (const node of ordered) {
      const pid = pageIds.get(node.key)!;
      if (node.kind === "document") {
        // The first heading repeats the page title.
        const body = text(node.path).replace(/^#\s+[^\n]*\n?/, "");
        const html = markdownToHtml(body, resolver(node.path, pid));
        run(
          "UPDATE documents SET html=?,state=? WHERE page_id=?",
          html,
          htmlState(html),
          pid,
        );
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
      // Default views may refer to default properties; start with a table.
      run(
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
        const title = exportTitle(posix.basename(key));
        pagesByTitle.set(title, [...(pagesByTitle.get(title) || []), key]);
      }
      records.forEach((record, i) => {
        const cells = Object.fromEntries(
          fields.map((f, j) => [f.id, cellValue(f, record[j] || "")]),
        );
        const title = String(cells.title || "");
        const pageKey = pagesByTitle.get(title)?.shift();
        const markdown = pageKey ? rowBody(text(`${pageKey}.md`)) : "";
        const html = markdown
          ? markdownToHtml(markdown, resolver(`${pageKey}.md`, pid))
          : "";
        const rid = id();
        run(
          "INSERT INTO rows(id,page_id,cells,position,created_by,updated_by,content) VALUES(?,?,?,?,?,?,?)",
          rid,
          pid,
          JSON.stringify(cells),
          i,
          user.id,
          user.id,
          html,
        );
        if (html)
          run(
            "INSERT INTO row_documents(row_id,state,html,generation) VALUES(?,?,?,?)",
            rid,
            htmlState(html),
            html,
            id(),
          );
      });
    }
    return {
      rootIds: ordered
        .filter((n) => !pageIds.has(posix.dirname(n.key)))
        .map((n) => pageIds.get(n.key)!),
      pages: ordered.length,
      rows: rowCount,
      files: uploaded.size,
    };
  }, user);
}
