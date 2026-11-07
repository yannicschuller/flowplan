// Writes an import tree (lib/importers/types.ts) into a space: as a page
// tree (folders and notebooks become pages) or as one new database whose
// records carry title, tags, dates, folder and source link. Checks rights,
// the page limit and the storage quotas before anything is written; files
// are stored only when a page refers to them.
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { all, id, one, onTransactionRollback, run, transaction, nowText } from "../db";
import { HttpError } from "../auth";
import { isGuest, memberRole, pageRole, requireMember, spaceRole } from "../permissions";
import { createPage } from "../seed";
import { dayTitle } from "../journal";
import { journalLocked } from "../journal-extras";
import { isEncryptedPage } from "../e2ee-server";
import { appendHtmlToPage } from "../mcp";
import { boardState, storeBoardImages } from "../whiteboard-import-server";
import { writeWhiteboard } from "../whiteboard";
import { cleanHtml, htmlState } from "../document-server";
import { enforceQuota } from "../instance-ops";
import { enforceUserStorage } from "../user-limits";
import { sanitizeFileName, verifiedMime } from "../upload-safety";
import { storedAliases } from "../aliases";
import { applyPortableMeta, canManageScope, frontmatterMeta, memberByName } from "../page-properties-server";
import { ct } from "../content-locale";
import { requirePlaintextSpace } from "../e2ee-server";
import { esc, isImage, pageRef } from "./html";
import { MAX_IMPORT_ROWS, importFileData, importFileSize, maxImportPages, tooManyPages, tooManyRecords, type ImportPage, type ImportTemplate, type ImportTree } from "./types";
import { savedDatabaseTemplateSchema } from "../page-templates";
import { quotaCheckpoint } from "../instance-ops";
import { pageIconSchema } from "../page-appearance";
import { documentAnchors, findAnchor, type DocumentAnchors } from "../import-anchors";
import type { Field, Identity, Page, Space } from "../types";
import { filterAsync, forEachAsync } from "../each-async";

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
  // Only when the source has them (AFFiNE).
  whiteboards?: number;
  databases?: number;
  journalDays?: number;
  collections?: number;
  // Page properties (by name) and page icons the import sets.
  properties?: number;
  icons?: number;
  // Documents that become the content of a database record (AFFiNE, #82).
  rowDocuments?: number;
  // Documents placed below the one document linking to them (AFFiNE, #167),
  // counted whether or not that is switched on.
  linkedBelow?: number;
  // Templates of the source saved as templates (AFFiNE, #116), and for whom.
  templates?: number;
  templateVisibility?: "workspace" | "private";
  // The title of the page everything lands below, when there is one.
  wrapper?: string;
  // More pages (records) than one import may bring: the import is refused.
  tooMany?: boolean;
};
export type ImportResult = ImportPreview & { rootIds: string[]; rows: number; databaseId?: string };
const special = (page: ImportPage) => page.kind === "whiteboard" || page.kind === "database";
// The pages a mode writes: databases and whiteboards only as pages; a
// document that is a record's content (#82) only in database mode, where
// databases are left out.
const pagesFor = (tree: ImportTree, mode: ImportMode) => tree.pages.filter((p) => (mode === "database" ? !special(p) : !p.inRecord));

