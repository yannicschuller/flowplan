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
import { cleanPaper, DEFAULT_PAPER, effectivePaper, fullPaper, insertAfter, paperSize, sameSheets, type Paper, type PaperOverride } from "./notebook-paper";
import { copyPageInk, deleteSurface, mayEditInk, pageInkDocs, writeSurface } from "./page-ink-store";
import { emptyInk, hasInk, inkText, parseInk, serializeInk, type InkDoc } from "./ink/model";
import { cleanRecognizedText } from "./ink/recognized";
import { isPdfFile } from "./ink-store";
import type { Identity, Page } from "./types";

export const MAX_SHEETS = 1000;
// Pages one PDF import may bring.
export const MAX_IMPORT_PAGES = 500;

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

export function notebookPaper(pageId: string): Paper {
  return fullPaper(JSON.parse(one<{ paper: string }>("SELECT paper FROM notebooks WHERE page_id=?", pageId)?.paper || "{}"));
}
export function notebookSheets(pageId: string): NotebookSheet[] {
  return all<{ id: string; position: number; paper: string; background: string | null }>(
    "SELECT id,position,paper,background FROM notebook_sheets WHERE page_id=? ORDER BY position,created_at",
    pageId,
  ).map((s) => ({ id: s.id, position: s.position, paper: parsePaper(s.paper), background: parseBackground(s.background) }));
}
// The size of a sheet in points.
export function sheetSize(defaults: Paper, sheet: Pick<NotebookSheet, "paper" | "background">) {
  return sheet.background ? { width: sheet.background.width, height: sheet.background.height } : paperSize(effectivePaper(defaults, sheet.paper));
}

