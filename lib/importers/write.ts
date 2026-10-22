// Writes an import tree (lib/importers/types.ts) into a space: as a page
// tree (folders and notebooks become pages) or as one new database whose
// records carry title, tags, dates, folder and source link. Checks rights,
// the page limit and the storage quotas before anything is written; files
// are stored only when a page refers to them.
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { id, one, onTransactionRollback, run, transaction } from "../db";
import { HttpError } from "../auth";
import { requireMember, spaceRole } from "../permissions";
import { createPage } from "../seed";
import { cleanHtml, htmlState } from "../document-server";
import { enforceQuota } from "../instance-ops";
import { enforceUserStorage } from "../user-limits";
import { sanitizeFileName, verifiedMime } from "../upload-safety";
import { storedAliases } from "../aliases";
import { ct } from "../content-locale";
import { requirePlaintextSpace } from "../e2ee-server";
import { esc, isImage } from "./html";
import { MAX_IMPORT_PAGES, MAX_IMPORT_ROWS, type ImportPage, type ImportTree } from "./types";
import type { Field, Identity, Space } from "../types";

export type ImportMode = "pages" | "database";
export type ImportPreview = {
  source: ImportTree["source"];
  title: string;
  pages: number;
  folders: number;
  files: number;
  bytes: number;
  tags: number;
  warnings: string[];
};
export type ImportResult = ImportPreview & { rootIds: string[]; rows: number; databaseId?: string };

