// What notebooks bring along besides their sheets: pictures of the page to
// put on a sheet, the person's own stickers and the workspace's own paper
// templates (tables in lib/db.ts, migrateNotebookLibrary).
//
//   notebook_stickers(id, workspace_id, user_id, name, mime, data, items, width, height)
//     A person's sticker collection, per workspace (data stays in the
//     workspace it came from): a picture (data, PNG/JPEG/WebP/GIF) or ink
//     (items: a lasso selection, top left at 0,0). Only its owner sees it.
//   notebook_templates(id, workspace_id, name, kind, mime, data, width, height, fit, created_by)
//     Paper templates of a workspace, shared with its members: a picture or
//     one page of a PDF (kept as a PDF of that page). Members (not guests)
//     add them; the one who added it and owners or admins of the workspace
//     rename or delete them.
//
// Nothing here is served to a page directly: inserting a sticker or using
// a template copies the file onto the notebook page (an ordinary
// attachment, counted against the workspace quota and the person's
// storage), so sheets keep their pictures and paper when a sticker or
// template is deleted, and share links, publications, copies and exports
// treat them like every other file of the page.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PDFDocument } from "pdf-lib";
import { z } from "zod";
import { all, id, one, run } from "./db";
import { HttpError } from "./auth";
import { isGuest, requireMember, requirePage } from "./permissions";
import { requireUnlocked } from "./journal-extras";
import { hiddenFileIds } from "./row-files";
import { isEncryptedPage } from "./e2ee-server";
import { ensureLocal } from "./storage";
import { storeUpload } from "./page-upload";
import { enforceQuota } from "./instance-ops";
import { enforceUserStorage, maxUploadMbFor } from "./user-limits";
import { imageInfo, jpegInfo } from "./image-decode";
import { sanitizeFileName, stripLocation, verifiedMime } from "./upload-safety";
import { itemBounds, transformItems, unionBox } from "./ink/geometry";
import { cleanItem, INK_LIMITS, type InkItem } from "./ink/model";
import { withoutRec } from "./ink/audio-sync";
import { cleanPaperImage, PAPER_FITS, type PaperFit, type PaperImage } from "./notebook-paper";
import type { Identity, Page } from "./types";

export const STICKER_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export const TEMPLATE_TYPES = ["image/png", "image/jpeg", "image/webp", "application/pdf"] as const;
export const NOTEBOOK_LIBRARY_LIMITS = {
  stickersPerPerson: 300,
  stickerBytes: 5 * 1024 * 1024,
  stickerItems: 1000,
  templatesPerWorkspace: 200,
  templateBytes: 20 * 1024 * 1024,
};
const INK_MIME = "application/x-flowplan-ink";
const uuid = z.uuid();
const nameSchema = z.string().trim().min(1).max(120);
const uploads = () => resolve(process.env.FLOWPLAN_DATA_DIR || "./data", "uploads");
const r2 = (n: number) => Math.round(n * 100) / 100;
// Pixels of a picture as points (96 per inch, like the browser shows them).
const PX = 0.75;

async function readUpload(fileId: string) {
  await ensureLocal(fileId);
  try {
    return readFileSync(resolve(uploads(), fileId));
  } catch {
    throw new HttpError(404, "Datei fehlt.");
  }
}

// A notebook page the person writes on (pictures, stickers and paper go
// onto it): editable, unlocked, journal PIN entered, not end-to-end encrypted.
export async function notebookForWriting(user: Identity, pageId: unknown) {
  const page = await requirePage(user, uuid.parse(pageId), true);
  await requireUnlocked(user, page);
  if (page.kind !== "notebook") throw new HttpError(400, "Kein Notizbuch.");
  if (page.locked) throw new HttpError(409, "Seite ist gesperrt");
  if (await isEncryptedPage(page)) throw new HttpError(409, "Für verschlüsselte Seiten nicht verfügbar.");
  return page;
}
async function notebookForReading(user: Identity, pageId: unknown) {
  const page = await requirePage(user, uuid.parse(pageId));
  await requireUnlocked(user, page);
  if (page.kind !== "notebook") throw new HttpError(400, "Kein Notizbuch.");
  return page;
}

