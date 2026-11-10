// Notebook pages: a sequence of sheets with paper (lined, grid, … –
// lib/notebook-paper.ts) or a page of an imported PDF as background, and
// handwriting on each sheet (lib/page-ink-store.ts, surface = sheet id).
//
//   notebooks(page_id, paper)              the notebook's default paper
//   notebook_sheets(id, page_id, position, paper, background)
//     paper: the sheet's own choices over the default ({} = as the notebook)
//     background: {file, page, width, height} – page `page` of the PDF file
//                 `file` (attached to the notebook page), its size as shown
//                 in points; the ink lies over it like on a PDF.
//     paper.image: an own paper template (lib/notebook-paper.ts PaperImage),
//                 a copy attached to the page (lib/notebook-library.ts).
import { z } from "zod";
import { all, id, one, run } from "./db";
import { HttpError } from "./auth";
import { cleanPaper, DEFAULT_PAPER, fullPaper, insertAfter, MAX_IMPORT_PAGES, MAX_SHEETS, sameSheets, type Paper, type PaperOverride } from "./notebook-paper";
import { copyPageInk, deleteSurface, mayEditInk, pageInkDocs, writeSurface } from "./page-ink-store";
import { emptyInk, hasInk, inkText, mapInkFiles, parseInk, serializeInk, type InkDoc } from "./ink/model";
import { resolvePaperImage } from "./notebook-library";
import { cleanRecognizedText } from "./ink/recognized";
import { isPdfFile } from "./ink-store";
import type { Identity, Page } from "./types";
import { forEachAsync } from "./each-async";
import { cleanLinks, cleanOutline, cleanTitle, parseLinks, parseOutline, type NotebookLink, type OutlineEntry } from "./notebook-organize-model";
import { organizeCommand, ORGANIZE_ACTIONS, trashSheets } from "./notebook-organize";

export { MAX_SHEETS, MAX_IMPORT_PAGES };

export type NotebookBackground = { file: string; page: number; width: number; height: number };
// title, bookmark, links: only when the sheet has them (lib/notebook-organize.ts).
export type NotebookSheet = {
  id: string;
  position: number;
  paper: PaperOverride;
  background: NotebookBackground | null;
  title?: string;
  bookmark?: boolean;
  links?: NotebookLink[];
};
// recognized: the text recognised in the handwriting (search in the overview).
export type NotebookSheetData = NotebookSheet & { ink: InkDoc; version: number; recognized?: string };
export type NotebookPayload = { paper: Paper; sheets: NotebookSheetData[]; canEdit: boolean; outline?: OutlineEntry[] };

