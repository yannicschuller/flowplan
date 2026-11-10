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
import { z } from "zod";
import { all, id, one, run } from "./db";
import { HttpError } from "./auth";
import { cleanPaper, DEFAULT_PAPER, fullPaper, insertAfter, MAX_IMPORT_PAGES, MAX_SHEETS, sameSheets, type Paper, type PaperOverride } from "./notebook-paper";
import { copyPageInk, deleteSurface, mayEditInk, pageInkDocs, writeSurface } from "./page-ink-store";
import { emptyInk, hasInk, inkText, parseInk, serializeInk, type InkDoc } from "./ink/model";
import { cleanRecognizedText } from "./ink/recognized";
import { isPdfFile } from "./ink-store";
import type { Identity, Page } from "./types";
import { forEachAsync } from "./each-async";
import { copyRecordings, recordingsArchive, recordingsArchiveSchema, restoreRecordings } from "./notebook-audio";

export { MAX_SHEETS, MAX_IMPORT_PAGES };

export type NotebookBackground = { file: string; page: number; width: number; height: number };
export type NotebookSheet = { id: string; position: number; paper: PaperOverride; background: NotebookBackground | null };
export type NotebookSheetData = NotebookSheet & { ink: InkDoc; version: number };
export type NotebookPayload = { paper: Paper; sheets: NotebookSheetData[]; canEdit: boolean };

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
  return (await all<{ id: string; position: number; paper: string; background: string | null }>(
    "SELECT id,position,paper,background FROM notebook_sheets WHERE page_id=? ORDER BY position,created_at",
    pageId,
  )).map((s) => ({ id: s.id, position: s.position, paper: parsePaper(s.paper), background: parseBackground(s.background) }));
}