// ---- Pictures of the page ----

export type NotebookPicture = { id: string; name: string; mime: string; url: string; width: number | null; height: number | null };
// The pictures attached to the notebook page that this person may see
// (not in the trash; files of hidden records never apply here).
export async function notebookPictures(user: Identity, pageId: unknown): Promise<NotebookPicture[]> {
  const page = await notebookForReading(user, pageId);
  if (await isEncryptedPage(page)) return [];
  const hidden = await hiddenFileIds(user, page);
  const rows = await all<{ id: string; name: string; mime: string; w: number | null; h: number | null }>(
    `SELECT id,name,mime,width w,height h FROM files
     WHERE page_id=? AND deleted_at IS NULL AND mime IN ('image/png','image/jpeg','image/webp','image/gif','image/avif') ORDER BY created_at DESC,seq DESC LIMIT 500`,
    page.id,
  );
  return rows
    .filter((f) => !hidden.has(f.id))
    .map((f) => ({ id: f.id, name: f.name, mime: f.mime, url: `/api/files/${f.id}`, width: f.w ?? null, height: f.h ?? null }));
}

// Attachments of a page outside the trash (what exports may embed; saves
// keep pictures of any file of the page, lib/page-ink-store.ts).
export async function pageFileIds(pageId: string): Promise<Set<string>> {
  return new Set((await all<{ id: string }>("SELECT id FROM files WHERE page_id=? AND deleted_at IS NULL", pageId)).map((r) => r.id.toLowerCase()));
}

// A copy of bytes as an attachment of the page – or the attachment that
// already holds the same (name, type and size), e.g. a sticker used twice.
async function attach(user: Identity, page: Page, file: { name: string; mime: string; content: Buffer }) {
  const same = await all<{ id: string }>(
    "SELECT id FROM files WHERE page_id=? AND name=? AND mime=? AND size=? AND deleted_at IS NULL",
    page.id,
    file.name,
    file.mime,
    file.content.length,
  );
  for (const row of same) {
    try {
      if ((await readUpload(row.id)).equals(file.content)) return row.id;
    } catch {}
  }
  const fileId = id();
  await storeUpload(user, page, { id: fileId, ...file });
  return fileId;
}
const extension = (mime: string) => ({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "application/pdf": "pdf" })[mime] || "bin";

// ---- Stickers ----

type StickerRow = { id: string; workspace_id: string; user_id: string; name: string; mime: string; data: Uint8Array | null; items: string | null; width: number; height: number; created_at: number };
export type StickerEntry = { id: string; name: string; kind: "image" | "ink"; width: number; height: number; url: string | null; items?: InkItem[] };