const backgroundSchema = z.object({
  file: z.uuid(),
  page: z.number().int().min(1).max(100000),
  width: z.number().finite().min(10).max(14400),
  height: z.number().finite().min(10).max(14400),
});
export function parseBackground(value: string | null | undefined): NotebookBackground | null {
  if (!value) return null;
  try {
    const parsed = backgroundSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
const parsePaper = (value: string | null | undefined): PaperOverride => {
  try {
    return cleanPaper(JSON.parse(value || "{}"));
  } catch {
    return {};
  }
};

export async function notebookPaper(pageId: string): Promise<Paper> {
  return fullPaper(JSON.parse((await one<{ paper: string }>("SELECT paper FROM notebooks WHERE page_id=?", pageId))?.paper || "{}"));
}
export async function notebookSheets(pageId: string): Promise<NotebookSheet[]> {
  const rows = await all<{ id: string; position: number; paper: string; background: string | null; title: string | null; bookmark: number | null; links: string | null }>(
    "SELECT id,position,paper,background,title,bookmark,links FROM notebook_sheets WHERE page_id=? ORDER BY position,created_at",
    pageId,
  );
  const ids = new Set(rows.map((s) => s.id));
  return rows.map((s) => {
    const links = parseLinks(s.links, ids);
    return {
      id: s.id,
      position: s.position,
      paper: parsePaper(s.paper),
      background: parseBackground(s.background),
      ...(s.title ? { title: s.title } : {}),
      ...(s.bookmark ? { bookmark: true } : {}),
      ...(links.length ? { links } : {}),
    };
  });
}
// The table of contents, without entries of sheets that are gone.
export async function notebookOutline(pageId: string, sheets?: NotebookSheet[]): Promise<OutlineEntry[]> {
  const stored = (await one<{ outline: string | null }>("SELECT outline FROM notebooks WHERE page_id=?", pageId))?.outline;
  return parseOutline(stored, new Set((sheets ?? (await notebookSheets(pageId))).map((s) => s.id)));
}
// A sheet's title, bookmark and links as stored (copies, restores).
export async function writeSheetMeta(sheetId: string, meta: { title?: unknown; bookmark?: unknown; links?: unknown }) {
  await run(
    "UPDATE notebook_sheets SET title=?,bookmark=?,links=? WHERE id=?",
    cleanTitle(meta.title),
    meta.bookmark ? 1 : 0,
    JSON.stringify(cleanLinks(meta.links)),
    sheetId,
  );
}

export async function insertSheet(pageId: string, paper: PaperOverride = {}, background: NotebookBackground | null = null, sheetId: string = id()) {
  await run(
    "INSERT INTO notebook_sheets(id,page_id,position,paper,background,created_at) VALUES(?,?,?,?,?,?)",
    sheetId,
    pageId,
    0,
    JSON.stringify(cleanPaper(paper)),
    background ? JSON.stringify(background) : null,
    Date.now(),
  );
  return sheetId;
}
export async function writeOrder(pageId: string, ids: string[]) {
  await forEachAsync(ids, async (sheetId, index) => await run("UPDATE notebook_sheets SET position=? WHERE id=? AND page_id=?", index, sheetId, pageId));
}
export const order = async (pageId: string) => (await notebookSheets(pageId)).map((s) => s.id);

// A new notebook with its first sheet (lib/seed.ts createPage).
export async function createNotebook(pageId: string, paper: Partial<Paper> = {}) {
  await run("INSERT INTO notebooks(page_id,paper,updated_at) VALUES(?,?,?) ON CONFLICT DO NOTHING", pageId, JSON.stringify({ ...DEFAULT_PAPER, ...cleanPaper(paper) }), Date.now());
  if (!(await one("SELECT 1 FROM notebook_sheets WHERE page_id=?", pageId))) await insertSheet(pageId);
}

export async function notebookData(user: Identity, page: Page): Promise<NotebookPayload> {
  const inks = await pageInkDocs(page.id);
  const sheets = await notebookSheets(page.id);
  return {
    paper: await notebookPaper(page.id),
    sheets: sheets.map((sheet) => {
      const ink = inks.get(sheet.id);
      return { ...sheet, ink: ink?.doc ?? emptyInk(), version: ink?.version ?? 0, ...(ink?.recognized ? { recognized: ink.recognized } : {}) };
    }),
    canEdit: await mayEditInk(user, page),
    outline: await notebookOutline(page.id, sheets),
  };
}

// Each PDF page becomes a sheet with that page as background: page numbers
// from 1, the sizes as shown (rotation and crop box applied, points).
export function pdfImportSheets(fileId: string, sizes: { width: number; height: number }[]): NotebookBackground[] {
  return sizes.map((size, index) =>
    backgroundSchema.parse({ file: fileId, page: index + 1, width: Math.round(size.width * 100) / 100, height: Math.round(size.height * 100) / 100 }),
  );
}

const sheetId = z.string().regex(/^[\w-]{1,40}$/);
const after = sheetId.nullable().optional();

// Where new sheets go: after a sheet, before the first one, or at the end.
export type SheetPlace = { after: string } | "start" | "end";
export function sheetPlace(b: Record<string, unknown>): SheetPlace {
  if (b.at === "start") return "start";
  const previous = after.parse(b.after ?? null) ?? null;
  return previous ? { after: previous } : "end";
}
// `ids` with the new sheets `created` (in their order) at `place`; an
// unknown sheet to follow puts them at the end.
export function placeSheets(ids: string[], created: string[], place: SheetPlace): string[] {
  const fresh = new Set(created);
  const list = ids.filter((x) => !fresh.has(x));
  const index = place === "start" ? 0 : place === "end" ? list.length : list.indexOf(place.after) + 1 || list.length;
  return [...list.slice(0, index), ...created, ...list.slice(index)];
}

// The notebook commands (lib/api.ts); `page` is checked for editing.
export async function notebookCommand(user: Identity, page: Page, action: string, b: Record<string, unknown>) {
  if (page.kind !== "notebook") throw new HttpError(400, "Kein Notizbuch.");
  await createNotebook(page.id);
  const touch = async () => await run("UPDATE notebooks SET updated_at=? WHERE page_id=?", Date.now(), page.id);
  const known = async (sid: string) => {
    if (!(await one("SELECT 1 FROM notebook_sheets WHERE id=? AND page_id=?", sid, page.id))) throw new HttpError(404, "Blatt nicht gefunden.");
    return sid;
  };
  const room = async (count: number) => {
    const n = (await one<{ n: number }>("SELECT COUNT(*) n FROM notebook_sheets WHERE page_id=?", page.id))?.n ?? 0;
    if (n + count > MAX_SHEETS) throw new HttpError(413, `Ein Notizbuch hat höchstens ${MAX_SHEETS} Blätter.`);
  };
  const result: Record<string, unknown> = {};
  // An own template chosen in the dialog becomes a copy on the page.
  const withImage = async (raw: unknown): Promise<PaperOverride> => {
    const paper = cleanPaper(raw);
    const image = raw && typeof raw === "object" ? await resolvePaperImage(user, page, (raw as { image?: unknown }).image) : undefined;
    if (image !== undefined) paper.image = image;
    else delete paper.image;
    return paper;
  };
  switch (action) {
    case "notebook.paper": {
      const paper = { ...(await notebookPaper(page.id)), ...(await withImage(b.paper)) };
      await run("UPDATE notebooks SET paper=? WHERE page_id=?", JSON.stringify(paper), page.id);
      // "For all sheets": their own choices go.
      if (b.all === true) await run("UPDATE notebook_sheets SET paper='{}' WHERE page_id=? AND background IS NULL", page.id);
      break;
    }
    case "notebook.sheet.add": {
      const count = z.number().int().min(1).max(50).default(1).parse(b.count ?? undefined);
      await room(count);
      const place = sheetPlace(b);
      if (typeof place === "object") await known(place.after);
      const created: string[] = [];
      const own = await withImage(b.paper);
      for (let i = 0; i < count; i++) created.push(await insertSheet(page.id, own));
      await writeOrder(page.id, placeSheets(await order(page.id), created, place));
      result.created = created;
      break;
    }
    case "notebook.sheet.duplicate": {
      const source = await known(sheetId.parse(b.sheetId));
      await room(1);
      const row = (await one<{ paper: string; background: string | null; title: string | null; bookmark: number | null; links: string | null }>(
        "SELECT paper,background,title,bookmark,links FROM notebook_sheets WHERE id=?",
        source,
      ))!;
      const sid = await insertSheet(page.id, parsePaper(row.paper), parseBackground(row.background));
      await writeSheetMeta(sid, { title: row.title, bookmark: row.bookmark, links: parseLinks(row.links) });
      await copyPageInk(page.id, page.id, new Map([[source, sid]]), user.id);
      await writeOrder(page.id, insertAfter(await order(page.id), sid, source));
      result.created = [sid];
      const ink = (await pageInkDocs(page.id)).get(sid);
      result.ink = { [sid]: { doc: ink?.doc ?? emptyInk(), version: ink?.version ?? 0 } };
      break;
    }
    case "notebook.sheet.delete": {
      // Into the notebook's trash (lib/notebook-organize.ts): undo, restore.
      result.trashed = await trashSheets(user, page, [await known(sheetId.parse(b.sheetId))]);
      break;
    }
    case "notebook.sheet.move": {
      const next = z.array(sheetId).max(MAX_SHEETS).parse(b.order);
      if (!sameSheets(await order(page.id), next)) throw new HttpError(409, "Die Blätter haben sich inzwischen geändert.");
      await writeOrder(page.id, next);
      break;
    }
    case "notebook.sheet.paper": {
      const ids = z.array(sheetId).min(1).max(MAX_SHEETS).parse(b.sheetIds);
      const paper = b.paper === null ? {} : await withImage(b.paper);
      for (const sid of ids) await run("UPDATE notebook_sheets SET paper=? WHERE id=? AND page_id=?", JSON.stringify(paper), await known(sid), page.id);
      break;
    }
    case "notebook.import": {
      const fileId = z.uuid().parse(b.fileId);
      const file = await one<{ id: string; name: string; mime: string }>("SELECT id,name,mime FROM files WHERE id=? AND page_id=?", fileId, page.id);
      if (!file) throw new HttpError(404, "Datei fehlt.");
      if (!isPdfFile(file)) throw new HttpError(400, "Nur PDFs lassen sich als Notizbuch öffnen.");
      const sizes = z
        .array(z.object({ width: z.number().finite(), height: z.number().finite() }))
        .min(1)
        .max(MAX_IMPORT_PAGES)
        .parse(b.pages);
      await room(sizes.length);
      const backgrounds = pdfImportSheets(file.id, sizes);
      // Before the first sheet, after any sheet or at the end.
      const place = sheetPlace(b);
      if (typeof place === "object") await known(place.after);
      // A fresh notebook (one empty sheet) becomes the PDF.
      const sheets = await notebookSheets(page.id);
      const replace = b.replaceEmpty === true && sheets.length === 1 && !sheets[0].background && !hasInk((await pageInkDocs(page.id)).get(sheets[0].id)?.doc);
      const created: string[] = [];
      for (const background of backgrounds) created.push(await insertSheet(page.id, {}, background));
      let ids = placeSheets(await order(page.id), created, place);
      if (replace) {
        await run("DELETE FROM notebook_sheets WHERE id=?", sheets[0].id);
        await deleteSurface(page.id, sheets[0].id);
        ids = ids.filter((x) => x !== sheets[0].id);
      }
      await writeOrder(page.id, ids);
      result.created = created;
      break;
    }
    default:
      if (!ORGANIZE_ACTIONS.has(action)) throw new HttpError(400, "Unbekannte Aktion.");
      Object.assign(result, await organizeCommand(user, page, action, b));
  }
  await touch();
  const sheets = await notebookSheets(page.id);
  return { ...result, paper: await notebookPaper(page.id), sheets, outline: await notebookOutline(page.id, sheets) };
}

// ---- Copies, archives, exports ----

// Copies a notebook onto a new page (duplicate). `files` maps the source's
// attachments to the copies (PDF backgrounds).
export async function copyNotebook(fromPage: string, toPage: string, files: Map<string, string> = new Map(), by: string | null = null) {
  await run("DELETE FROM notebook_sheets WHERE page_id=?", toPage);
  await run("INSERT INTO notebooks(page_id,paper,updated_at) VALUES(?,?,?) ON CONFLICT(page_id) DO UPDATE SET paper=excluded.paper", toPage, JSON.stringify(withPaperFiles(await notebookPaper(fromPage), files)), Date.now());
  const surfaces = new Map<string, string>();
  for (const sheet of await notebookSheets(fromPage)) {
    const background = sheet.background ? (files.get(sheet.background.file) ? { ...sheet.background, file: files.get(sheet.background.file)! } : null) : null;
    // A background the copy cannot have becomes plain paper of its size.
    const sid = await insertSheet(toPage, sheet.background && !background ? { template: "blank" } : withPaperFiles(sheet.paper, files), background);
    await run("UPDATE notebook_sheets SET position=? WHERE id=?", sheet.position, sid);
    surfaces.set(sheet.id, sid);
  }
  if (!surfaces.size) await insertSheet(toPage);
  await copyPageInk(fromPage, toPage, surfaces, by, files);
  // Titles, bookmarks, links and the contents point to the copies.
  const sheets = await notebookSheets(fromPage);
  for (const sheet of sheets) await writeSheetMeta(surfaces.get(sheet.id)!, { ...sheet, links: remapLinks(sheet.links, surfaces) });
  await writeOutline(toPage, remapOutline(await notebookOutline(fromPage, sheets), surfaces));
}
// Links and contents entries of copied sheets: to the copies; links to
// sheets that were not copied go.
export const remapLinks = (links: NotebookLink[] | undefined, sheets: Map<string, string>) =>
  (links || []).flatMap((link) => ("sheet" in link.target ? (sheets.has(link.target.sheet) ? [{ ...link, target: { sheet: sheets.get(link.target.sheet)! } }] : []) : [link]));
export const remapOutline = (outline: OutlineEntry[], sheets: Map<string, string>) =>
  cleanOutline(outline.flatMap((entry) => (sheets.has(entry.sheet) ? [{ ...entry, sheet: sheets.get(entry.sheet)! }] : [])));
export async function writeOutline(pageId: string, outline: OutlineEntry[]) {
  await run("UPDATE notebooks SET outline=? WHERE page_id=?", JSON.stringify(cleanOutline(outline)), pageId);
}
// Paper with its own template's file swapped for the copy's (none: the
// template's picture is left out, the lines underneath show).
export function withPaperFiles<T extends PaperOverride>(paper: T, files: Map<string, string>): T {
  if (!paper.image?.file) return paper;
  const file = files.get(paper.image.file) ?? files.get(paper.image.file.toLowerCase());
  const next = { ...paper };
  if (file) next.image = { ...paper.image, file };
  else delete next.image;
  return next;
}

export const notebookArchiveSchema = z.object({
  paper: z.unknown(),
  sheets: z
    .array(
      z.object({
        paper: z.unknown().optional(),
        background: z.unknown().optional(),
        // The stored ink (lib/ink/README.md), checked again on import.
        ink: z.string().max(6_500_000).optional(),
        recognized: z.string().max(10000).optional(),
        // Since the page overview (lib/notebook-organize.ts); links point to
        // sheets by their index in the archive ("_3").
        title: z.string().max(1000).optional(),
        bookmark: z.boolean().optional(),
        links: z.unknown().optional(),
      }),
    )
    .max(MAX_SHEETS),
  // The table of contents, sheets by their index ("_0").
  outline: z.unknown().optional(),
});
export type NotebookArchive = z.infer<typeof notebookArchiveSchema>;
export async function notebookArchive(pageId: string): Promise<NotebookArchive> {
  const inks = await pageInkDocs(pageId);
  const sheets = await notebookSheets(pageId);
  // Sheets are referred to by their place in the archive.
  const index = new Map(sheets.map((s, i) => [s.id, `_${i}`]));
  const outline = remapOutline(await notebookOutline(pageId, sheets), index);
  return {
    paper: await notebookPaper(pageId),
    sheets: sheets.map((sheet) => {
      const ink = inks.get(sheet.id);
      const links = remapLinks(sheet.links, index);
      return {
        paper: sheet.paper,
        ...(sheet.background ? { background: sheet.background } : {}),
        ...(ink && hasInk(ink.doc) ? { ink: serializeInk(ink.doc), ...(ink.recognized ? { recognized: ink.recognized } : {}) } : {}),
        ...(sheet.title ? { title: sheet.title } : {}),
        ...(sheet.bookmark ? { bookmark: true } : {}),
        ...(links.length ? { links } : {}),
      };
    }),
    ...(outline.length ? { outline } : {}),
  };
}
// Restores a notebook from an archive onto a new page; `files` maps the
// archive's file ids to the imported ones.
export async function importNotebook(pageId: string, data: NotebookArchive, files: Map<string, string>, by: string | null) {
  await run("DELETE FROM notebook_sheets WHERE page_id=?", pageId);
  await run("INSERT INTO notebooks(page_id,paper,updated_at) VALUES(?,?,?) ON CONFLICT(page_id) DO UPDATE SET paper=excluded.paper", pageId, JSON.stringify(withPaperFiles(fullPaper(data.paper), files)), Date.now());
  const created = new Map<string, string>();
  await forEachAsync(data.sheets, async (sheet, index) => {
    const raw = sheet.background ? backgroundSchema.safeParse(sheet.background) : null;
    const file = raw?.success ? files.get(raw.data.file) : undefined;
    const background = raw?.success && file ? { ...raw.data, file } : null;
    const sid = await insertSheet(pageId, raw?.success && !background ? { template: "blank" } : withPaperFiles(cleanPaper(sheet.paper), files), background);
    await run("UPDATE notebook_sheets SET position=? WHERE id=?", index, sid);
    if (sheet.ink) {
      // The archive's page key was the old sheet id: the only page is this sheet.
      // Pictures point to the imported files (others are left out).
      const doc = mapInkFiles(parseInk(sheet.ink), (file) => files.get(file) ?? files.get(file.toLowerCase()) ?? null);
      const items = Object.values(doc.pages)[0] || [];
      if (items.length) await writeSurface(pageId, sid, { ...emptyInk(), pages: { [sid]: items } }, cleanRecognizedText(sheet.recognized), by);
    }
    created.set(`_${index}`, sid);
  });
  if (!data.sheets.length) await insertSheet(pageId);
  // Titles, bookmarks, links and contents (archives from before have none).
  await forEachAsync(data.sheets, async (sheet, index) => {
    if (!sheet.title && !sheet.bookmark && !sheet.links) return;
    await writeSheetMeta(created.get(`_${index}`)!, { title: sheet.title, bookmark: sheet.bookmark, links: remapLinks(cleanLinks(sheet.links), created) });
  });
  if (data.outline) await writeOutline(pageId, remapOutline(cleanOutline(data.outline), created));
}

// Typed and recognised text of all sheets, in order (exports, summaries).
export async function notebookText(pageId: string) {
  const inks = await pageInkDocs(pageId);
  return (await notebookSheets(pageId))
    .map((sheet) => {
      const ink = inks.get(sheet.id);
      return [ink ? inkText(ink.doc) : "", ink?.recognized || ""].filter(Boolean).join("\n");
    })
    .filter(Boolean);
}
