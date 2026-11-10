// Organising a notebook (the page overview, components/notebook): titles
// and bookmarks of sheets, links on sheets, the table of contents, several
// sheets at once (duplicate, delete into the notebook's trash, restore) and
// sheets copied or moved into another notebook. Data model and pure helpers:
// lib/notebook-organize-model.ts; the commands: lib/api.ts → notebookCommand
// (lib/notebook.ts), the transfer through transferSheets.
//
//   notebook_sheets.title / .bookmark / .links    per sheet
//   notebooks.outline                              the table of contents
//   notebook_sheet_trash(id, page_id, position, sheet, deleted_by, deleted_at)
//     sheet: JSON {id, paper, background, title, bookmark, links, ink, recognized}
//     – a deleted sheet with its ink, restorable for TRASH_DAYS days (its
//     ink versions go with the deletion).
import { copyFileSync, mkdirSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { all, id, inTransaction, one, onTransactionRollback, run } from "./db";
import { HttpError } from "./auth";
import { requirePage } from "./permissions";
import { requireUnlocked } from "./journal-extras";
import { isEncryptedPage } from "./e2ee-server";
import { quotaCheckpoint } from "./instance-ops";
import { copyPageInk, deleteSurface, pageInkDocs, writeSurface } from "./page-ink-store";
import { emptyInk, inkFiles, parseInk, serializeInk, type InkDoc } from "./ink/model";
import { cleanRecognizedText } from "./ink/recognized";
import { cleanPaper, effectivePaper, MAX_SHEETS, type PaperOverride } from "./notebook-paper";
import {
  cleanLinks,
  cleanOutline,
  cleanTitle,
  OUTLINE_TITLE_MAX,
  outlineInsert,
  parseLinks,
  TRASH_DAYS,
  type NotebookLink,
} from "./notebook-organize-model";
import {
  createNotebook,
  insertSheet,
  notebookOutline,
  notebookPaper,
  notebookSheets,
  order,
  parseBackground,
  placeSheets,
  remapLinks,
  remapOutline,
  sheetPlace,
  writeOrder,
  writeOutline,
  withPaperFiles,
  writeSheetMeta,
  type NotebookBackground,
} from "./notebook";
import type { Identity, Page } from "./types";

export const ORGANIZE_ACTIONS = new Set([
  "notebook.sheet.meta",
  "notebook.sheet.links",
  "notebook.outline",
  "notebook.outline.add",
  "notebook.sheets.duplicate",
  "notebook.sheets.delete",
  "notebook.trash.restore",
]);

const sheetId = z.string().regex(/^[\w-]{1,40}$/);
const sheetIds = z.array(sheetId).min(1).max(MAX_SHEETS);
const DAY = 24 * 60 * 60 * 1000;

async function requireSheets(pageId: string, ids: string[]) {
  const known = new Set(await order(pageId));
  const unique = [...new Set(ids)];
  if (unique.some((sid) => !known.has(sid))) throw new HttpError(404, "Blatt nicht gefunden.");
  return unique;
}
async function room(pageId: string, count: number) {
  const n = (await one<{ n: number }>("SELECT COUNT(*) n FROM notebook_sheets WHERE page_id=?", pageId))?.n ?? 0;
  if (n + count > MAX_SHEETS) throw new HttpError(413, `Ein Notizbuch hat höchstens ${MAX_SHEETS} Blätter.`);
}
type SheetRow = { id: string; position: number; paper: string; background: string | null; title: string | null; bookmark: number | null; links: string | null };
const sheetRows = async (pageId: string) =>
  await all<SheetRow>("SELECT id,position,paper,background,title,bookmark,links FROM notebook_sheets WHERE page_id=? ORDER BY position,created_at", pageId);
const parsePaper = (value: string | null) => {
  try {
    return cleanPaper(JSON.parse(value || "{}"));
  } catch {
    return {};
  }
};
const inkAnswer = async (pageId: string, ids: string[]) => {
  const inks = await pageInkDocs(pageId);
  return Object.fromEntries(ids.map((sid) => [sid, { doc: inks.get(sid)?.doc ?? emptyInk(), version: inks.get(sid)?.version ?? 0 }]));
};

// ---- Trash ----

// Deleted sheets older than TRASH_DAYS go for good.
export async function purgeSheetTrash(pageId: string, now = Date.now()) {
  await run("DELETE FROM notebook_sheet_trash WHERE page_id=? AND deleted_at<?", pageId, now - TRASH_DAYS * DAY);
}
// Moves sheets into the notebook's trash, with their ink; at least one
// sheet stays. Answers the trash entries (for undo).
export async function trashSheets(user: Identity, page: Page, ids: string[], now = Date.now()): Promise<string[]> {
  const wanted = await requireSheets(page.id, ids);
  const rows = await sheetRows(page.id);
  if (rows.length - wanted.length < 1) throw new HttpError(400, "Ein Notizbuch braucht mindestens ein Blatt.");
  await purgeSheetTrash(page.id, now);
  const inks = await pageInkDocs(page.id);
  const trashed: string[] = [];
  const index = new Map(rows.map((r, i) => [r.id, i]));
  for (const sid of wanted) {
    const row = rows[index.get(sid)!];
    const ink = inks.get(sid);
    const tid = id();
    await run(
      "INSERT INTO notebook_sheet_trash(id,page_id,position,sheet,deleted_by,deleted_at) VALUES(?,?,?,?,?,?)",
      tid,
      page.id,
      index.get(sid)!,
      JSON.stringify({
        id: sid,
        paper: parsePaper(row.paper),
        background: parseBackground(row.background),
        title: row.title || "",
        bookmark: !!row.bookmark,
        links: parseLinks(row.links),
        ...(ink?.doc.pages[sid]?.length ? { ink: serializeInk(ink.doc) } : {}),
        ...(ink?.recognized ? { recognized: ink.recognized } : {}),
      }),
      user.id,
      now,
    );
    await run("DELETE FROM notebook_sheets WHERE id=? AND page_id=?", sid, page.id);
    await deleteSurface(page.id, sid);
    trashed.push(tid);
  }
  await writeOrder(page.id, await order(page.id));
  return trashed;
}
const trashSchema = z.object({
  id: sheetId,
  paper: z.unknown().optional(),
  background: z.unknown().optional(),
  title: z.string().optional(),
  bookmark: z.boolean().optional(),
  links: z.unknown().optional(),
  ink: z.string().optional(),
  recognized: z.string().optional(),
});
type TrashRow = { id: string; position: number; sheet: string; deleted_by: string | null; deleted_at: number };
const readTrash = (row: TrashRow) => {
  try {
    const parsed = trashSchema.safeParse(JSON.parse(row.sheet));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};
// Restores sheets from the trash at their former place (with their ink;
// under their former id while it is free, so links and contents entries
// to them work again).
export async function restoreSheets(user: Identity, page: Page, trashIds: string[]) {
  const rows = (
    await all<TrashRow>(`SELECT id,position,sheet,deleted_by,deleted_at FROM notebook_sheet_trash WHERE page_id=? ORDER BY position`, page.id)
  ).filter((r) => trashIds.includes(r.id));
  if (!rows.length) throw new HttpError(404, "Das Blatt ist nicht mehr im Papierkorb.");
  await room(page.id, rows.length);
  let ids = await order(page.id);
  const created: string[] = [];
  for (const row of rows) {
    const data = readTrash(row);
    await run("DELETE FROM notebook_sheet_trash WHERE id=?", row.id);
    if (!data) continue;
    const taken = await one("SELECT 1 FROM notebook_sheets WHERE id=?", data.id);
    const background = parseBackground(data.background ? JSON.stringify(data.background) : null);
    const sid = await insertSheet(page.id, cleanPaper(data.paper), background, taken ? id() : data.id);
    await writeSheetMeta(sid, { title: data.title, bookmark: data.bookmark, links: data.links });
    if (data.ink) {
      const items = parseInk(data.ink).pages[data.id] || [];
      if (items.length) await writeSurface(page.id, sid, { ...emptyInk(), pages: { [sid]: items } }, cleanRecognizedText(data.recognized), user.id);
    }
    ids = ids.filter((x) => x !== sid);
    ids.splice(Math.min(row.position, ids.length), 0, sid);
    created.push(sid);
  }
  await writeOrder(page.id, ids);
  return { created, ink: await inkAnswer(page.id, created) };
}
// The trash of a notebook, newest first (GET /api/pages/{id}/notebook?part=trash).
export async function sheetTrash(page: Page) {
  await purgeSheetTrash(page.id);
  const rows = await all<TrashRow & { name: string | null }>(
    "SELECT t.id,t.position,t.sheet,t.deleted_by,t.deleted_at,u.name FROM notebook_sheet_trash t LEFT JOIN users u ON u.id=t.deleted_by WHERE t.page_id=? ORDER BY t.deleted_at DESC LIMIT 200",
    page.id,
  );
  return rows.flatMap((row) => {
    const data = readTrash(row);
    if (!data) return [];
    // The ink for a preview, while it is small.
    const ink: InkDoc | null = data.ink && data.ink.length < 300_000 ? parseInk(data.ink) : null;
    return [
      {
        id: row.id,
        sheet: data.id,
        position: row.position,
        deletedAt: row.deleted_at,
        deletedBy: row.name,
        title: cleanTitle(data.title),
        paper: cleanPaper(data.paper),
        background: parseBackground(data.background ? JSON.stringify(data.background) : null),
        ink,
      },
    ];
  });
}

// ---- Commands on one notebook ----

export async function organizeCommand(user: Identity, page: Page, action: string, b: Record<string, unknown>): Promise<Record<string, unknown>> {
  switch (action) {
    case "notebook.sheet.meta": {
      // Title (one sheet) and bookmark (any number of sheets).
      const ids = await requireSheets(page.id, sheetIds.parse(b.sheetIds));
      if (b.title !== undefined) {
        if (ids.length !== 1) throw new HttpError(400, "Ein Titel gehört zu einem Blatt.");
        await run("UPDATE notebook_sheets SET title=? WHERE id=? AND page_id=?", cleanTitle(z.string().max(1000).parse(b.title)), ids[0], page.id);
      }
      if (b.bookmark !== undefined) {
        const on = z.boolean().parse(b.bookmark);
        for (const sid of ids) await run("UPDATE notebook_sheets SET bookmark=? WHERE id=? AND page_id=?", on ? 1 : 0, sid, page.id);
      }
      return {};
    }
    case "notebook.sheet.links": {
      const [sid] = await requireSheets(page.id, [sheetId.parse(b.sheetId)]);
      const links = cleanLinks(z.array(z.unknown()).max(500).parse(b.links), new Set(await order(page.id)));
      await run("UPDATE notebook_sheets SET links=? WHERE id=? AND page_id=?", JSON.stringify(links), sid, page.id);
      return {};
    }
    case "notebook.outline": {
      // The whole table of contents (reorder, rename, levels, remove).
      const outline = cleanOutline(z.array(z.unknown()).max(5000).parse(b.outline), new Set(await order(page.id)));
      await writeOutline(page.id, outline);
      return {};
    }
    case "notebook.outline.add": {
      // A heading (lasso "Als Überschrift ins Inhaltsverzeichnis") or a
      // chapter ("Seite als Kapitel markieren"), placed in sheet order.
      const [sid] = await requireSheets(page.id, [sheetId.parse(b.sheetId)]);
      const title = cleanTitle(z.string().max(5000).parse(b.title), OUTLINE_TITLE_MAX);
      if (!title) throw new HttpError(400, "Bitte einen Titel angeben.");
      const y = z.number().finite().min(0).max(20000).optional().parse(b.y ?? undefined);
      const level = z.number().int().min(0).max(2).default(0).parse(b.level ?? undefined);
      const sheets = await notebookSheets(page.id);
      const entry = { id: id(), sheet: sid, title, level, ...(y !== undefined ? { y } : {}) };
      await writeOutline(page.id, outlineInsert(await notebookOutline(page.id, sheets), entry, sheets.map((s) => s.id)));
      return { entry: entry.id };
    }
    case "notebook.sheets.duplicate": {
      // Copies after the last of the sheets, in their order.
      const wanted = new Set(await requireSheets(page.id, sheetIds.parse(b.sheetIds)));
      const rows = (await sheetRows(page.id)).filter((r) => wanted.has(r.id));
      await room(page.id, rows.length);
      const copies = new Map<string, string>();
      for (const row of rows) {
        const sid = await insertSheet(page.id, parsePaper(row.paper), parseBackground(row.background));
        copies.set(row.id, sid);
      }
      for (const row of rows) await writeSheetMeta(copies.get(row.id)!, { title: row.title, bookmark: row.bookmark, links: parseLinks(row.links) });
      await copyPageInk(page.id, page.id, copies, user.id);
      const created = [...copies.values()];
      await writeOrder(page.id, placeSheets(await order(page.id), created, { after: rows[rows.length - 1].id }));
      return { created, ink: await inkAnswer(page.id, created) };
    }
    case "notebook.sheets.delete":
      return { trashed: await trashSheets(user, page, sheetIds.parse(b.sheetIds)) };
    case "notebook.trash.restore":
      return await restoreSheets(user, page, z.array(z.uuid()).min(1).max(MAX_SHEETS).parse(b.trashIds));
  }
  throw new HttpError(400, "Unbekannte Aktion.");
}

// ---- Into another notebook ----

// The pages of the workspace for the pickers of the overview: notebooks to
// copy or move sheets into (`writable`: the person may write there now)
// and pages a link may point to (GET /api/pages/{id}/notebook?part=peers).
export async function notebookPeers(user: Identity, page: Page) {
  const pages = await all<Page>(
    "SELECT * FROM pages WHERE workspace_id=? AND deleted_at IS NULL AND synced=0 ORDER BY position LIMIT 5000",
    page.workspace_id,
  );
  const out: { id: string; title: string; kind: string; icon: string | null; parentId: string | null; writable: boolean }[] = [];
  for (const p of pages) {
    let readable: Page;
    try {
      readable = await requirePage(user, p.id);
    } catch {
      continue;
    }
    let writable = false;
    if (p.kind === "notebook" && p.id !== page.id && !p.locked && !(await isEncryptedPage(p)))
      try {
        await requirePage(user, p.id, true);
        await requireUnlocked(user, p);
        writable = true;
      } catch {}
    out.push({ id: readable.id, title: readable.title, kind: readable.kind, icon: readable.icon ?? null, parentId: readable.parent_id ?? null, writable });
  }
  return { pages: out };
}

// Copies of upload files on another page (PDF backgrounds, own paper
// templates, pictures), counted against
// the target workspace's quota; removed again if the transaction fails.
async function copyFilesTo(target: Page, fileIds: string[], user: Identity) {
  const map = new Map<string, string>();
  if (!fileIds.length) return map;
  const quota = await quotaCheckpoint(target.workspace_id);
  const dir = resolve(process.env.FLOWPLAN_DATA_DIR || "./data", "uploads");
  mkdirSync(dir, { recursive: true });
  for (const fid of fileIds) {
    const file = await one<{ id: string; name: string; mime: string; size: number; width: number | null; height: number | null }>(
      "SELECT id,name,mime,size,width,height FROM files WHERE id=?",
      fid,
    );
    if (!file) continue;
    const copy = id();
    try {
      copyFileSync(resolve(dir, file.id), resolve(dir, copy));
    } catch {
      continue;
    }
    if (inTransaction())
      onTransactionRollback(() => {
        try {
          unlinkSync(resolve(dir, copy));
        } catch {}
      });
    await run("INSERT INTO files(id,page_id,name,mime,size,created_by,width,height) VALUES(?,?,?,?,?,?,?,?)", copy, target.id, file.name, file.mime, file.size, user.id, file.width, file.height);
    map.set(fid, copy);
  }
  await quota();
  return map;
}

// "In anderes Notizbuch kopieren / verschieben": the sheets (with ink,
// paper, PDF background, title, bookmark, links among them) go into the
// notebook `targetPageId` at `after` / `at` (default: the end). Copying
// needs reading the source, moving writing it; the target needs writing,
// both no journal PIN still to enter and nothing encrypted. Links to sheets
// that do not come along and contents entries stay behind (moving: they go
// with the sheets' removal).
export async function transferSheets(user: Identity, b: Record<string, unknown>) {
  const mode = z.enum(["copy", "move"]).parse(b.mode);
  const source = await requirePage(user, z.uuid().parse(b.pageId), mode === "move");
  await requireUnlocked(user, source);
  const target = await requirePage(user, z.uuid().parse(b.targetPageId), true);
  await requireUnlocked(user, target);
  if (source.kind !== "notebook" || target.kind !== "notebook") throw new HttpError(400, "Kein Notizbuch.");
  if (source.id === target.id) throw new HttpError(400, "Das ist dasselbe Notizbuch.");
  if ((mode === "move" && source.locked) || target.locked) throw new HttpError(409, "Diese Seite ist gesperrt.");
  if ((await isEncryptedPage(source)) || (await isEncryptedPage(target)))
    throw new HttpError(409, "In verschlüsselten Bereichen nicht möglich.");
  await createNotebook(target.id);
  const wanted = new Set(await requireSheets(source.id, sheetIds.parse(b.sheetIds)));
  const rows = (await sheetRows(source.id)).filter((r) => wanted.has(r.id));
  if (mode === "move" && (await order(source.id)).length - rows.length < 1) throw new HttpError(400, "Ein Notizbuch braucht mindestens ein Blatt.");
  await room(target.id, rows.length);
  const place = sheetPlace(b);
  if (typeof place === "object" && !(await one("SELECT 1 FROM notebook_sheets WHERE id=? AND page_id=?", place.after, target.id)))
    throw new HttpError(404, "Blatt nicht gefunden.");
  // The paper as it looks: the target's default may differ.
  const [fromPaper, toPaper] = [await notebookPaper(source.id), await notebookPaper(target.id)];
  const backgrounds = rows.map((r) => parseBackground(r.background));
  const looks = rows.map((row) => effectivePaper(fromPaper, parsePaper(row.paper)));
  // Files that come along as copies on the target page (its quota):
  // PDF backgrounds, own paper templates and pictures on the sheets.
  const inks = await pageInkDocs(source.id);
  const wantedFiles = new Set([
    ...backgrounds.flatMap((bg) => (bg ? [bg.file] : [])),
    ...looks.flatMap((paper) => (paper.image?.file ? [paper.image.file] : [])),
    ...rows.flatMap((row) => {
      const ink = inks.get(row.id)?.doc;
      return ink ? inkFiles({ ...ink, pages: { [row.id]: ink.pages[row.id] || [] } }) : [];
    }),
  ]);
  const sourceFiles = new Set((await all<{ id: string }>("SELECT id FROM files WHERE page_id=?", source.id)).map((f) => f.id.toLowerCase()));
  const files = await copyFilesTo(target, [...wantedFiles].filter((f) => sourceFiles.has(f.toLowerCase())), user);
  const copies = new Map<string, string>();
  for (const [i, row] of rows.entries()) {
    const own: PaperOverride = {};
    for (const key of ["template", "size", "orientation", "color"] as const) if (looks[i][key] !== toPaper[key]) Object.assign(own, { [key]: looks[i][key] });
    // An own template as the copy of its file (none could be made: the lines show).
    const image = withPaperFiles({ image: looks[i].image ?? null }, files).image ?? null;
    if (image || toPaper.image) own.image = image;
    const bg = backgrounds[i];
    const background: NotebookBackground | null = bg && files.get(bg.file) ? { ...bg, file: files.get(bg.file)! } : null;
    // A background that could not be copied becomes blank paper of its size.
    copies.set(row.id, await insertSheet(target.id, bg && !background ? { ...own, template: "blank" } : own, background));
  }
  for (const row of rows)
    await writeSheetMeta(copies.get(row.id)!, { title: row.title, bookmark: row.bookmark, links: remapLinks(parseLinks(row.links), copies) as NotebookLink[] });
  // Pictures point to the copies of their files.
  await copyPageInk(source.id, target.id, copies, user.id, files);
  const created = [...copies.values()];
  await writeOrder(target.id, placeSheets(await order(target.id), created, place));
  // The contents entries of these sheets come along.
  const sourceSheets = await notebookSheets(source.id);
  const moved = remapOutline(await notebookOutline(source.id, sourceSheets), copies);
  if (moved.length) {
    const targetSheets = (await notebookSheets(target.id)).map((s) => s.id);
    let outline = await notebookOutline(target.id);
    for (const entry of moved) outline = outlineInsert(outline, { ...entry, id: id() }, targetSheets);
    await writeOutline(target.id, outline);
  }
  if (mode === "move") {
    for (const sid of copies.keys()) {
      await run("DELETE FROM notebook_sheets WHERE id=? AND page_id=?", sid, source.id);
      await deleteSurface(source.id, sid);
    }
    await writeOrder(source.id, await order(source.id));
  }
  const now = Date.now();
  await run("UPDATE notebooks SET updated_at=? WHERE page_id IN (?,?)", now, source.id, target.id);
  const sheets = await notebookSheets(source.id);
  return {
    target: { id: target.id, title: target.title },
    copied: created.length,
    paper: fromPaper,
    sheets,
    outline: await notebookOutline(source.id, sheets),
  };
}