const parseItems = (json: string | null): InkItem[] => {
  try {
    return (JSON.parse(json || "[]") as unknown[]).map(cleanItem).filter((i): i is InkItem => !!i);
  } catch {
    return [];
  }
};
function stickerEntry(row: StickerRow): StickerEntry {
  const ink = row.mime === INK_MIME;
  return {
    id: row.id,
    name: row.name,
    kind: ink ? "ink" : "image",
    width: row.width,
    height: row.height,
    url: ink ? null : `/api/notebook-library/${row.id}`,
    ...(ink ? { items: parseItems(row.items) } : {}),
  };
}
async function ownSticker(user: Identity, stickerId: unknown) {
  const row = await one<StickerRow>("SELECT * FROM notebook_stickers WHERE id=? AND user_id=?", uuid.parse(stickerId), user.id);
  if (!row) throw new HttpError(404, "Sticker nicht gefunden.");
  await requireMember(user, row.workspace_id);
  return row;
}
export async function listStickers(user: Identity, pageId: unknown) {
  const page = await notebookForReading(user, pageId);
  await requireMember(user, page.workspace_id);
  return (await all<StickerRow>("SELECT * FROM notebook_stickers WHERE workspace_id=? AND user_id=? ORDER BY created_at DESC", page.workspace_id, user.id)).map(stickerEntry);
}
async function roomForSticker(user: Identity, workspaceId: string, bytes: number) {
  const n = (await one<{ n: number }>("SELECT COUNT(*) n FROM notebook_stickers WHERE workspace_id=? AND user_id=?", workspaceId, user.id))?.n ?? 0;
  if (n >= NOTEBOOK_LIBRARY_LIMITS.stickersPerPerson) throw new HttpError(409, `Höchstens ${NOTEBOOK_LIBRARY_LIMITS.stickersPerPerson} eigene Sticker.`);
  if (bytes) {
    await enforceQuota(workspaceId, bytes);
    await enforceUserStorage(user, bytes);
  }
}
// Ink as a sticker: its items moved to the top left (0, 0). Pictures of
// files are left out (their file belongs to a page); built-in stickers stay.
export function stickerInk(raw: unknown): { items: InkItem[]; width: number; height: number } {
  const list = z.array(z.unknown()).min(1).max(NOTEBOOK_LIBRARY_LIMITS.stickerItems).parse(raw);
  // Without recording marks: a sticker is placed anywhere, any time.
  const items = withoutRec(list.map(cleanItem).filter((i): i is InkItem => !!i && !(i.type === "image" && i.file)));
  const box = unionBox(items.map(itemBounds));
  if (!items.length || !box) throw new HttpError(400, "Die Auswahl ist leer.");
  const moved = transformItems(items, new Set(items.map((i) => i.id)), { dx: -box.x, dy: -box.y });
  return { items: moved, width: r2(Math.max(1, box.w)), height: r2(Math.max(1, box.h)) };
}
// "Save as sticker": a picture of the notebook page (fileId) or ink items.
export async function saveSticker(user: Identity, b: Record<string, unknown>) {
  const page = await notebookForReading(user, b.pageId);
  await requireMember(user, page.workspace_id);
  if (user.apiScope === "read") throw new HttpError(403, "Dieses API-Token darf nur lesen.");
  if (await isEncryptedPage(page)) throw new HttpError(409, "Für verschlüsselte Seiten nicht verfügbar.");
  const name = nameSchema.catch("Sticker").parse(b.name);
  const stickerId = id();
  if (b.fileId !== undefined) {
    const fileId = uuid.parse(b.fileId);
    const file = await one<{ id: string; mime: string; size: number }>("SELECT id,mime,size FROM files WHERE id=? AND page_id=? AND deleted_at IS NULL", fileId, page.id);
    if (!file || (await hiddenFileIds(user, page)).has(file.id)) throw new HttpError(404, "Datei fehlt.");
    if (!(STICKER_IMAGE_TYPES as readonly string[]).includes(file.mime)) throw new HttpError(400, "Bitte PNG, JPEG, GIF oder WebP verwenden.");
    if (file.size > NOTEBOOK_LIBRARY_LIMITS.stickerBytes) throw new HttpError(413, "Das Bild ist zu groß für einen Sticker (höchstens 5 MB).");
    const data = await readUpload(file.id);
    const info = imageInfo(data);
    if (!info) throw new HttpError(400, "Das Bild lässt sich nicht lesen.");
    await roomForSticker(user, page.workspace_id, data.length);
    await run(
      "INSERT INTO notebook_stickers(id,workspace_id,user_id,name,mime,data,items,width,height,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      stickerId,
      page.workspace_id,
      user.id,
      name,
      file.mime,
      data,
      null,
      info.width,
      info.height,
      Date.now(),
    );
  } else {
    const ink = stickerInk(b.items);
    const json = JSON.stringify(ink.items);
    if (json.length > 2_000_000) throw new HttpError(413, "Die Auswahl ist zu groß für einen Sticker.");
    await roomForSticker(user, page.workspace_id, 0);
    await run(
      "INSERT INTO notebook_stickers(id,workspace_id,user_id,name,mime,data,items,width,height,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      stickerId,
      page.workspace_id,
      user.id,
      name,
      INK_MIME,
      null,
      json,
      ink.width,
      ink.height,
      Date.now(),
    );
  }
  return stickerEntry((await one<StickerRow>("SELECT * FROM notebook_stickers WHERE id=?", stickerId))!);
}
export async function renameSticker(user: Identity, b: Record<string, unknown>) {
  const row = await ownSticker(user, b.stickerId);
  await run("UPDATE notebook_stickers SET name=? WHERE id=?", nameSchema.parse(b.name), row.id);
  return { ok: true };
}
export async function deleteSticker(user: Identity, b: Record<string, unknown>) {
  const row = await ownSticker(user, b.stickerId);
  await run("DELETE FROM notebook_stickers WHERE id=?", row.id);
  return { ok: true };
}
// A sticker onto a notebook page: pictures become an attachment of the page
// (a copy), ink comes back as items to place.
export async function insertSticker(user: Identity, b: Record<string, unknown>) {
  const page = await notebookForWriting(user, b.pageId);
  const row = await ownSticker(user, b.stickerId);
  if (row.workspace_id !== page.workspace_id) throw new HttpError(404, "Sticker nicht gefunden.");
  if (row.mime === INK_MIME) return { kind: "ink", items: parseItems(row.items), width: row.width, height: row.height };
  const content = Buffer.from(row.data || []);
  const fileId = await attach(user, page, { name: sanitizeFileName(`${row.name}.${extension(row.mime)}`, "sticker"), mime: row.mime, content });
  return { kind: "image", fileId, width: row.width, height: row.height };
}