function insertSheet(pageId: string, paper: PaperOverride = {}, background: NotebookBackground | null = null, sheetId = id()) {
  run(
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
function writeOrder(pageId: string, ids: string[]) {
  ids.forEach((sheetId, index) => run("UPDATE notebook_sheets SET position=? WHERE id=? AND page_id=?", index, sheetId, pageId));
}
const order = (pageId: string) => notebookSheets(pageId).map((s) => s.id);

// A new notebook with its first sheet (lib/seed.ts createPage).
export function createNotebook(pageId: string, paper: Partial<Paper> = {}) {
  run("INSERT OR IGNORE INTO notebooks(page_id,paper,updated_at) VALUES(?,?,?)", pageId, JSON.stringify({ ...DEFAULT_PAPER, ...cleanPaper(paper) }), Date.now());
  if (!one("SELECT 1 FROM notebook_sheets WHERE page_id=?", pageId)) insertSheet(pageId);
}

export function notebookData(user: Identity, page: Page): NotebookPayload {
  const inks = pageInkDocs(page.id);
  return {
    paper: notebookPaper(page.id),
    sheets: notebookSheets(page.id).map((sheet) => {
      const ink = inks.get(sheet.id);
      return { ...sheet, ink: ink?.doc ?? emptyInk(), version: ink?.version ?? 0 };
    }),
    canEdit: mayEditInk(user, page),
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

// The notebook commands (lib/api.ts); `page` is checked for editing.
export function notebookCommand(user: Identity, page: Page, action: string, b: Record<string, unknown>) {
  if (page.kind !== "notebook") throw new HttpError(400, "Kein Notizbuch.");
  createNotebook(page.id);
  const touch = () => run("UPDATE notebooks SET updated_at=? WHERE page_id=?", Date.now(), page.id);
  const known = (sid: string) => {
    if (!one("SELECT 1 FROM notebook_sheets WHERE id=? AND page_id=?", sid, page.id)) throw new HttpError(404, "Blatt nicht gefunden.");
    return sid;
  };
  const room = (count: number) => {
    const n = one<{ n: number }>("SELECT COUNT(*) n FROM notebook_sheets WHERE page_id=?", page.id)?.n ?? 0;
    if (n + count > MAX_SHEETS) throw new HttpError(413, `Ein Notizbuch hat höchstens ${MAX_SHEETS} Blätter.`);
  };
  const result: Record<string, unknown> = {};
  switch (action) {
    case "notebook.paper": {
      const paper = { ...notebookPaper(page.id), ...cleanPaper(b.paper) };
      run("UPDATE notebooks SET paper=? WHERE page_id=?", JSON.stringify(paper), page.id);
      // "For all sheets": their own choices go.
      if (b.all === true) run("UPDATE notebook_sheets SET paper='{}' WHERE page_id=? AND background IS NULL", page.id);
      break;
    }
    case "notebook.sheet.add": {
      const count = z.number().int().min(1).max(50).default(1).parse(b.count ?? undefined);
      room(count);
      let previous = after.parse(b.after ?? null) ?? null;
      if (previous) known(previous);
      let ids = order(page.id);
      const created: string[] = [];
      for (let i = 0; i < count; i++) {
        const sid = insertSheet(page.id, cleanPaper(b.paper));
        ids = insertAfter(ids, sid, previous);
        previous = sid;
        created.push(sid);
      }
      writeOrder(page.id, ids);
      result.created = created;
      break;
    }
    case "notebook.sheet.duplicate": {
      const source = known(sheetId.parse(b.sheetId));
      room(1);
      const row = one<{ paper: string; background: string | null }>("SELECT paper,background FROM notebook_sheets WHERE id=?", source)!;
      const sid = insertSheet(page.id, parsePaper(row.paper), parseBackground(row.background));
      copyPageInk(page.id, page.id, new Map([[source, sid]]), user.id);
      writeOrder(page.id, insertAfter(order(page.id), sid, source));
      result.created = [sid];
      const ink = pageInkDocs(page.id).get(sid);
      result.ink = { [sid]: { doc: ink?.doc ?? emptyInk(), version: ink?.version ?? 0 } };
      break;
    }
    case "notebook.sheet.delete": {
      const sid = known(sheetId.parse(b.sheetId));
      if (order(page.id).length <= 1) throw new HttpError(400, "Ein Notizbuch braucht mindestens ein Blatt.");
      run("DELETE FROM notebook_sheets WHERE id=? AND page_id=?", sid, page.id);
      deleteSurface(page.id, sid);
      writeOrder(page.id, order(page.id));
      break;
    }
    case "notebook.sheet.move": {
      const next = z.array(sheetId).max(MAX_SHEETS).parse(b.order);
      if (!sameSheets(order(page.id), next)) throw new HttpError(409, "Die Blätter haben sich inzwischen geändert.");
      writeOrder(page.id, next);
      break;
    }
    case "notebook.sheet.paper": {
      const ids = z.array(sheetId).min(1).max(MAX_SHEETS).parse(b.sheetIds);
      const paper = b.paper === null ? {} : cleanPaper(b.paper);
      for (const sid of ids) run("UPDATE notebook_sheets SET paper=? WHERE id=? AND page_id=?", JSON.stringify(paper), known(sid), page.id);
      break;
    }
    case "notebook.import": {
      const fileId = z.uuid().parse(b.fileId);
      const file = one<{ id: string; name: string; mime: string }>("SELECT id,name,mime FROM files WHERE id=? AND page_id=?", fileId, page.id);
      if (!file) throw new HttpError(404, "Datei fehlt.");
      if (!isPdfFile(file)) throw new HttpError(400, "Nur PDFs lassen sich als Notizbuch öffnen.");
      const sizes = z
        .array(z.object({ width: z.number().finite(), height: z.number().finite() }))
        .min(1)
        .max(MAX_IMPORT_PAGES)
        .parse(b.pages);
      room(sizes.length);
      const backgrounds = pdfImportSheets(file.id, sizes);
      let previous = after.parse(b.after ?? null) ?? null;
      if (previous) known(previous);
      // A fresh notebook (one empty sheet) becomes the PDF.
      const sheets = notebookSheets(page.id);
      const replace = b.replaceEmpty === true && sheets.length === 1 && !sheets[0].background && !hasInk(pageInkDocs(page.id).get(sheets[0].id)?.doc);
      let ids = order(page.id);
      const created: string[] = [];
      for (const background of backgrounds) {
        const sid = insertSheet(page.id, {}, background);
        ids = insertAfter(ids, sid, previous);
        previous = sid;
        created.push(sid);
      }
      if (replace) {
        run("DELETE FROM notebook_sheets WHERE id=?", sheets[0].id);
        deleteSurface(page.id, sheets[0].id);
        ids = ids.filter((x) => x !== sheets[0].id);
      }
      writeOrder(page.id, ids);
      result.created = created;
      break;
    }
    default:
      throw new HttpError(400, "Unbekannte Aktion.");
  }
  touch();
  return { ...result, paper: notebookPaper(page.id), sheets: notebookSheets(page.id) };
}

// ---- Copies, archives, exports ----

// Copies a notebook onto a new page (duplicate). `files` maps the source's
// attachments to the copies (PDF backgrounds).
export function copyNotebook(fromPage: string, toPage: string, files: Map<string, string> = new Map(), by: string | null = null) {
  run("DELETE FROM notebook_sheets WHERE page_id=?", toPage);
  run("INSERT INTO notebooks(page_id,paper,updated_at) VALUES(?,?,?) ON CONFLICT(page_id) DO UPDATE SET paper=excluded.paper", toPage, JSON.stringify(notebookPaper(fromPage)), Date.now());
  const surfaces = new Map<string, string>();
  for (const sheet of notebookSheets(fromPage)) {
    const background = sheet.background ? (files.get(sheet.background.file) ? { ...sheet.background, file: files.get(sheet.background.file)! } : null) : null;
    // A background the copy cannot have becomes plain paper of its size.
    const sid = insertSheet(toPage, sheet.background && !background ? { template: "blank" } : sheet.paper, background);
    run("UPDATE notebook_sheets SET position=? WHERE id=?", sheet.position, sid);
    surfaces.set(sheet.id, sid);
  }
  if (!surfaces.size) insertSheet(toPage);
  copyPageInk(fromPage, toPage, surfaces, by);
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
});
export type NotebookArchive = z.infer<typeof notebookArchiveSchema>;
export function notebookArchive(pageId: string): NotebookArchive {
  const inks = pageInkDocs(pageId);
  return {
    paper: notebookPaper(pageId),
    sheets: notebookSheets(pageId).map((sheet) => {
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
export function importNotebook(pageId: string, data: NotebookArchive, files: Map<string, string>, by: string | null) {
  run("DELETE FROM notebook_sheets WHERE page_id=?", pageId);
  run("INSERT INTO notebooks(page_id,paper,updated_at) VALUES(?,?,?) ON CONFLICT(page_id) DO UPDATE SET paper=excluded.paper", pageId, JSON.stringify(fullPaper(data.paper)), Date.now());
  data.sheets.forEach((sheet, index) => {
    const raw = sheet.background ? backgroundSchema.safeParse(sheet.background) : null;
    const file = raw?.success ? files.get(raw.data.file) : undefined;
    const background = raw?.success && file ? { ...raw.data, file } : null;
    const sid = insertSheet(pageId, raw?.success && !background ? { template: "blank" } : cleanPaper(sheet.paper), background);
    run("UPDATE notebook_sheets SET position=? WHERE id=?", index, sid);
    if (sheet.ink) {
      // The archive's page key was the old sheet id: the only page is this sheet.
      const doc = parseInk(sheet.ink);
      const items = Object.values(doc.pages)[0] || [];
      if (items.length) writeSurface(pageId, sid, { ...emptyInk(), pages: { [sid]: items } }, cleanRecognizedText(sheet.recognized), by);
    }
  });
  if (!data.sheets.length) insertSheet(pageId);
}

// Typed and recognised text of all sheets, in order (exports, summaries).
export function notebookText(pageId: string) {
  const inks = pageInkDocs(pageId);
  return notebookSheets(pageId)
    .map((sheet) => {
      const ink = inks.get(sheet.id);
      return [ink ? inkText(ink.doc) : "", ink?.recognized || ""].filter(Boolean).join("\n");
    })
    .filter(Boolean);
}
