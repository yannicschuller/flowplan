// What the document exports (DOCX, batch PDF, EPUB) have in common: which
// pages a person may take along, the content of every page as the one
// sanitised HTML (lib/document-server.ts), and the files behind
// /api/files/<id> – with the same rights as the Markdown export
// (lib/markdown-export.ts): readable pages only, PIN-locked journals and
// hidden records stay out.
import { readableDatabase } from "./field-access";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { generateJSON } from "@tiptap/html/server";
import { all, one, transaction } from "./db";
import { HttpError, appUrl } from "./auth";
import { requirePage, pageRole, spaceRole } from "./permissions";
import { lockedPageIds, requireUnlocked } from "./journal-extras";
import { requirePlaintext, requirePlaintextSpace } from "./e2ee-server";
import { database, rows } from "./api";
import { relatedData } from "./related-data";
import { computedCells } from "./database";
import { cellText } from "./cell-text";
import { visibleRows } from "./row-access";
import { hiddenFileIds } from "./row-files";
import { fileUrls } from "./file-cells";
import { cleanHtml, escaped } from "./document-server";
import { documentExtensions, documentSchema } from "./document-schema";
import { whiteboardSnapshotItems } from "./whiteboard";
import { whiteboardSvg } from "./whiteboard-svg";
import { ct } from "./content-locale";
import { dashboardSummary } from "./dashboard";
import { inkPicture, notebookExportHtml, type InkPicture } from "./ink-export";
import { markdownToHtml } from "./markdown-import";
import type { Identity, Page, Row, Field, Space } from "./types";

export type ExportSelection = {
  pageId?: string;
  spaceId?: string;
  // Sub-pages of the page (a space always comes with everything).
  children?: boolean;
  // One record of a database instead of the whole database.
  rowId?: string;
  // How many pages one export may hold, and the format's name for the error.
  maxPages: number;
  format: string;
};
export type ExportPage = {
  page: Page;
  // 0 for the root page or a top-level page of the space.
  depth: number;
  title: string;
  // The page's content as sanitised document HTML (databases as a table
  // with every record's document; whiteboards empty, see `svg`).
  html: string;
  // A whiteboard page as a picture; null when the board is empty.
  svg: string | null;
  // The cover image, as /api/files/<id>, when the person may see it.
  cover: string | null;
};
export type ExportFileInfo = { id: string; name: string; mime: string; ext: string };
export type ExportFile = ExportFileInfo & { bytes: Buffer };
export type ExportContent = {
  root: Page | null;
  space: Space | null;
  name: string;
  pages: ExportPage[];
  // The file behind /api/files/<id> (or such an address), null when the
  // person may not download it: `fileInfo` only checks, `file` also reads
  // it (once, kept for the export).
  fileInfo: (raw: string) => ExportFileInfo | null;
  file: (raw: string) => ExportFile | null;
  // A page the person may read, by its id or a #page= link; null otherwise.
  readable: (idOrUrl: string) => Page | null;
  // The link to a page in Flowplan.
  pageUrl: (id: string) => string;
  // A page's whiteboard picture, for embedded boards.
  boardSvg: (pageId: string) => string | null;
  // A drawing block of a document or a sheet of a notebook (lib/ink-export.ts).
  ink: (pageId: string, attrs: { id?: unknown; height?: unknown; paper?: unknown }) => InkPicture | null;
};
const MAX_FILE_BYTES = 25 * 1024 * 1024,
  MAX_TOTAL_BYTES = 100 * 1024 * 1024,
  MAX_ROWS = 5000;
export const recordWord = () => ct("Eintrag", "Record");
const unavailable = () => ct("Nicht verfügbar", "Not available");