// ---- Paper templates ----

type TemplateRow = {
  id: string;
  workspace_id: string;
  name: string;
  kind: "image" | "pdf";
  mime: string;
  data: Uint8Array;
  width: number;
  height: number;
  fit: PaperFit;
  created_by: string | null;
  created_at: number;
};
export type TemplateEntry = { id: string; name: string; kind: "image" | "pdf"; width: number; height: number; fit: PaperFit; url: string; author: string; canEdit: boolean };

async function mayManage(user: Identity, row: Pick<TemplateRow, "workspace_id" | "created_by">) {
  const role = await requireMember(user, row.workspace_id);
  if (await isGuest(user, row.workspace_id)) return false;
  return row.created_by === user.id || role === "owner";
}
export async function listTemplates(user: Identity, pageId: unknown): Promise<TemplateEntry[]> {
  const page = await notebookForReading(user, pageId);
  await requireMember(user, page.workspace_id);
  const rows = await all<Omit<TemplateRow, "data"> & { author: string | null }>(
    "SELECT t.id,t.workspace_id,t.name,t.kind,t.mime,t.width,t.height,t.fit,t.created_by,t.created_at,u.name author FROM notebook_templates t LEFT JOIN users u ON u.id=t.created_by WHERE t.workspace_id=? ORDER BY lower(t.name),t.created_at",
    page.workspace_id,
  );
  const out: TemplateEntry[] = [];
  for (const row of rows)
    out.push({
      id: row.id,
      name: row.name,
      kind: row.kind,
      width: row.width,
      height: row.height,
      fit: row.fit,
      url: `/api/notebook-library/${row.id}`,
      author: row.author || "",
      canEdit: await mayManage(user, row),
    });
  return out;
}
// Page `pageNumber` (from 1) of a PDF as a PDF of its own, and its size as
// shown (rotation and crop box applied), in points.
export async function pdfTemplatePage(bytes: Uint8Array, pageNumber: number) {
  let source: PDFDocument;
  try {
    source = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch {
    throw new HttpError(400, "Das PDF lässt sich nicht lesen (verschlüsselt oder beschädigt).");
  }
  if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > source.getPageCount()) throw new HttpError(400, "Diese Seite hat das PDF nicht.");
  const out = await PDFDocument.create();
  const [copy] = await out.copyPages(source, [pageNumber - 1]);
  out.addPage(copy);
  const box = copy.getCropBox();
  const turned = Math.abs(copy.getRotation().angle) % 180 === 90;
  return { data: Buffer.from(await out.save()), width: r2(turned ? box.height : box.width), height: r2(turned ? box.width : box.height) };
}
// A new template from an upload (POST /api/notebook-library, multipart):
// checked like any upload (size, type from the content, no location in
// photos), counted against the quota; of a PDF only page `pdfPage` is kept.
export async function createTemplate(user: Identity, input: { pageId: unknown; name: unknown; fit: unknown; pdfPage: unknown; file: { name: string; type: string; bytes: Buffer } }) {
  const page = await notebookForReading(user, input.pageId);
  await requireMember(user, page.workspace_id, "editor");
  if (await isEncryptedPage(page)) throw new HttpError(409, "Für verschlüsselte Seiten nicht verfügbar.");
  const maxUpload = Math.min(NOTEBOOK_LIBRARY_LIMITS.templateBytes, (await maxUploadMbFor(user)) * 1024 * 1024);
  if (input.file.bytes.length > maxUpload) throw new HttpError(413, `Maximal ${Math.round(maxUpload / 1024 / 1024)} MB pro Vorlage.`);
  const mime = verifiedMime(input.file.type, input.file.bytes);
  if (!(TEMPLATE_TYPES as readonly string[]).includes(mime)) throw new HttpError(400, "Bitte ein Bild (PNG, JPEG, WebP) oder ein PDF wählen.");
  let data: Buffer, width: number, height: number;
  const kind = mime === "application/pdf" ? "pdf" : "image";
  if (kind === "pdf") ({ data, width, height } = await pdfTemplatePage(input.file.bytes, Number(input.pdfPage ?? 1)));
  else {
    data = stripLocation(input.file.bytes, mime);
    const info = imageInfo(data);
    if (!info?.width || !info.height) throw new HttpError(400, "Das Bild lässt sich nicht lesen.");
    width = r2(info.width * PX);
    height = r2(info.height * PX);
  }
  const count = (await one<{ n: number }>("SELECT COUNT(*) n FROM notebook_templates WHERE workspace_id=?", page.workspace_id))?.n ?? 0;
  if (count >= NOTEBOOK_LIBRARY_LIMITS.templatesPerWorkspace)
    throw new HttpError(409, `Dieser Arbeitsbereich hat schon ${NOTEBOOK_LIBRARY_LIMITS.templatesPerWorkspace} Papiervorlagen.`);
  await enforceQuota(page.workspace_id, data.length);
  await enforceUserStorage(user, data.length);
  const templateId = id();
  const name = nameSchema.catch(sanitizeFileName(input.file.name).replace(/\.[^.]+$/, "").slice(0, 120) || "Vorlage").parse(input.name);
  const fit = PAPER_FITS.includes(input.fit as PaperFit) ? (input.fit as PaperFit) : "stretch";
  await run(
    "INSERT INTO notebook_templates(id,workspace_id,name,kind,mime,data,width,height,fit,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    templateId,
    page.workspace_id,
    name,
    kind,
    kind === "pdf" ? "application/pdf" : mime,
    data,
    width,
    height,
    fit,
    user.id,
    Date.now(),
  );
  return (await listTemplates(user, page.id)).find((t) => t.id === templateId)!;
}
async function managedTemplate(user: Identity, templateId: unknown) {
  const row = await one<Omit<TemplateRow, "data">>("SELECT id,workspace_id,created_by FROM notebook_templates WHERE id=?", uuid.parse(templateId));
  if (!row) throw new HttpError(404, "Vorlage fehlt.");
  if (!(await mayManage(user, row))) throw new HttpError(403, "Nur wer die Vorlage angelegt hat oder ein Besitzer darf sie ändern.");
  return row;
}
export async function updateTemplate(user: Identity, b: Record<string, unknown>) {
  const row = await managedTemplate(user, b.templateId);
  if (b.name !== undefined) await run("UPDATE notebook_templates SET name=? WHERE id=?", nameSchema.parse(b.name), row.id);
  if (b.fit !== undefined) await run("UPDATE notebook_templates SET fit=? WHERE id=?", z.enum(PAPER_FITS).parse(b.fit), row.id);
  return { ok: true };
}
// Sheets that use the template keep their copy on the page.
export async function deleteTemplate(user: Identity, b: Record<string, unknown>) {
  const row = await managedTemplate(user, b.templateId);
  await run("DELETE FROM notebook_templates WHERE id=?", row.id);
  return { ok: true };
}

