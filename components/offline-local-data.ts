// Opening a page made offline (#370), loaded only when such a page opens:
// what the server will create – the database setups and template records,
// an empty board, a notebook's first sheet with the handwriting kept here.
// Kept out of the workspace shell (its JavaScript budget, scripts/quality-check.mjs).
import type { OfflinePageChange } from "@/lib/offline-queue";
import type { CatalogTemplate } from "@/lib/template-catalog";
import type { Translate } from "@/lib/database-setup";
import { localDatabase } from "@/lib/offline-local-database";
import { fullPaper } from "@/lib/notebook-paper";
import { emptyInk } from "@/lib/ink/model";
import { OFFLINE_BOARD_GENERATION, keptInk } from "./offline-uploads";

// The data a page made offline opens with, as the server would send it.
// Typed as the workspace's PageData by its caller.
export function localPageData(change: OfflinePageChange, page: unknown, tr: Translate, template?: CatalogTemplate) {
  const data = {
    page,
    role: "editor",
    comments: [],
    snapshots: [],
    present: [],
    backlinks: [],
    images: [],
    shareLinks: [],
    rows: [],
    related: {},
    rowTemplates: [],
    form: null,
    state: null,
    html: change.pageKind === "document" ? template?.html || "" : "",
    generation: "1",
    offlineNew: true,
  } as Record<string, unknown> & { database?: unknown; rows: unknown[]; whiteboard?: unknown; notebook?: unknown };
  if (change.pageKind === "database") {
    const db = localDatabase(change, tr, template);
    data.database = { page_id: change.pageId, fields: db.fields, views: db.views, version: 1, ...(db.settings ? { settings: db.settings as never } : {}), ...(db.recordLayout ? { recordLayout: db.recordLayout as never } : {}) };
    data.rows = db.rows;
  } else if (change.pageKind === "whiteboard") data.whiteboard = { state: "AAA=", generation: OFFLINE_BOARD_GENERATION };
  else if (change.pageKind === "notebook" && change.sheetId) {
    const ink = emptyInk();
    const kept = keptInk(change.pageId);
    if (kept[change.sheetId]) ink.pages[change.sheetId] = kept[change.sheetId];
    data.notebook = { paper: fullPaper({}), sheets: [{ id: change.sheetId, position: 0, paper: {}, background: null, ink, version: 0 }], canEdit: true, outline: [] };
  }
  return data;
}
