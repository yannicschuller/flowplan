// Which entries of a device's offline copy to fetch again and which to
// drop (components/offline.ts). Pure functions over cache keys (path plus
// query) so the plan is testable; public/sw.js repeats them for Periodic
// Background Sync (tests/offline-plan.test.ts checks both agree).

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const PAGE_KEY = new RegExp(`^/api/pages/(${UUID})(?:[/?]|$)`, "i");
const PAGE_EXACT = new RegExp(`^/api/pages/(${UUID})$`, "i");
const ROW_KEY = new RegExp(`^/api/pages/(${UUID})/rows/(${UUID})(?:[/?]|$)`, "i");
const ROW_EXACT = new RegExp(`^/api/pages/(${UUID})/rows/(${UUID})$`, "i");
const FILE_KEY = new RegExp(`^/api/files/(${UUID})(?:[/?]|$)`, "i");
const FILE_REF = new RegExp(`/api/files/(${UUID})`, "gi");

export const pageUrl = (id: string) => `/api/pages/${id}`;
export const rowUrl = (pageId: string, rowId: string) => `/api/pages/${pageId}/rows/${rowId}`;
export const fileUrl = (id: string) => `/api/files/${id}`;
export const isPageKey = (key: string) => PAGE_EXACT.test(key);
export const isRowKey = (key: string) => ROW_EXACT.test(key);
export const isFileKey = (key: string) => FILE_KEY.test(key);

// Files (/api/files/<id>) a stored answer refers to: images in documents,
// file cells, covers, the page's file list.
export function fileRefs(text: string): string[] {
  return [...new Set([...text.matchAll(FILE_REF)].map((m) => m[1].toLowerCase()))];
}

export type PagePlanInput = {
  // Keys of the data cache.
  keys: string[];
  // Pages readable now and the changed ones (GET /api/offline/changes).
  readable: string[];
  changed: string[];
  // Fetch every readable page again (first copy, "Update now").
  full: boolean;
};
// Pages: new and changed ones are fetched; everything stored for a page
// that is gone or no longer readable (its records too) is dropped.
export function planPages({ keys, readable, changed, full }: PagePlanInput) {
  const allowed = new Set(readable.map((id) => id.toLowerCase()));
  const touched = new Set(changed.map((id) => id.toLowerCase()));
  const stored = new Set<string>();
  const drop: string[] = [];
  for (const key of keys) {
    const page = PAGE_KEY.exec(key)?.[1]?.toLowerCase();
    if (!page) continue;
    if (!allowed.has(page)) drop.push(key);
    else if (PAGE_EXACT.test(key)) stored.add(page);
  }
  const fetch = readable
    .filter((id) => full || !stored.has(id.toLowerCase()) || touched.has(id.toLowerCase()))
    .map(pageUrl);
  return { fetch, drop };
}

export type RecordPlanInput = {
  keys: string[];
  // Visible records per stored page (from its stored /api/pages/<id>).
  rows: Record<string, string[]>;
  // Records whose cells or document changed (GET /api/offline/changes).
  changedRows: Record<string, string[]>;
  full: boolean;
  // Also store records never opened on this device.
  includeRecords: boolean;
};
// Record documents: changed ones are fetched again, records that are gone
// or hidden now are dropped; with includeRecords every record is stored.
export function planRecords({ keys, rows, changedRows, full, includeRecords }: RecordPlanInput) {
  const drop: string[] = [];
  const stored = new Set<string>();
  for (const key of keys) {
    const match = ROW_KEY.exec(key);
    if (!match) continue;
    const [page, row] = [match[1].toLowerCase(), match[2].toLowerCase()];
    const visible = rows[page];
    if (!visible) continue;
    if (!visible.some((id) => id.toLowerCase() === row)) drop.push(key);
    else if (ROW_EXACT.test(key)) stored.add(`${page}/${row}`);
  }
  const refresh: string[] = [];
  const add: string[] = [];
  for (const [page, list] of Object.entries(rows)) {
    const changed = new Set((changedRows[page] || []).map((id) => id.toLowerCase()));
    for (const row of list) {
      const has = stored.has(`${page.toLowerCase()}/${row.toLowerCase()}`);
      if (has && (full || changed.has(row.toLowerCase()))) refresh.push(rowUrl(page, row));
      else if (!has && includeRecords) add.push(rowUrl(page, row));
    }
  }
  return { refresh, add, drop };
}

export type FilePlanInput = {
  keys: string[];
  // Files referred to by the stored pages and records.
  referenced: string[];
  includeRecords: boolean;
};
// Files: those no stored page refers to any more are dropped; with
// includeRecords the referred ones not yet stored are added.
export function planFiles({ keys, referenced, includeRecords }: FilePlanInput) {
  const wanted = new Set(referenced.map((id) => id.toLowerCase()));
  const stored = new Set<string>();
  const drop: string[] = [];
  for (const key of keys) {
    const file = FILE_KEY.exec(key)?.[1]?.toLowerCase();
    if (!file) continue;
    if (!wanted.has(file)) drop.push(key);
    else stored.add(file);
  }
  const add = includeRecords ? [...wanted].filter((id) => !stored.has(id)).map(fileUrl) : [];
  return { add, drop };
}

// Visible record ids of a stored page answer (databases only).
export function pageRows(data: unknown): string[] {
  const rows = (data as { rows?: { id?: unknown }[] } | null)?.rows;
  return Array.isArray(rows) ? rows.map((r) => String(r?.id || "")).filter(Boolean) : [];
}
