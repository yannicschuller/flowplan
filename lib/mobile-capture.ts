// Capture from the mobile apps beyond the widgets (flowplan-app), with the
// device token like lib/mobile-widgets.ts:
//
//   GET  /api/mobile/capture/targets    where shared things can go: the inbox
//                                       (the person's capture database) and
//                                       every database and document they may add to
//   POST /api/mobile/capture/save       text, a link and images or PDFs (iOS share
//                                       extension, document scanner) as a record,
//                                       a sub page, or appended to a page
//   GET  /api/mobile/capture/spotlight  pages and open tasks for the phone's own
//                                       search (iOS Spotlight)
//
// Saving goes through the web app's commands (capture.record, page.create)
// and the same target checks as the capture widget (captureTarget). Text
// the phone recognised in a scan is stored as the PDF's extracted text, so
// the search finds it without the server's own OCR.
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { Fragment, type Node as PMNode } from "@tiptap/pm/model";
import { all, audit, id, one, onTransactionRollback, run, transaction } from "./db";
import { HttpError } from "./auth";
import { command } from "./api";
import { ct } from "./content-locale";
import { cleanHtml, escaped } from "./document-server";
import { rewriteDocument, rewriteSchema } from "./document-rewrite";
import { openTasksEverywhere } from "./doc-tasks";
import { visibleFields } from "./field-access";
import { enforceQuota } from "./instance-ops";
import { lockedPageIds } from "./journal-extras";
import { captureTarget, subPage, type UploadFile } from "./mobile-widget-actions";
import { captureTargetList, pageAccess, writerOf } from "./mobile-widgets";
import { recordPageEdit } from "./page-activity";
import { pageLocationHash } from "./page-location";
import { MAX_PDF_TEXT } from "./pdf-text";
import { pageRole } from "./permissions";
import { ensureRowDocument, requireRow } from "./row-documents";
import { sanitizeFileName, stripLocation, verifiedMime } from "./upload-safety";
import { enforceUserStorage, maxUploadMbFor } from "./user-limits";
import type { Field, Identity, Page } from "./types";