const extensions: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/avif": "avif",
};
export const imageExtension = (mime: string) => extensions[mime] || null;
export const fileId = (raw: string) => {
  const match = /^(?:https?:\/\/[^/]+)?\/api\/files\/([a-f0-9-]{36})(?:[?#].*)?$/i.exec(raw.trim());
  return match ? match[1] : null;
};

// The sanitised HTML as a ProseMirror document, for the format walkers.
export function documentNode(html: string) {
  return documentSchema().nodeFromJSON(generateJSON(cleanHtml(html) || "<p></p>", documentExtensions));
}

export function collectExportContent(user: Identity, options: ExportSelection): ExportContent {
  return transaction(() => collect(user, options));
}

function collect(user: Identity, options: ExportSelection): ExportContent {
  let space: Space | null = null,
    root: Page | null = null;
  if (options.spaceId) {
    if (options.pageId || options.rowId) throw new HttpError(400, "Entweder eine Seite oder einen Bereich exportieren.");
    space = one<Space>("SELECT * FROM spaces WHERE id=? AND deleted_at IS NULL", options.spaceId) || null;
    if (!space) throw new HttpError(404, "Bereich nicht gefunden.");
    if (!spaceRole(user, space)) throw new HttpError(403, "Keine Berechtigung für diesen Bereich.");
    // Encrypted spaces leave only as the encrypted archive or decrypted in the browser.
    requirePlaintextSpace(space);
  } else {
    if (!options.pageId) throw new HttpError(400, "Seite fehlt.");
    root = requirePage(user, options.pageId);
    requireUnlocked(user, root);
    requirePlaintext(root);
  }
  if (options.rowId && (root?.kind !== "database" || options.children))
    throw new HttpError(400, "Nur ein Eintrag einer Datenbank.");
  const workspaceId = space ? space.workspace_id : root!.workspace_id;
  const locked = lockedPageIds(user, workspaceId);
  const visible = all<Page>(
    "SELECT * FROM pages WHERE workspace_id=? AND deleted_at IS NULL AND synced=0 ORDER BY position,id",
    workspaceId,
  ).filter((page) => !locked.has(page.id) && pageRole(user, page));
  const roots = space ? visible.filter((page) => page.space_id === space.id && !page.parent_id) : [root!];
  // Depth first, in the order of the page tree.
  const selected: { page: Page; depth: number }[] = [];
  const seen = new Set<string>();
  const walk = (page: Page, depth: number) => {
    if (seen.has(page.id)) return;
    seen.add(page.id);
    selected.push({ page, depth });
    if (selected.length > options.maxPages)
      throw new HttpError(413, `Bitte höchstens ${options.maxPages} Seiten je ${options.format}-Export auswählen.`);
    if (options.children || space)
      for (const child of visible) if (child.parent_id === page.id) walk(child, depth + 1);
  };
  for (const page of roots) walk(page, 0);
  const pageCache = new Map<string, Page | null>();
  const readable = (idOrUrl: string) => {
    let id = idOrUrl;
    if (!/^[a-f0-9-]{36}$/i.test(id)) {
      try {
        const url = new URL(idOrUrl, appUrl());
        // Only Flowplan's own page links, not a #page= on another site.
        id =
          url.origin === new URL(appUrl()).origin && url.hash.startsWith("#page=")
            ? new URLSearchParams(url.hash.slice(1)).get("page") || ""
            : "";
      } catch {
        id = "";
      }
    }
    if (!id) return null;
    if (!pageCache.has(id)) {
      let page: Page | null = null;
      try {
        page = requirePage(user, id);
        if (locked.has(page.id)) page = null;
      } catch {}
      pageCache.set(id, page);
    }
    return pageCache.get(id)!;
  };
  const pageUrl = (id: string) => `${appUrl().replace(/\/$/, "")}/#page=${id}`;
  // A file comes along only if the person could download it: its page is
  // readable and unlocked, and it does not belong to a private record.
  const hiddenFiles = new Map<string, Set<string>>();
  const infos = new Map<string, ExportFileInfo | null>();
  const files = new Map<string, ExportFile | null>();
  let total = 0;
  const fileInfo = (raw: string) => {
    const id = fileId(raw);
    if (!id) return null;
    if (infos.has(id)) return infos.get(id)!;
    infos.set(id, null);
    const row = one<{ id: string; page_id: string; name: string; mime: string }>("SELECT id,page_id,name,mime FROM files WHERE id=?", id);
    const owner = row ? readable(row.page_id) : null;
    if (!row || !owner) return null;
    try {
      requireUnlocked(user, owner);
    } catch {
      return null;
    }
    if (!hiddenFiles.has(owner.id)) hiddenFiles.set(owner.id, hiddenFileIds(user, owner));
    if (hiddenFiles.get(owner.id)!.has(row.id)) return null;
    const mime = String(row.mime || "application/octet-stream");
    const info: ExportFileInfo = { id: row.id, name: row.name, mime, ext: imageExtension(mime) || "bin" };
    infos.set(id, info);
    return info;
  };
  const file = (raw: string) => {
    const info = fileInfo(raw);
    if (!info) return null;
    if (files.has(info.id)) return files.get(info.id)!;
    files.set(info.id, null);
    const source = resolve(process.env.FLOWPLAN_DATA_DIR || "./data", "uploads", info.id);
    let size: number;
    try {
      const stat = statSync(source);
      if (!stat.isFile()) throw Error();
      size = stat.size;
    } catch {
      throw new HttpError(409, "Eine referenzierte Datei fehlt. Bitte den Anhang prüfen und den Export erneut starten.");
    }
    if (size > MAX_FILE_BYTES) return null;
    total += size;
    if (total > MAX_TOTAL_BYTES) throw new HttpError(413, "Anhänge überschreiten 100 MB.");
    const result: ExportFile = { ...info, bytes: readFileSync(source) };
    files.set(info.id, result);
    return result;
  };
  const boards = new Map<string, string | null>();
  const boardSvg = (pageId: string) => {
    const page = readable(pageId);
    if (!page || page.kind !== "whiteboard") return null;
    if (!boards.has(page.id))
      boards.set(
        page.id,
        whiteboardSvg(
          whiteboardSnapshotItems(page),
          {
            // Pictures on the board go along as data: the SVG is one file.
            image: (src) => {
              const picture = file(src);
              return picture && imageExtension(picture.mime)
                ? `data:${picture.mime};base64,${picture.bytes.toString("base64")}`
                : /^https?:\/\//.test(src)
                  ? src
                  : null;
            },
            page: (id) => {
              const target = readable(id);
              return target ? { title: target.title, kind: target.kind } : null;
            },
            record: (databaseId, rowId) => {
              const db = readable(databaseId);
              if (!db || db.kind !== "database") return null;
              const row = visibleRows(user, db, rows(db.id)).find((r) => r.id === rowId);
              if (!row) return null;
              const fields = database(db.id).fields;
              return { title: cellText(row.cells[fields[0]?.id || "title"]) || recordWord(), database: db.title };
            },
            label: ct,
          },
          page.title,
        ),
      );
    return boards.get(page.id)!;
  };
  const members = new Map(
    all<{ id: string; name: string }>(
      "SELECT u.id,u.name FROM users u JOIN members m ON m.user_id=u.id WHERE m.workspace_id=?",
      workspaceId,
    ).map((member) => [member.id, member.name]),
  );
  let rowCount = 0;
  let name = space ? space.name : root!.title;
  const pages = selected.map(({ page, depth }): ExportPage => {
    const cover = page.cover.startsWith("/api/files/") && fileInfo(page.cover) ? page.cover : null;
    if (page.kind === "whiteboard") return { page, depth, title: page.title, html: "", svg: boardSvg(page.id), cover };
    if (page.kind === "dashboard")
      return {
        page,
        depth,
        title: page.title,
        html: dashboardSummary(user, page)
          .map((t) => `<h2>${escaped(t.title)}</h2>` + (t.text ? markdownToHtml(t.text) : `<p><em>${escaped(t.source ? `${t.kind} · ${t.source}` : t.kind)}</em></p>`))
          .join(""),
        svg: null,
        cover,
      };
    // A notebook: its sheets as pictures (drawing blocks the exporters draw).
    if (page.kind === "notebook") return { page, depth, title: page.title, html: notebookExportHtml(page), svg: null, cover };
    if (page.kind === "document" || page.kind === "journal")
      return { page, depth, title: page.title, html: one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", page.id)?.html || "", svg: null, cover };
    // A database: its records as a table, then every record's document.
    // Properties hidden from this person are left out (lib/field-access.ts).
    const schema = readableDatabase(user, page, database(page.id)),
      fields = schema.fields,
      related = relatedData(user, page),
      visibleRecords = visibleRows(user, page, rows(page.id)).filter((row) => !options.rowId || row.id === options.rowId);
    if (options.rowId && !visibleRecords.length) throw new HttpError(404, "Datensatz fehlt.");
    rowCount += visibleRecords.length;
    if (rowCount > MAX_ROWS) throw new HttpError(413, `Bitte höchstens ${MAX_ROWS.toLocaleString("de-DE")} Datensätze je ${options.format}-Export auswählen.`);
    const records = visibleRecords.map((row) => {
      const computed = computedCells(row, fields, related.related, related.relatedSchemas);
      const title = cellText(computed[fields[0].id]) || recordWord();
      const values = fields.map((field) => propertyText(computed[field.id], field, related, members));
      const content = one<{ html: string }>("SELECT html FROM row_documents WHERE row_id=?", row.id)?.html ?? row.content ?? "";
      const body = content.trimStart().startsWith("<") ? content : content ? `<p>${escaped(content)}</p>` : "";
      return { row, title, values, body };
    });
    const cell = (text: string) => escaped(text).replace(/\n/g, "<br>");
    let html = "";
    if (options.rowId) {
      const record = records[0];
      name = record.title;
      html =
        `<table><tr><th>${escaped(ct("Eigenschaft", "Property"))}</th><th>${escaped(ct("Wert", "Value"))}</th></tr>` +
        fields.map((field, index) => `<tr><td>${cell(field.name)}</td><td>${cell(record.values[index])}</td></tr>`).join("") +
        `</table>` +
        record.body;
      return { page, depth, title: record.title, html, svg: null, cover };
    }
    html =
      `<table><tr>${fields.map((field) => `<th>${cell(field.name)}</th>`).join("")}</tr>` +
      records.map((record) => `<tr>${record.values.map((value) => `<td>${cell(value)}</td>`).join("")}</tr>`).join("") +
      `</table>`;
    for (const record of records) if (record.body) html += `<h2>${escaped(record.title)}</h2>${record.body}`;
    return { page, depth, title: page.title, html, svg: null, cover };
  });
  const ink = (pageId: string, attrs: { id?: unknown; height?: unknown; paper?: unknown }) => {
    const page = readable(pageId);
    return page && !locked.has(page.id) ? inkPicture(page, attrs) : null;
  };
  return { root, space, name, pages, fileInfo, file, readable, pageUrl, boardSvg, ink };
}

// A property as plain text, like the Markdown export shows it.
function propertyText(
  value: unknown,
  field: Field,
  data: { related: Record<string, Row[]>; relatedSchemas: Record<string, Field[]> },
  members: Map<string, string>,
) {
  const values = Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];
  if (field.type === "relation") {
    const target = field.relationPage || "",
      available = data.related[target],
      titleField = data.relatedSchemas[target]?.[0]?.id || "title";
    if (!available) return unavailable();
    return values
      .map((id) => available.find((row) => row.id === String(id)))
      .filter((row): row is Row => !!row)
      .map((row) => cellText(row.cells[titleField]) || recordWord())
      .join(", ");
  }
  if (["person", "created_by", "updated_by"].includes(field.type)) return values.map((id) => members.get(String(id)) || unavailable()).join(", ");
  if (field.type === "files")
    return fileUrls(value)
      .map((raw) => {
        const id = fileId(raw);
        const file = id ? one<{ name: string }>("SELECT name FROM files WHERE id=?", id) : null;
        return id ? file?.name || ct("Datei nicht verfügbar", "File not available") : raw;
      })
      .join(", ");
  if (field.type === "checkbox") return value ? ct("Ja", "Yes") : ct("Nein", "No");
  if (field.type === "checklist")
    return (values as { text?: string; done?: boolean }[]).map((item) => `${item?.done ? "☑" : "☐"} ${item?.text || ""}`).join("\n");
  if (value === "#ACCESS") return unavailable();
  return cellText(value);
}