const PLACEHOLDER = /fp-import:\/\/(file|page)\/([^"'\s<>)]*)/g;
const decodeKey = (key: string) => {
  try {
    return decodeURIComponent(key);
  } catch {
    return key;
  }
};
// The files the pages (and records of imported databases) refer to, in
// order of first use, with the page.
function referencedFiles(tree: ImportTree, mode: ImportMode = "pages") {
  const used = new Map<string, string>();
  for (const page of pagesFor(tree, mode)) {
    for (const html of [page.html, ...(page.database?.rows.map((r) => r.html) || [])])
      for (const match of html.matchAll(PLACEHOLDER))
        if (match[1] === "file") {
          const key = decodeKey(match[2]);
          if (tree.files.has(key) && !used.has(key)) used.set(key, page.key);
        }
  }
  return used;
}
// The files only templates refer to (#116): stored with the template, not
// as uploads of a page.
const templateHtml = (template: ImportTemplate) => [template.html, ...(template.database?.rows.map((r) => r.html) || [])];
function templateFiles(tree: ImportTree, used: Map<string, string>) {
  const keys = new Set<string>();
  for (const template of tree.templates || [])
    for (const html of templateHtml(template))
      for (const match of html.matchAll(PLACEHOLDER))
        if (match[1] === "file") {
          const key = decodeKey(match[2]);
          if (tree.files.has(key) && !used.has(key)) keys.add(key);
        }
  return keys;
}
// Who sees imported templates: the workspace, as a template saved in the
// app (template.save, /api/templates/import) for whoever may edit the
// workspace – else only the person importing.
export async function importTemplateVisibility(user: Identity, workspaceId: string): Promise<"workspace" | "private"> {
  const role = await memberRole(user, workspaceId);
  return (role === "editor" || role === "owner") && !(await isGuest(user, workspaceId)) && user.apiScope !== "read" ? "workspace" : "private";
}
// Limits of a saved template (lib/template-files.ts captureTemplateFiles).
const TEMPLATE_FILES = 200;
const TEMPLATE_FILE_BYTES = 10 * 1024 * 1024;
// The journal days of an import go to: the writable journal in the target
// space, else one elsewhere in the workspace, else a new one.
async function importJournal(user: Identity, workspaceId: string, spaceId: string) {
  const journals = await filterAsync(await all<Page>(
    "SELECT * FROM pages WHERE workspace_id=? AND kind='journal' AND deleted_at IS NULL ORDER BY (space_id=?) DESC, updated_at DESC",
    workspaceId,
    spaceId,
  ), async (j) => ["editor", "owner"].includes(await pageRole(user, j) || "") && !j.locked && !(await journalLocked(user, j)) && !(await isEncryptedPage(j)));
  if (journals[0]) return { id: journals[0].id, spaceId: journals[0].space_id };
  return { id: await createPage(workspaceId, spaceId, user.id, ct("Journal", "Journal"), "journal"), spaceId };
}

export async function requireSpace(user: Identity, workspaceId: string, spaceId: string) {
  await requireMember(user, workspaceId, "editor");
  const space = await one<Space>("SELECT * FROM spaces WHERE id=? AND workspace_id=? AND deleted_at IS NULL", spaceId, workspaceId);
  if (!space || !["editor", "owner"].includes(await spaceRole(user, space) || "")) throw new HttpError(403, "Keine Schreibrechte im Zielbereich.");
  // End-to-end encrypted spaces never take plaintext from the server.
  await requirePlaintextSpace(space);
}

export async function previewImport(user: Identity, workspaceId: string, spaceId: string, tree: ImportTree, mode: ImportMode = "pages"): Promise<ImportPreview> {
  await requireSpace(user, workspaceId, spaceId);
  const used = referencedFiles(tree, mode);
  const forTemplates = templateFiles(tree, used);
  const bytes = [...used.keys(), ...forTemplates].reduce((sum, key) => sum + importFileSize(tree.files.get(key)!), 0);
  const warnings = [...tree.warnings];
  const unused = tree.files.size - used.size - forTemplates.size;
  const templates = tree.templates?.length || 0;
  const templateVisibility = templates ? (await importTemplateVisibility(user, workspaceId)) : undefined;
  if (templateVisibility === "private")
    warnings.push("Die Vorlagen werden nur für dich gespeichert („Nur für mich“): Vorlagen für den Arbeitsbereich legt an, wer ihn bearbeiten darf.");
  if (unused > 0) warnings.push(`${unused} Dateien werden von keiner Seite verwendet und nicht übernommen.`);
  const pages = pagesFor(tree, mode);
  const boards = tree.pages.filter((p) => p.kind === "whiteboard").length;
  const databases = tree.pages.filter((p) => p.kind === "database").length;
  const journalDays = new Set(tree.pages.filter((p) => p.journalDate).map((p) => p.journalDate)).size;
  if (mode === "database" && boards + databases)
    warnings.push("Whiteboards und Datenbanken werden nur beim Import als Seiten übernommen.");
  const notes = tree.pages.filter((p) => !p.folder && !special(p)).length;
  const count = mode === "database" ? notes : pages.length;
  const limit = maxImportPages();
  const tooMany = !!tree.tooMany || count > limit;
  if (tooMany) warnings.unshift(mode === "database" ? tooManyRecords(count, limit) : tooManyPages(count, limit));
  const properties = new Set(pages.flatMap((p) => Object.keys(p.properties || {}))).size;
  const records = tree.pages.flatMap((p) => p.database?.rows || []);
  const rowDocuments = mode === "pages" ? records.filter((r) => r.key).length : 0;
  const icons = pages.filter((p) => importIcon(p.icon)).length + (mode === "pages" ? records.filter((r) => importIcon(r.icon)).length : 0);
  try {
    await enforceQuota(workspaceId, bytes);
    await enforceUserStorage(user, bytes);
  } catch (error) {
    if (error instanceof HttpError) warnings.push(error.message);
    else throw error;
  }
  return {
    source: tree.source,
    title: tree.title,
    // Pages: documents of their own (journal days are counted apart).
    pages: mode === "pages" ? pages.filter((p) => !p.folder && !special(p) && !p.journalDate).length : notes,
    // Folders of the source; the page holding everything is named apart.
    folders: tree.pages.filter((p) => p.folder && p.key !== tree.wrapper).length,
    files: used.size + forTemplates.size,
    bytes,
    tags: new Set(pages.flatMap((p) => p.tags || [])).size,
    warnings,
    ...(boards ? { whiteboards: boards } : {}),
    ...(databases ? { databases } : {}),
    ...(journalDays && mode === "pages" ? { journalDays } : {}),
    ...(tree.collections ? { collections: tree.collections } : {}),
    ...(properties && mode === "pages" ? { properties } : {}),
    ...(icons && mode === "pages" ? { icons } : {}),
    ...(rowDocuments ? { rowDocuments } : {}),
    ...(tree.linkedBelow && mode === "pages" ? { linkedBelow: tree.linkedBelow } : {}),
    ...(templates ? { templates, templateVisibility } : {}),
    ...(tooMany ? { tooMany } : {}),
    ...(tree.wrapper && mode === "pages" && tree.pages.some((p) => p.key === tree.wrapper)
      ? { wrapper: tree.pages.find((p) => p.key === tree.wrapper)!.title }
      : {}),
  };
}

const sqlTime = (iso?: string) => (iso ? iso.replace("T", " ").replace(/\.\d+Z?$|Z$/, "").slice(0, 19) : null);
const day = (iso?: string) => (iso ? iso.slice(0, 10) : null);

export async function writeImport(user: Identity, workspaceId: string, spaceId: string, tree: ImportTree, mode: ImportMode = "pages"): Promise<ImportResult> {
  const preview = await previewImport(user, workspaceId, spaceId, tree, mode);
  if (!tree.pages.length && !tree.templates?.length) throw new HttpError(400, "In der Datei wurden keine Seiten gefunden.");
  if (preview.tooMany)
    throw new HttpError(413, mode === "database" ? tooManyRecords(preview.pages) : tooManyPages(pagesFor(tree, mode).length));
  await enforceQuota(workspaceId, preview.bytes);
  await enforceUserStorage(user, preview.bytes);
  const used = referencedFiles(tree, mode);
  const pagesOf = pagesFor(tree, mode);
  const byKey = new Map(pagesOf.map((p) => [p.key, p]));
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
  const ordered = pagesOf.map((page, index) => ({ page, index, depth: depth(page) })).sort((a, b) => a.depth - b.depth || a.index - b.index);
  // Journal days that already exist get the imported text appended after
  // the import (as an edit of the live document).
  const appends: { pageId: string; html: string }[] = [];

  const result = await transaction(async () => {
    const quota = tree.templates?.length ? (await quotaCheckpoint(workspaceId)) : () => {};
    const dir = resolve(process.env.FLOWPLAN_DATA_DIR || "./data", "uploads");
    const pageIds = new Map<string, string>();
    const rowIds = new Map<string, string>();
    const records = new Map<string, { pageId: string; rowId: string }>();
    const existingDays = new Set<string>();
    let databaseId: string | undefined;
    if (mode === "database") {
      databaseId = await createPage(workspaceId, spaceId, user.id, tree.title.slice(0, 200) || "Import", "database");
      for (const { page } of ordered) if (!page.folder) rowIds.set(page.key, id());
    } else {
      // Journal days: an existing day of that date, or one new day per date.
      const days = new Map<string, { id: string; existing: boolean }>();
      const journal = ordered.some(({ page }) => page.journalDate) ? (await importJournal(user, workspaceId, spaceId)) : null;
      for (const { page } of ordered) {
        if (page.journalDate && journal && mode === "pages") {
          let day = days.get(page.journalDate);
          if (!day) {
            const existing = await one<{ id: string }>(
              "SELECT id FROM pages WHERE parent_id=? AND journal_date=? AND deleted_at IS NULL AND kind='document'",
              journal.id,
              page.journalDate,
            );
            // A day lives in its journal's space.
            day = existing
              ? { id: existing.id, existing: true }
              : { id: await createPage(workspaceId, journal.spaceId, user.id, dayTitle(page.journalDate), "document", journal.id), existing: false };
            if (!existing)
              await run("UPDATE pages SET journal_date=?,icon='day',position=? WHERE id=?", page.journalDate, -Number(page.journalDate.replaceAll("-", "")), day.id);
            days.set(page.journalDate, day);
          }
          pageIds.set(page.key, day.id);
          continue;
        }
        const parent = page.parent ? pageIds.get(page.parent) || null : null;
        pageIds.set(
          page.key,
          await createPage(workspaceId, spaceId, user.id, page.title.slice(0, 200) || ct("Ohne Titel", "Untitled"), page.kind === "whiteboard" || page.kind === "database" ? page.kind : "document", parent),
        );
      }
      for (const day of days.values()) if (day.existing) existingDays.add(day.id);
      // Records that carry a document of the import (#82): their ids now, so
      // links to the document lead to them.
      for (const { page } of ordered)
        for (const record of page.kind === "database" ? page.database?.rows.slice(0, MAX_IMPORT_ROWS) || [] : [])
          if (record.key && !pageIds.has(record.key) && !records.has(record.key)) records.set(record.key, { pageId: pageIds.get(page.key)!, rowId: id() });
      // Icons of documents, folders and collections (journal days keep theirs).
      for (const { page } of ordered) {
        const icon = importIcon(page.icon);
        if (icon && !page.journalDate) await run("UPDATE pages SET icon=? WHERE id=?", icon, pageIds.get(page.key)!);
      }
    }
    // Files: stored once, at the page that uses them first.
    const fileUrls = new Map<string, { url: string; name: string; mime: string }>();
    for (const [key, pageKey] of used) {
      const file = tree.files.get(key)!;
      // Read here (large workspaces): one file in memory at a time.
      const data = importFileData(file);
      const fid = id();
      const name = sanitizeFileName(file.name, "datei");
      const mime = verifiedMime(file.mime, data);
      mkdirSync(dir, { recursive: true });
      writeFileSync(resolve(dir, fid), data);
      onTransactionRollback(() => unlinkSync(resolve(dir, fid)));
      await run(
        "INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)",
        fid,
        databaseId || pageIds.get(pageKey)!,
        name,
        mime,
        data.length,
        user.id,
      );
      fileUrls.set(key, { url: `/api/files/${fid}`, name, mime });
    }
    // Block ids (#88): every document's blocks get Flowplan ids; a link to
    // a block or heading of a page of the import (pageRef with an anchor)
    // becomes a block link, or the page link when nothing matches.
    const sources = new Map(tree.pages.map((page) => [page.key, page]));
    const anchored = new Map<string, DocumentAnchors>();
    const prepared = (key: string) => {
      if (!anchored.has(key)) {
        const page = sources.get(key);
        anchored.set(key, documentAnchors(page?.html || "", page?.title || "", true));
      }
      return anchored.get(key)!;
    };
    const pageUrl = (key: string) => {
      if (databaseId) return rowIds.has(key) ? `/#page=${databaseId}&row=${rowIds.get(key)}` : null;
      if (pageIds.has(key)) return `/#page=${pageIds.get(key)}`;
      const record = records.get(key);
      return record ? `/#page=${record.pageId}&row=${record.rowId}` : null;
    };
    // Embedded databases and whiteboards name their page by id.
    const resolveHtml = (html: string, files = fileUrls) =>
      cleanHtml(
        html
          .replace(/(data-linked-source|data-whiteboard)="fp-import:\/\/page\/([^"]*)"/g, (_, name: string, key: string) =>
            pageIds.has(decodeKey(key)) ? `${name}="${pageIds.get(decodeKey(key))}"` : `${name}=""`,
          )
          // Images of files that are no pictures become links.
          .replace(/<img\b[^>]*?\bsrc="fp-import:\/\/file\/([^"]*)"[^>]*>/g, (tag: string, key: string) => {
            const file = files.get(decodeKey(key));
            if (!file) return "";
            // The image keeps its block id (#88).
            const block = /\bdata-block-id="([\w-]{1,64})"/.exec(tag)?.[1];
            return isImage(file.mime) ? `<img src="${esc(file.url)}" alt="${esc(file.name)}"${block ? ` data-block-id="${block}"` : ""}>` : `<a href="${esc(file.url)}">${esc(file.name)}</a>`;
          })
          // Attachments become the block an upload in the editor creates (#82).
          .replace(/<div data-import-file="fp-import:\/\/file\/([^"]*)" data-title="([^"]*)"><\/div>/g, (_, key: string, title: string) =>
            attachmentHtml(files.get(decodeKey(key)), title),
          )
          .replace(/<img\b[^>]*?\bsrc="fp-import:\/\/page\/[^"]*"[^>]*>/g, "")
          .replace(/(href|src)="fp-import:\/\/(file|page)\/([^"]*)"/g, (_, name: string, kind: string, ref: string) => {
            const [key, anchor] = ref.split("#", 2);
            let target = kind === "file" ? files.get(decodeKey(key))?.url : pageUrl(decodeKey(key));
            const blockId = target && kind === "page" && anchor && sources.has(decodeKey(key)) ? findAnchor(prepared(decodeKey(key)).anchors, decodeKey(anchor)) : null;
            if (blockId) target += `&block=${blockId}`;
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
      await run(
        "UPDATE databases SET fields=?,views=? WHERE page_id=?",
        JSON.stringify(fields),
        JSON.stringify([{ id: id(), name: ct("Tabelle", "Table"), type: "table", filters: [], sorts: [] }]),
        databaseId,
      );
      await forEachAsync(notes, async ({ page }, i) => {
        const rid = rowIds.get(page.key)!;
        const html = page.html ? resolveHtml(prepared(page.key).html) : "";
        const folder = folderOf(page);
        const cells = {
          title: page.title.slice(0, 1000),
          imp_tags: (page.tags || []).filter((t) => tags.includes(t)),
          ...(day(page.created) ? { imp_created: day(page.created) } : {}),
          ...(day(page.updated) ? { imp_updated: day(page.updated) } : {}),
          ...(folder && folders.includes(folder) ? { imp_folder: folder } : {}),
          ...(page.url && /^https?:\/\//i.test(page.url) ? { imp_url: page.url.slice(0, 2000) } : {}),
        };
        await run(
          "INSERT INTO rows(id,page_id,cells,position,created_by,updated_by,content,created_at,updated_at) VALUES(?,?,?,?,?,?,?,COALESCE(?,?),COALESCE(?,?))",
          rid,
          databaseId!,
          JSON.stringify(cells),
          i,
          user.id,
          user.id,
          html,
          sqlTime(page.created), nowText(),
          sqlTime(page.updated || page.created), nowText(),
        );
        if (html) await run("INSERT INTO row_documents(row_id,state,html,generation) VALUES(?,?,?,?)", rid, htmlState(html), html, id());
        rows++;
      });
    } else {
      const placeholders = new Map([...pageIds].map(([key, pid]) => [pageRef(key), pid]));
      const dayBodies = new Map<string, { title: string; body: string }[]>();
      const boardBytes = { bytes: preview.bytes };
      for (const { page } of ordered) {
        const pid = pageIds.get(page.key)!;
        if (page.kind === "whiteboard" && page.board) {
          const urls = await storeBoardImages(user, pid, workspaceId, page.board, boardBytes);
          // Cards of documents that are records' content show the record.
          const recordOf = new Map([...records].map(([key, record]) => [pageRef(key), record]));
          const board = recordOf.size
            ? { ...page.board, items: page.board.items.map((item) => (item.type === "card" && item.pageId && recordOf.has(item.pageId) ? { ...item, ...recordOf.get(item.pageId)! } : item)) }
            : page.board;
          await writeWhiteboard(pid, boardState(board, urls), placeholders);
          continue;
        }
        if (page.kind === "database" && page.database) {
          const { fields, views, rows: rowsOf } = page.database;
          await run("UPDATE databases SET fields=?,views=? WHERE page_id=?", JSON.stringify(fields), JSON.stringify(views), pid);
          await forEachAsync(rowsOf.slice(0, MAX_IMPORT_ROWS), async (record, i) => {
            const own = record.key ? records.get(record.key) : undefined;
            const rid = own?.pageId === pid ? own.rowId : id();
            const html = record.html ? resolveHtml(record.html) : "";
            await run(
              "INSERT INTO rows(id,page_id,cells,position,created_by,updated_by,content,created_at,icon) VALUES(?,?,?,?,?,?,?,COALESCE(?,?),?)",
              rid,
              pid,
              JSON.stringify(record.cells),
              i,
              user.id,
              user.id,
              html,
              sqlTime(record.created), nowText(),
              importIcon(record.icon) || "",
            );
            if (html) await run("INSERT INTO row_documents(row_id,state,html,generation) VALUES(?,?,?,?)", rid, htmlState(html), html, id());
            rows++;
          });
          continue;
        }
        const html = resolveHtml(prepared(page.key).html);
        // Tags and frontmatter properties become the page's (#70,
        // lib/page-properties-server.ts).
        await importPageMeta(user, workspaceId, pid, page, tree.tagColors);
        const source = page.url && /^https?:\/\//i.test(page.url) ? `<p><a href="${esc(page.url)}">${esc(page.url)}</a></p>` : "";
        const body = cleanHtml(source + html);
        if (page.journalDate) {
          dayBodies.set(pid, [...(dayBodies.get(pid) || []), { title: page.title, body }]);
          continue;
        }
        await run("UPDATE documents SET html=?,state=? WHERE page_id=?", body, htmlState(body), pid);
        if (page.aliases?.length) await run("UPDATE pages SET aliases=? WHERE id=?", storedAliases(page.aliases.slice(0, 10)), pid);
        if (page.updated) await run("UPDATE pages SET updated_at=? WHERE id=?", sqlTime(page.updated), pid);
      }
      for (const [pid, bodies] of dayBodies) {
        // Several documents of one day, or text added to a day that already
        // has some, follow under their title.
        const titled = bodies.length > 1 || existingDays.has(pid);
        const body = cleanHtml(bodies.map((b) => (titled ? `<h2>${esc(b.title)}</h2>` : "") + b.body).join(""));
        if (existingDays.has(pid)) appends.push({ pageId: pid, html: body });
        else await run("UPDATE documents SET html=?,state=? WHERE page_id=?", body, htmlState(body), pid);
      }
    }
    // Templates (#116): saved templates of the workspace, category "other";
    // their files go with them (template_files), as when saving one.
    const templateWarnings = await writeTemplates(user, workspaceId, tree, preview.templateVisibility || "private", (template) => {
      const own = new Map<string, { url: string; name: string; mime: string }>();
      const stored: { original: string; name: string; mime: string; data: Buffer }[] = [];
      let skipped = 0;
      for (const html of templateHtml(template))
        for (const match of html.matchAll(PLACEHOLDER)) {
          const key = decodeKey(match[2]);
          const file = match[1] === "file" ? tree.files.get(key) : undefined;
          if (!file || own.has(key)) continue;
          if (stored.length >= TEMPLATE_FILES || importFileSize(file) > TEMPLATE_FILE_BYTES) {
            skipped++;
            continue;
          }
          const data = importFileData(file);
          const entry = { original: id(), name: sanitizeFileName(file.name, "datei"), mime: verifiedMime(file.mime, data), data };
          stored.push(entry);
          own.set(key, { url: `/api/files/${entry.original}`, name: entry.name, mime: entry.mime });
        }
      // Fresh block ids, as the pages get (#88).
      return { resolve: (html: string) => (html ? resolveHtml(documentAnchors(html, "", true).html, own) : ""), files: stored, skipped };
    });
    quota();
    const rootIds = databaseId
      ? [databaseId]
      : [...new Set(ordered.filter(({ page }) => !page.parent || !pageIds.has(page.parent)).map(({ page }) => pageIds.get(page.key)!))];
    return { ...preview, warnings: [...preview.warnings, ...templateWarnings], rootIds, rows, ...(databaseId ? { databaseId } : {}) };
  }, user);
  for (const append of appends)
    try {
      await appendHtmlToPage(user, append);
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      result.warnings.push(`Ein Journaltag konnte nicht ergänzt werden: ${error.message}`);
    }
  return result;
}