async function insertSheet(pageId: string, paper: PaperOverride = {}, background: NotebookBackground | null = null, sheetId = id()) {
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
async function writeOrder(pageId: string, ids: string[]) {
  await forEachAsync(ids, async (sheetId, index) => await run("UPDATE notebook_sheets SET position=? WHERE id=? AND page_id=?", index, sheetId, pageId));
}
const order = async (pageId: string) => (await notebookSheets(pageId)).map((s) => s.id);

// A new notebook with its first sheet (lib/seed.ts createPage).
export async function createNotebook(pageId: string, paper: Partial<Paper> = {}) {
  await run("INSERT INTO notebooks(page_id,paper,updated_at) VALUES(?,?,?) ON CONFLICT DO NOTHING", pageId, JSON.stringify({ ...DEFAULT_PAPER, ...cleanPaper(paper) }), Date.now());
  if (!(await one("SELECT 1 FROM notebook_sheets WHERE page_id=?", pageId))) await insertSheet(pageId);
}

export async function notebookData(user: Identity, page: Page): Promise<NotebookPayload> {
  const inks = await pageInkDocs(page.id);
  return {
    paper: await notebookPaper(page.id),
    sheets: (await notebookSheets(page.id)).map((sheet) => {
      const ink = inks.get(sheet.id);
      return { ...sheet, ink: ink?.doc ?? emptyInk(), version: ink?.version ?? 0 };
    }),
    canEdit: await mayEditInk(user, page),
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
  switch (action) {
    case "notebook.paper": {
      const paper = { ...(await notebookPaper(page.id)), ...cleanPaper(b.paper) };
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
      for (let i = 0; i < count; i++) created.push(await insertSheet(page.id, cleanPaper(b.paper)));
      await writeOrder(page.id, placeSheets(await order(page.id), created, place));
      result.created = created;
      break;
    }
    case "notebook.sheet.duplicate": {
      const source = await known(sheetId.parse(b.sheetId));
      await room(1);
      const row = (await one<{ paper: string; background: string | null }>("SELECT paper,background FROM notebook_sheets WHERE id=?", source))!;
      const sid = await insertSheet(page.id, parsePaper(row.paper), parseBackground(row.background));
      await copyPageInk(page.id, page.id, new Map([[source, sid]]), user.id);
      await writeOrder(page.id, insertAfter(await order(page.id), sid, source));
      result.created = [sid];
      const ink = (await pageInkDocs(page.id)).get(sid);
      result.ink = { [sid]: { doc: ink?.doc ?? emptyInk(), version: ink?.version ?? 0 } };
      break;
    }
    case "notebook.sheet.delete": {
      const sid = await known(sheetId.parse(b.sheetId));
      if ((await order(page.id)).length <= 1) throw new HttpError(400, "Ein Notizbuch braucht mindestens ein Blatt.");
      await run("DELETE FROM notebook_sheets WHERE id=? AND page_id=?", sid, page.id);
      await deleteSurface(page.id, sid);
      await writeOrder(page.id, await order(page.id));
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
      const paper = b.paper === null ? {} : cleanPaper(b.paper);
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
      throw new HttpError(400, "Unbekannte Aktion.");
  }
  await touch();
  return { ...result, paper: await notebookPaper(page.id), sheets: await notebookSheets(page.id) };
}

// ---- Copies, archives, exports ----

// Copies a notebook onto a new page (duplicate). `files` maps the source's
// attachments to the copies (PDF backgrounds).
export async function copyNotebook(fromPage: string, toPage: string, files: Map<string, string> = new Map(), by: string | null = null) {
  await run("DELETE FROM notebook_sheets WHERE page_id=?", toPage);
  await run("INSERT INTO notebooks(page_id,paper,updated_at) VALUES(?,?,?) ON CONFLICT(page_id) DO UPDATE SET paper=excluded.paper", toPage, JSON.stringify(await notebookPaper(fromPage)), Date.now());
  const surfaces = new Map<string, string>();
  for (const sheet of await notebookSheets(fromPage)) {
    const background = sheet.background ? (files.get(sheet.background.file) ? { ...sheet.background, file: files.get(sheet.background.file)! } : null) : null;
    // A background the copy cannot have becomes plain paper of its size.
    const sid = await insertSheet(toPage, sheet.background && !background ? { template: "blank" } : sheet.paper, background);
    await run("UPDATE notebook_sheets SET position=? WHERE id=?", sheet.position, sid);
    surfaces.set(sheet.id, sid);
  }
  if (!surfaces.size) await insertSheet(toPage);
  await copyPageInk(fromPage, toPage, surfaces, by);
  // Audio recordings whose files were copied (lib/notebook-audio.ts).
  await copyRecordings(fromPage, toPage, files, by);
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
      }),
    )
    .max(MAX_SHEETS),
  // Audio recordings (lib/notebook-audio.ts): the file ids refer to the
  // archive's files. Older archives have none.
  recordings: recordingsArchiveSchema.optional(),
});
export type NotebookArchive = z.infer<typeof notebookArchiveSchema>;
export async function notebookArchive(pageId: string): Promise<NotebookArchive> {
  const inks = await pageInkDocs(pageId);
  const recordings = await recordingsArchive(pageId);
  return {
    ...(recordings.length ? { recordings } : {}),
    paper: await notebookPaper(pageId),
    sheets: (await notebookSheets(pageId)).map((sheet) => {
      const ink = inks.get(sheet.id);
      return {
        paper: sheet.paper,
        ...(sheet.background ? { background: sheet.background } : {}),
        ...(ink && hasInk(ink.doc) ? { ink: serializeInk(ink.doc), ...(ink.recognized ? { recognized: ink.recognized } : {}) } : {}),
      };
    }),
  };
}
// Restores a notebook from an archive onto a new page; `files` maps the
// archive's file ids to the imported ones.
export async function importNotebook(pageId: string, data: NotebookArchive, files: Map<string, string>, by: string | null) {
  await run("DELETE FROM notebook_sheets WHERE page_id=?", pageId);
  await run("INSERT INTO notebooks(page_id,paper,updated_at) VALUES(?,?,?) ON CONFLICT(page_id) DO UPDATE SET paper=excluded.paper", pageId, JSON.stringify(fullPaper(data.paper)), Date.now());
  await forEachAsync(data.sheets, async (sheet, index) => {
    const raw = sheet.background ? backgroundSchema.safeParse(sheet.background) : null;
    const file = raw?.success ? files.get(raw.data.file) : undefined;
    const background = raw?.success && file ? { ...raw.data, file } : null;
    const sid = await insertSheet(pageId, raw?.success && !background ? { template: "blank" } : cleanPaper(sheet.paper), background);
    await run("UPDATE notebook_sheets SET position=? WHERE id=?", index, sid);
    if (sheet.ink) {
      // The archive's page key was the old sheet id: the only page is this sheet.
      const doc = parseInk(sheet.ink);
      const items = Object.values(doc.pages)[0] || [];
      if (items.length) await writeSurface(pageId, sid, { ...emptyInk(), pages: { [sid]: items } }, cleanRecognizedText(sheet.recognized), by);
    }
  });
  if (!data.sheets.length) await insertSheet(pageId);
  await restoreRecordings(pageId, data.recordings, files, by);
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