const PLACEHOLDER = /fp-import:\/\/(file|page)\/([^"'\s<>)]*)/g;
const decodeKey = (key: string) => {
  try {
    return decodeURIComponent(key);
  } catch {
    return key;
  }
};
// The files the pages refer to, in order of first use, with the page.
function referencedFiles(tree: ImportTree) {
  const used = new Map<string, string>();
  for (const page of tree.pages)
    for (const match of page.html.matchAll(PLACEHOLDER))
      if (match[1] === "file") {
        const key = decodeKey(match[2]);
        if (tree.files.has(key) && !used.has(key)) used.set(key, page.key);
      }
  return used;
}

export function requireSpace(user: Identity, workspaceId: string, spaceId: string) {
  requireMember(user, workspaceId, "editor");
  const space = one<Space>("SELECT * FROM spaces WHERE id=? AND workspace_id=? AND deleted_at IS NULL", spaceId, workspaceId);
  if (!space || !["editor", "owner"].includes(spaceRole(user, space) || "")) throw new HttpError(403, "Keine Schreibrechte im Zielbereich.");
  // End-to-end encrypted spaces never take plaintext from the server.
  requirePlaintextSpace(space);
}

export function previewImport(user: Identity, workspaceId: string, spaceId: string, tree: ImportTree, mode: ImportMode = "pages"): ImportPreview {
  requireSpace(user, workspaceId, spaceId);
  const used = referencedFiles(tree);
  const bytes = [...used.keys()].reduce((sum, key) => sum + tree.files.get(key)!.data.length, 0);
  const warnings = [...tree.warnings];
  const unused = tree.files.size - used.size;
  if (unused > 0) warnings.push(`${unused} Dateien werden von keiner Seite verwendet und nicht übernommen.`);
  const notes = tree.pages.filter((p) => !p.folder).length;
  const count = mode === "database" ? notes : tree.pages.length;
  const limit = mode === "database" ? MAX_IMPORT_ROWS : MAX_IMPORT_PAGES;
  if (count > limit) warnings.push(mode === "database" ? `Maximal ${MAX_IMPORT_ROWS} Einträge je Import.` : `Maximal ${MAX_IMPORT_PAGES} Seiten je Import.`);
  try {
    enforceQuota(workspaceId, bytes);
    enforceUserStorage(user, bytes);
  } catch (error) {
    if (error instanceof HttpError) warnings.push(error.message);
    else throw error;
  }
  return {
    source: tree.source,
    title: tree.title,
    pages: notes,
    folders: tree.pages.length - notes,
    files: used.size,
    bytes,
    tags: new Set(tree.pages.flatMap((p) => p.tags || [])).size,
    warnings,
  };
}

const sqlTime = (iso?: string) => (iso ? iso.replace("T", " ").replace(/\.\d+Z?$|Z$/, "").slice(0, 19) : null);
const day = (iso?: string) => (iso ? iso.slice(0, 10) : null);

export function writeImport(user: Identity, workspaceId: string, spaceId: string, tree: ImportTree, mode: ImportMode = "pages"): ImportResult {
  const preview = previewImport(user, workspaceId, spaceId, tree, mode);
  if (!tree.pages.length) throw new HttpError(400, "In der Datei wurden keine Seiten gefunden.");
  if (mode === "database" ? preview.pages > MAX_IMPORT_ROWS : tree.pages.length > MAX_IMPORT_PAGES)
    throw new HttpError(413, mode === "database" ? `Maximal ${MAX_IMPORT_ROWS} Einträge je Import.` : `Maximal ${MAX_IMPORT_PAGES} Seiten je Import.`);
  enforceQuota(workspaceId, preview.bytes);
  enforceUserStorage(user, preview.bytes);
  const used = referencedFiles(tree);
  const byKey = new Map(tree.pages.map((p) => [p.key, p]));
  // Parents before children; a parent outside the tree means the root.
  const depth = (page: ImportPage) => {
    let d = 0,
      parent = page.parent;
    const seen = new Set<string>();
    while (parent && byKey.has(parent) && !seen.has(parent) && d < 50) {
      seen.add(parent);
      parent = byKey.get(parent)!.parent;
      d++;
    }
    return d;
  };
  const ordered = tree.pages.map((page, index) => ({ page, index, depth: depth(page) })).sort((a, b) => a.depth - b.depth || a.index - b.index);

  return transaction(() => {
    const dir = resolve(process.env.FLOWPLAN_DATA_DIR || "./data", "uploads");
    const pageIds = new Map<string, string>();
    const rowIds = new Map<string, string>();
    let databaseId: string | undefined;
    if (mode === "database") {
      databaseId = createPage(workspaceId, spaceId, user.id, tree.title.slice(0, 200) || "Import", "database");
      for (const { page } of ordered) if (!page.folder) rowIds.set(page.key, id());
    } else
      for (const { page } of ordered) {
        const parent = page.parent ? pageIds.get(page.parent) || null : null;
        pageIds.set(page.key, createPage(workspaceId, spaceId, user.id, page.title.slice(0, 200) || ct("Ohne Titel", "Untitled"), "document", parent));
      }
    // Files: stored once, at the page that uses them first.
    const fileUrls = new Map<string, { url: string; name: string; mime: string }>();
    for (const [key, pageKey] of used) {
      const file = tree.files.get(key)!;
      const fid = id();
      const name = sanitizeFileName(file.name, "datei");
      const mime = verifiedMime(file.mime, file.data);
      mkdirSync(dir, { recursive: true });
      writeFileSync(resolve(dir, fid), file.data);
      onTransactionRollback(() => unlinkSync(resolve(dir, fid)));
      run(
        "INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)",
        fid,
        databaseId || pageIds.get(pageKey)!,
        name,
        mime,
        file.data.length,
        user.id,
      );
      fileUrls.set(key, { url: `/api/files/${fid}`, name, mime });
    }
    const pageUrl = (key: string) =>
      databaseId ? (rowIds.has(key) ? `/#page=${databaseId}&row=${rowIds.get(key)}` : null) : pageIds.has(key) ? `/#page=${pageIds.get(key)}` : null;
    const resolveHtml = (html: string) =>
      cleanHtml(
        html
          // Images of files that are no pictures become links.
          .replace(/<img\b[^>]*?\bsrc="fp-import:\/\/file\/([^"]*)"[^>]*>/g, (_, key: string) => {
            const file = fileUrls.get(decodeKey(key));
            if (!file) return "";
            return isImage(file.mime) ? `<img src="${esc(file.url)}" alt="${esc(file.name)}">` : `<a href="${esc(file.url)}">${esc(file.name)}</a>`;
          })
          .replace(/<img\b[^>]*?\bsrc="fp-import:\/\/page\/[^"]*"[^>]*>/g, "")
          .replace(/(href|src)="fp-import:\/\/(file|page)\/([^"]*)"/g, (_, name: string, kind: string, key: string) => {
            const target = kind === "file" ? fileUrls.get(decodeKey(key))?.url : pageUrl(decodeKey(key));
            return target ? `${name}="${esc(target)}"` : "";
          }),
      );
    let rows = 0;
    if (databaseId) {
      const notes = ordered.filter(({ page }) => !page.folder);
      const folderOf = (page: ImportPage) => {
        const names: string[] = [];
        let parent = page.parent;
        while (parent && byKey.has(parent) && names.length < 20) {
          names.unshift(byKey.get(parent)!.title);
          parent = byKey.get(parent)!.parent;
        }
        return names.join(" / ").slice(0, 200);
      };
      const tags = [...new Set(notes.flatMap(({ page }) => page.tags || []))].slice(0, 300);
      const folders = [...new Set(notes.map(({ page }) => folderOf(page)).filter(Boolean))].slice(0, 300);
      const fields: Field[] = [
        { id: "title", name: ct("Name", "Name"), type: "text" },
        { id: "imp_tags", name: ct("Tags", "Tags"), type: "multiselect", options: tags },
        { id: "imp_created", name: ct("Erstellt", "Created"), type: "date" },
        { id: "imp_updated", name: ct("Geändert", "Updated"), type: "date" },
        ...(folders.length ? [{ id: "imp_folder", name: ct("Ordner", "Folder"), type: "select", options: folders } as Field] : []),
        ...(notes.some(({ page }) => page.url) ? [{ id: "imp_url", name: ct("Quelle", "Source"), type: "url" } as Field] : []),
      ];
      run(
        "UPDATE databases SET fields=?,views=? WHERE page_id=?",
        JSON.stringify(fields),
        JSON.stringify([{ id: id(), name: ct("Tabelle", "Table"), type: "table", filters: [], sorts: [] }]),
        databaseId,
      );
      notes.forEach(({ page }, i) => {
        const rid = rowIds.get(page.key)!;
        const html = page.html ? resolveHtml(page.html) : "";
        const folder = folderOf(page);
        const cells = {
          title: page.title.slice(0, 1000),
          imp_tags: (page.tags || []).filter((t) => tags.includes(t)),
          ...(day(page.created) ? { imp_created: day(page.created) } : {}),
          ...(day(page.updated) ? { imp_updated: day(page.updated) } : {}),
          ...(folder && folders.includes(folder) ? { imp_folder: folder } : {}),
          ...(page.url && /^https?:\/\//i.test(page.url) ? { imp_url: page.url.slice(0, 2000) } : {}),
        };
        run(
          "INSERT INTO rows(id,page_id,cells,position,created_by,updated_by,content,created_at,updated_at) VALUES(?,?,?,?,?,?,?,COALESCE(?,CURRENT_TIMESTAMP),COALESCE(?,CURRENT_TIMESTAMP))",
          rid,
          databaseId!,
          JSON.stringify(cells),
          i,
          user.id,
          user.id,
          html,
          sqlTime(page.created),
          sqlTime(page.updated || page.created),
        );
        if (html) run("INSERT INTO row_documents(row_id,state,html,generation) VALUES(?,?,?,?)", rid, htmlState(html), html, id());
        rows++;
      });
    } else
      for (const { page } of ordered) {
        const pid = pageIds.get(page.key)!;
        const html = resolveHtml(page.html || "");
        // Tags of a page (no property to hold them) stay visible as a line.
        const tagLine = page.tags?.length ? `<p>${page.tags.map((t) => `#${esc(t)}`).join(" ")}</p>` : "";
        const source = page.url && /^https?:\/\//i.test(page.url) ? `<p><a href="${esc(page.url)}">${esc(page.url)}</a></p>` : "";
        const body = cleanHtml(tagLine + source + html);
        run("UPDATE documents SET html=?,state=? WHERE page_id=?", body, htmlState(body), pid);
        if (page.aliases?.length) run("UPDATE pages SET aliases=? WHERE id=?", storedAliases(page.aliases.slice(0, 10)), pid);
        if (page.updated) run("UPDATE pages SET updated_at=? WHERE id=?", sqlTime(page.updated), pid);
      }
    const rootIds = databaseId
      ? [databaseId]
      : ordered.filter(({ page }) => !page.parent || !pageIds.has(page.parent)).map(({ page }) => pageIds.get(page.key)!);
    return { ...preview, rootIds, rows, ...(databaseId ? { databaseId } : {}) };
  }, user);
}