// The templates of an import (#116), each as the template a person saves
// from a page: a document's HTML, or a database's fields, views and
// records; tags as the template's meta, the emoji as its icon.
async function writeTemplates(
  user: Identity,
  workspaceId: string,
  tree: ImportTree,
  visibility: "workspace" | "private",
  prepare: (template: ImportTemplate) => { resolve: (html: string) => string; files: { original: string; name: string; mime: string; data: Buffer }[]; skipped: number },
) {
  const warnings: string[] = [];
  let skipped = 0;
  for (const template of tree.templates || []) {
    const files = prepare(template);
    skipped += files.skipped;
    const icon = importIcon(template.icon);
    const meta = template.tags?.length ? { meta: { tags: template.tags.map((name) => ({ name, ...(tree.tagColors?.[name] ? { color: tree.tagColors[name] } : {}) })) } } : {};
    let payload: string;
    if (template.kind === "database" && template.database) {
      const parsed = savedDatabaseTemplateSchema.safeParse({
        database: { fields: template.database.fields, views: template.database.views },
        rows: template.database.rows.slice(0, MAX_IMPORT_ROWS).map((row, i) => ({ id: id(), cells: row.cells, content: files.resolve(row.html), position: i })),
      });
      if (!parsed.success) {
        warnings.push(`Vorlage „${template.name}“ konnte nicht übernommen werden.`);
        continue;
      }
      payload = JSON.stringify({ ...parsed.data, ...(icon ? { icon } : {}), ...meta });
    } else payload = JSON.stringify({ html: files.resolve(template.html), ...(icon ? { icon } : {}), ...meta });
    if (payload.length > 20_000_000) {
      warnings.push(`Vorlage „${template.name}“ konnte nicht übernommen werden.`);
      continue;
    }
    const templateId = id();
    await run(
      "INSERT INTO templates(id,workspace_id,name,kind,payload,created_by,visibility,category) VALUES(?,?,?,?,?,?,?,?)",
      templateId,
      workspaceId,
      template.name.slice(0, 500) || ct("Ohne Titel", "Untitled"),
      template.kind,
      payload,
      user.id,
      visibility,
      "other",
    );
    for (const file of files.files)
      await run(
        "INSERT INTO template_files(id,template_id,original_id,name,mime,data) VALUES(?,?,?,?,?,?)",
        id(),
        templateId,
        file.original,
        file.name,
        file.mime,
        file.data,
      );
  }
  if (skipped) warnings.push(`${skipped} Anhänge von Vorlagen über 10 MB oder über 200 je Vorlage werden nicht übernommen.`);
  return warnings;
}