export const MAX_CAPTURE_FILES = 10;
export const MAX_SPOTLIGHT_PAGES = 500;
export const MAX_SPOTLIGHT_TASKS = 200;
const IMAGE = /^image\/(png|jpeg|gif|webp|avif|heic|heif)$/;
const rank: Record<string, number> = { viewer: 1, editor: 2, owner: 3 };
const url = (pageId: string, rowId?: string | null) => `/${pageLocationHash({ pageId, ...(rowId ? { rowId } : {}) })}`;
const fieldsOf = (pageId: string) => JSON.parse(one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", pageId)?.fields || "[]") as Field[];

// ---- Targets ----

// The inbox: the person's capture database (the first one they set, like
// the capture widget without a target), while they may still add to it.
export function inboxTarget(user: Identity) {
  for (const { page_id } of all<{ page_id: string }>("SELECT page_id FROM capture_targets WHERE user_id=? ORDER BY rowid", user.id)) {
    const access = pageAccess(user, page_id);
    if (!access || access.locked || access.encrypted || access.page.locked || access.page.kind !== "database" || rank[access.role] < 2) continue;
    return { id: access.page.id, name: access.page.title || ct("Ohne Titel", "Untitled"), icon: access.page.icon, kind: access.page.kind };
  }
  return null;
}

export function captureTargets(user: Identity) {
  return { inbox: inboxTarget(user), targets: captureTargetList(user), maxFiles: MAX_CAPTURE_FILES, maxUploadMb: maxUploadMbFor(user) };
}

// ---- Saving ----

// Multipart fields arrive as text: "1"/"true" are on.
const flag = z.union([z.boolean(), z.string().transform((v) => v === "1" || v === "true")]);
export const captureSaveSchema = z.object({
  // A page or database, or "inbox" (the capture database).
  targetId: z.union([z.uuid(), z.literal("inbox")]).default("inbox"),
  // A record of the target database: appended to its document.
  rowId: z.uuid().optional(),
  // Into a document: a new sub page (shares) or at the end of the page (scans).
  place: z.enum(["subpage", "append"]).default("subpage"),
  title: z.string().trim().max(300).optional(),
  text: z.string().max(20_000).optional(),
  url: z.string().trim().max(2000).optional(),
  // Text the phone recognised in a scanned PDF (stored as its search text).
  recognized: z.string().max(MAX_PDF_TEXT).optional(),
  scan: flag.default(false),
});
export type CaptureSave = z.input<typeof captureSaveSchema>;

type Prepared = { id: string; name: string; mime: string; content: Buffer; url: string; pdf: boolean };

function prepare(user: Identity, files: UploadFile[]): Prepared[] {
  if (files.length > MAX_CAPTURE_FILES) throw new HttpError(413, ct(`Höchstens ${MAX_CAPTURE_FILES} Dateien auf einmal.`, `At most ${MAX_CAPTURE_FILES} files at once.`));
  const maxMb = maxUploadMbFor(user);
  return files.map((file, index) => {
    if (!file.bytes.length) throw new HttpError(400, ct("Datei fehlt.", "File missing."));
    if (file.bytes.length > maxMb * 1024 * 1024) throw new HttpError(413, ct(`Maximal ${maxMb} MB pro Datei.`, `At most ${maxMb} MB per file.`));
    const mime = verifiedMime(file.type, file.bytes);
    const pdf = mime === "application/pdf";
    if (!pdf && !IMAGE.test(mime)) throw new HttpError(400, ct("Nur Bilder und PDFs können geteilt werden.", "Only images and PDFs can be shared."));
    const fileId = id();
    return {
      id: fileId,
      name: sanitizeFileName(file.name || (pdf ? `scan-${index + 1}.pdf` : `bild-${index + 1}.jpg`)),
      mime,
      content: pdf ? file.bytes : stripLocation(file.bytes, mime),
      url: `/api/files/${fileId}`,
      pdf,
    };
  });
}

// The link of a share: the url field, else the first link in the text.
function sharedLink(input: z.infer<typeof captureSaveSchema>) {
  const link = input.url || input.text?.match(/https?:\/\/\S+/)?.[0] || "";
  return /^https?:\/\/\S+$/i.test(link) ? link : "";
}
const paragraphs = (text: string) =>
  text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
const mediaHtml = (files: Prepared[]) =>
  files.map((f) => (f.pdf ? `<div data-pdf="${f.url}" data-title="${escaped(f.name)}"></div>` : `<p><img src="${f.url}" alt="${escaped(f.name)}"></p>`)).join("");

// The same content as nodes, for appending to a stored document.
function contentNodes(text: string, link: string, files: Prepared[]): PMNode[] {
  const schema = rewriteSchema();
  const nodes: Record<string, unknown>[] = paragraphs(text).map((p) => ({
    type: "paragraph",
    content: p.split("\n").flatMap((line, i) => [...(i ? [{ type: "hardBreak" }] : []), ...(line ? [{ type: "text", text: line }] : [])]),
  }));
  if (link) nodes.push({ type: "paragraph", content: [{ type: "text", text: link, marks: [{ type: "link", attrs: { href: link } }] }] });
  for (const f of files)
    nodes.push(f.pdf ? { type: "media", attrs: { src: f.url, kind: "pdf", title: f.name } } : { type: "image", attrs: { src: f.url, alt: f.name } });
  return nodes.map((node) => schema.nodeFromJSON(node));
}

function titleOf(input: z.infer<typeof captureSaveSchema>, text: string, link: string, files: Prepared[]) {
  if (input.title) return input.title.slice(0, 300);
  const line = text.split("\n").find((l) => l.trim())?.trim().slice(0, 120);
  if (line) return line;
  if (link) return new URL(link).hostname;
  if (input.scan) return ct("Scan", "Scan");
  if (files[0]) return files[0].name.replace(/\.[a-z0-9]+$/i, "");
  return ct("Geteilt", "Shared");
}

export async function saveCapture(user: Identity, raw: unknown, files: UploadFile[] = []) {
  const input = captureSaveSchema.parse(raw);
  const writer = writerOf(user);
  const targetId = input.targetId === "inbox" ? inboxTarget(user)?.id : input.targetId;
  if (!targetId) throw new HttpError(409, ct("Kein Eingang festgelegt. Bitte wähle, wohin.", "No inbox set. Please choose where to save."));
  const { page } = captureTarget(user, targetId);
  const prepared = prepare(user, files);
  const link = sharedLink(input);
  const text = (input.text || "").replace(link, "").trim();
  if (!prepared.length && !text && !link && !input.title)
    throw new HttpError(400, ct("Nichts zum Speichern.", "Nothing to save."));
  const size = prepared.reduce((sum, f) => sum + f.content.length, 0);
  if (size) {
    enforceQuota(page.workspace_id, size);
    enforceUserStorage(user, size);
  }
  const title = titleOf(input, text, link, prepared);
  const recognized = input.recognized?.trim() || "";
  const dir = resolve(process.env.FLOWPLAN_DATA_DIR || "./data", "uploads");
  if (prepared.length) mkdirSync(dir, { recursive: true });
  // Files of records belong to their database (like e-mail capture).
  const store = (ownerId: string) => {
    let textStored = false;
    for (const file of prepared) {
      const path = resolve(dir, file.id);
      writeFileSync(path, file.content);
      onTransactionRollback(() => unlinkSync(path));
      run("INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)", file.id, ownerId, file.name, file.mime, file.content.length, user.id);
      audit(user.id, "file.upload", ownerId, file.name);
      // The scan's text, recognised on the phone: the search finds it at
      // once, and the server's extraction skips the file.
      if (file.pdf && recognized && !textStored) {
        run("INSERT OR REPLACE INTO file_texts(file_id,text,status) VALUES(?,?,?)", file.id, recognized.slice(0, MAX_PDF_TEXT), "device-ocr");
        textStored = true;
      }
    }
  };
  let publish: () => void = () => {};
  const result = transaction(() => {
    const append = (pageId: string, rowId: string | null) => {
      const nodes = contentNodes(text, link, prepared);
      const changed = rewriteDocument(pageId, rowId, writer.id, (doc) => doc.type.create(doc.attrs, doc.content.append(Fragment.fromArray(nodes)), doc.marks));
      if (changed) publish = changed.publish;
      recordPageEdit(writer, pageId);
    };
    if (page.kind === "database" && input.rowId) {
      const { row } = requireRow(writer, page.id, input.rowId, true);
      ensureRowDocument(row);
      store(page.id);
      append(page.id, row.id);
      return { pageId: page.id, rowId: row.id, url: url(page.id, row.id) };
    }
    if (page.kind === "database") {
      store(page.id);
      const created = command(
        writer,
        { action: "capture.record", pageId: page.id, title, text, url: link || undefined, article: mediaHtml(prepared) || undefined },
        true,
      ) as { rowId: string };
      const filesField = visibleFields(user, page, fieldsOf(page.id)).find((f) => f.type === "files" && !f.access?.write);
      if (filesField && prepared.length) {
        const version = one<{ version: number }>("SELECT version FROM rows WHERE id=?", created.rowId)!.version;
        command(writer, { action: "row.update", pageId: page.id, rowId: created.rowId, version, cells: { [filesField.id]: prepared.map((f) => f.url) } }, true);
      }
      return { pageId: page.id, rowId: created.rowId, url: url(page.id, created.rowId) };
    }
    if (input.place === "append") {
      store(page.id);
      append(page.id, null);
      return { pageId: page.id, url: url(page.id) };
    }
    const html = cleanHtml(
      [
        ...paragraphs(text).map((p) => `<p>${escaped(p).replace(/\n/g, "<br>")}</p>`),
        link ? `<p><a href="${escaped(link)}">${escaped(link)}</a></p>` : "",
        mediaHtml(prepared),
      ].join(""),
    );
    const pageId = subPage(writer, page, title, html);
    store(pageId);
    return { pageId, url: url(pageId) };
  }, writer);
  publish();
  return { ok: true, ...result, title, files: prepared.map((f) => f.url) };
}

// ---- Spotlight ----

const plain = (html: string) =>
  html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

type SpotlightPage = Page & { space_name: string; workspace_name: string; excerpt: string | null };

// What the phone puts into its own search: the most recently changed pages
// the person may read and their open tasks – titles, place and a short
// excerpt. Nothing of end-to-end encrypted spaces, pages behind a journal
// PIN or the days of a journal.
export function spotlightItems(user: Identity) {
  const pages: SpotlightPage[] = [];
  const encryptedSpaces = new Set<string>();
  for (const { workspace_id } of all<{ workspace_id: string }>("SELECT workspace_id FROM members WHERE user_id=?", user.id)) {
    const locked = lockedPageIds(user, workspace_id);
    for (const s of all<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=? AND COALESCE(encrypted,0)=1", workspace_id)) encryptedSpaces.add(s.id);
    const rows = all<SpotlightPage>(
      `SELECT p.*,s.name space_name,w.name workspace_name,substr(d.html,1,4000) excerpt FROM pages p
         JOIN spaces s ON s.id=p.space_id JOIN workspaces w ON w.id=p.workspace_id
         LEFT JOIN documents d ON d.page_id=p.id
       WHERE p.workspace_id=? AND p.deleted_at IS NULL AND s.deleted_at IS NULL AND COALESCE(s.encrypted,0)=0
         AND COALESCE(p.synced,0)=0 AND p.journal_date IS NULL
       ORDER BY p.updated_at DESC LIMIT ?`,
      workspace_id,
      MAX_SPOTLIGHT_PAGES * 2,
    );
    for (const page of rows) if (!locked.has(page.id) && pageRole(user, page)) pages.push(page);
  }
  pages.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  const spaceOf = new Map<string, string>();
  const tasks = openTasksEverywhere(user)
    .filter((task) => {
      if (!spaceOf.has(task.pageId)) spaceOf.set(task.pageId, one<{ space_id: string }>("SELECT space_id FROM pages WHERE id=?", task.pageId)?.space_id || "");
      return !encryptedSpaces.has(spaceOf.get(task.pageId)!);
    })
    .slice(0, MAX_SPOTLIGHT_TASKS);
  return {
    pages: pages.slice(0, MAX_SPOTLIGHT_PAGES).map((p) => ({
      id: p.id,
      title: (p.title || ct("Ohne Titel", "Untitled")).slice(0, 200),
      icon: p.icon || "",
      kind: p.kind,
      place: [p.workspace_name, p.space_name].filter(Boolean).join(" · ").slice(0, 120),
      excerpt: plain(p.excerpt || "").slice(0, 300),
      updatedAt: p.updated_at,
      url: url(p.id),
    })),
    tasks: tasks.map((t) => ({
      id: `${t.pageId}:${t.rowId || ""}:${t.index}`,
      text: t.text.slice(0, 200),
      page: (t.title || "").slice(0, 120),
      due: t.due,
      url: url(t.pageId, t.rowId),
    })),
    at: Date.now(),
  };
}