// The paper image to store: a template chosen in the dialog becomes a copy
// on the page (one copy per template and page, reused while it is there);
// a file must be an attachment of the page. null: no own paper.
export async function resolvePaperImage(user: Identity, page: Page, raw: unknown): Promise<PaperImage | null | undefined> {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  const image = cleanPaperImage(raw);
  if (!image) throw new HttpError(400, "Ungültige Papiervorlage.");
  if (image.file) {
    if (!(await one("SELECT 1 FROM files WHERE id=? AND page_id=?", image.file, page.id))) throw new HttpError(404, "Datei fehlt.");
    return image;
  }
  const row = await one<TemplateRow>("SELECT * FROM notebook_templates WHERE id=? AND workspace_id=?", image.template!, page.workspace_id);
  if (!row) throw new HttpError(404, "Vorlage fehlt.");
  await requireMember(user, row.workspace_id);
  const content = Buffer.from(row.data);
  const fileId = await attach(user, page, { name: sanitizeFileName(`${row.name}.${extension(row.mime)}`, "vorlage"), mime: row.mime, content });
  return { file: fileId, template: row.id, name: row.name, kind: row.kind, width: row.width, height: row.height, fit: raw && typeof raw === "object" && "fit" in raw ? image.fit : row.fit };
}

// The bytes of a sticker or template for its picture in the panels
// (GET /api/notebook-library/{id}): stickers for their owner, templates
// for members of the workspace.
export async function libraryFile(user: Identity, assetId: string) {
  const key = uuid.parse(assetId);
  const sticker = await one<StickerRow>("SELECT * FROM notebook_stickers WHERE id=? AND user_id=?", key, user.id);
  if (sticker?.data) {
    await requireMember(user, sticker.workspace_id);
    return { name: `${sticker.name}.${extension(sticker.mime)}`, mime: sticker.mime, data: Buffer.from(sticker.data) };
  }
  const template = await one<TemplateRow>("SELECT * FROM notebook_templates WHERE id=?", key);
  if (template) {
    await requireMember(user, template.workspace_id);
    return { name: `${template.name}.${extension(template.mime)}`, mime: template.mime, data: Buffer.from(template.data) };
  }
  throw new HttpError(404, "Nicht gefunden.");
}