// An attachment of an import as the editor inserts an upload
// (components/editor.tsx upload): a PDF with its preview, audio and video
// with a player, anything else as a link. The title arrives escaped.
export function attachmentHtml(file: { url: string; mime: string } | undefined, title: string) {
  if (!file) return `<p>${title}</p>`;
  const url = esc(file.url);
  if (file.mime === "application/pdf") return `<div data-pdf="${url}" data-title="${title}"><a href="${url}">${title}</a></div>`;
  if (/^audio\//.test(file.mime)) return `<audio src="${url}" controls></audio>`;
  if (/^video\//.test(file.mime)) return `<video src="${url}" controls></video>`;
  return `<p><a href="${url}">${title}</a></p>`;
}

// A page icon from another tool: one emoji (a sequence such as a flag or a
// family counts as one), never a link or a file.
const EMOJI = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[#*0-9]\uFE0F?\u20E3)/u;
export function importIcon(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const icon = value.trim();
  if (!icon || icon.length > 32 || /\s/.test(icon) || !EMOJI.test(icon)) return null;
  return pageIconSchema.safeParse(icon).success ? icon : null;
}

// The tags (with the source's colours) and frontmatter properties of an
// imported page; new properties only for workspace owners.
async function importPageMeta(user: Identity, workspaceId: string, pageId: string, page: ImportPage, colors: Record<string, string> = {}) {
  const space = await one<{ space_id: string }>("SELECT space_id FROM pages WHERE id=?", pageId);
  if (!space) return;
  const manage = await canManageScope(user, workspaceId, space.space_id);
  const fromFront = page.properties ? (await frontmatterMeta(page.properties, workspaceId, await memberByName(workspaceId), { createDefinitions: manage, spaceId: space.space_id })).meta : {};
  await applyPortableMeta(
    user,
    { id: pageId, workspace_id: workspaceId, space_id: space.space_id },
    {
      tags: [...(page.tags || []).map((name) => ({ name, color: colors[name] })), ...(fromFront.tags || [])],
      properties: fromFront.properties,
    },
    { createDefinitions: manage },
  );
}
