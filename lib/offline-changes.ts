// What changed for a device's offline copy (GET /api/offline/changes): the
// pages this person may read now, and among them the pages and records
// whose content changed since the last refresh. Triggers in lib/db.ts keep
// offline_changes up to date for every write path (documents, records,
// record documents, files, comments, properties). Only ids leave the
// server; the content itself comes from /api/pages/… with its usual checks
// (hidden records, field permissions in lib/field-access.ts).
import { all, one } from "./db";
import { requireMember, pageRole } from "./permissions";
import { lockedPageIds } from "./journal-extras";
import { hiddenRowIds } from "./row-access";
import type { Identity, Page } from "./types";

// Writes in flight while the previous answer was built are not missed.
const OVERLAP_MS = 5000;

export type OfflineChanges = {
  // Server time of this answer; the next call passes it as since.
  now: string;
  // True when since was missing or older than the log: fetch everything.
  full: boolean;
  // Every page readable now (outside the trash, no journal behind a PIN).
  pages: string[];
  // Readable pages whose content changed since then.
  changed: string[];
  // Per database page: visible records whose cells or document changed.
  rows: Record<string, string[]>;
};

export function parseSince(value: string | null): number | null {
  if (!value) return null;
  const ms = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function readableOfflinePages(user: Identity, workspaceId: string) {
  requireMember(user, workspaceId);
  const locked = lockedPageIds(user, workspaceId);
  return all<Page>(
    "SELECT * FROM pages WHERE workspace_id=? AND deleted_at IS NULL ORDER BY position",
    workspaceId,
  ).filter((p) => !locked.has(p.id) && pageRole(user, p));
}

export function offlineChanges(
  user: Identity,
  workspaceId: string,
  since: number | null,
  now = Date.now(),
  overlap = OVERLAP_MS,
): OfflineChanges {
  const pages = readableOfflinePages(user, workspaceId);
  const readable = new Map(pages.map((p) => [p.id, p]));
  const ids = [...readable.keys()];
  const started = one<{ started: number }>("SELECT started FROM offline_log WHERE id=1")?.started ?? 0;
  if (since === null || since < started || since > now + 60_000)
    return { now: new Date(now).toISOString(), full: true, pages: ids, changed: ids, rows: {} };
  const entries = all<{ page_id: string; row_id: string }>(
    `SELECT c.page_id,c.row_id FROM offline_changes c JOIN pages p ON p.id=c.page_id
     WHERE p.workspace_id=? AND c.at>=?`,
    workspaceId,
    since - overlap,
  );
  const changed = new Set<string>();
  const rowIds = new Map<string, string[]>();
  for (const entry of entries) {
    if (!readable.has(entry.page_id)) continue;
    changed.add(entry.page_id);
    if (!entry.row_id) continue;
    const list = rowIds.get(entry.page_id) || [];
    list.push(entry.row_id);
    rowIds.set(entry.page_id, list);
  }
  const rows: Record<string, string[]> = {};
  for (const [pageId, list] of rowIds) {
    const page = readable.get(pageId)!;
    if (page.kind !== "database") continue;
    // Private records this person may not see stay unnamed.
    const hidden = hiddenRowIds(user, page);
    const visible = list.filter((rid) => !hidden.has(rid));
    if (visible.length) rows[pageId] = visible;
  }
  return {
    now: new Date(now).toISOString(),
    full: false,
    pages: ids,
    changed: [...changed],
    rows,
  };
}