// Pictures on sheets in exports on the server: PNG and JPEG of the page
// (JPEG with its EXIF orientation); other types show as grey boxes.
export function serverImageLoader(allowed: Set<string>) {
  return async (fileId: string) => {
    if (!allowed.has(fileId.toLowerCase())) return null;
    try {
      const bytes = await readUpload(fileId);
      if (bytes[0] === 0x89 && bytes.subarray(1, 4).toString("latin1") === "PNG") return { bytes, type: "png" as const };
      if (bytes[0] === 0xff && bytes[1] === 0xd8) return { bytes, type: "jpg" as const, orientation: jpegInfo(bytes)?.orientation || 1 };
    } catch {}
    return null;
  };
}
// The same as data: addresses for SVG pictures of sheets (exports that
// leave Flowplan: EPUB, Word, Markdown, PDF print). At most `budget` bytes.
export async function imageDataUrls(fileIds: string[], allowed: Set<string>, budget = 12 * 1024 * 1024) {
  const out = new Map<string, string>();
  let used = 0;
  for (const fileId of fileIds) {
    if (!allowed.has(fileId.toLowerCase())) continue;
    const row = await one<{ mime: string; size: number }>("SELECT mime,size FROM files WHERE id=? AND deleted_at IS NULL", fileId);
    if (!row || !/^image\/(png|jpeg|gif|webp|avif)$/.test(row.mime) || used + row.size > budget) continue;
    try {
      const bytes = await readUpload(fileId);
      used += bytes.length;
      out.set(fileId, `data:${row.mime};base64,${bytes.toString("base64")}`);
    } catch {}
  }
  return out;
}

export { INK_LIMITS };
