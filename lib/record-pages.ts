// Sub-pages under records (#231, part 3). A page below a record keeps its
// database page as parent (pages.parent_id) and names the record in
// pages.parent_row_id (lib/db.ts, schema 104). So everything that walks the
// page tree – the trash of the database, moving it to another space or
// workspace, its exports, sharing or publishing it – finds these pages below
// the database, and the record adds what is its own:
//
// - access: the record's role (lib/permissions.ts → subPageRecordRole), so a
//   private or read-only record covers its sub-pages,
// - lifecycle: deleting the record moves its sub-pages to the trash with the
//   same date, restoring it brings them back, deleting it for good deletes
//   them (lib/row-trash.ts); moving it to another database takes them along
//   (lib/row-transfer.ts); turning it into a page makes them that page's
//   sub-pages (lib/record-to-page.ts),
// - the sidebar, the breadcrumb (lib/page-path.ts) and the record's
//   "Unterseiten" list, through `recordParents` in the bootstrap.
//
// Duplicating a record copies the record alone (as before): its sub-pages
// can be big trees of their own and are duplicated as pages when wanted.
import { all, one, run } from "./db";
import { HttpError } from "./auth";
import { requireRow } from "./row-documents";
import { rowRole } from "./row-access";
import { cellText } from "./cell-text";
import { trashPageTree } from "./page-trash";
import { purgePages } from "./workspace-lifecycle";
import { claimTicketPrefix } from "./ticket-refs";
import { applyMovePlan, moveForeignMeta } from "./meta-scope-server";
import { filterAsync } from "./each-async";
import type { Field, Identity, Page } from "./types";

// The record a page goes below: the person may edit it (and its database).
export async function requireRecordParent(user: Identity, database: Page, rowId: string) {
  if (database.kind !== "database") throw new HttpError(400, "Unterseiten gibt es nur unter Einträgen einer Datenbank.");
  const { row } = await requireRow(user, database.id, rowId, true);
  return row;
}

// The record's own sub-pages (the first level below it).
export async function recordSubPageIds(databaseId: string, rowId: string) {
  return (await all<{ id: string }>(
    "SELECT id FROM pages WHERE parent_id=? AND parent_row_id=? AND deleted_at IS NULL ORDER BY position,id",
    databaseId,
    rowId,
  )).map((p) => p.id);
}
// The record's sub-pages with everything below them.
export async function recordSubTree(databaseId: string, rowId: string, deleted = false) {
  return await all<Page>(
    `WITH RECURSIVE tree(id) AS (SELECT id FROM pages WHERE parent_id=? AND parent_row_id=? AND ${deleted ? "1=1" : "deleted_at IS NULL"}
     UNION ALL SELECT p.id FROM pages p JOIN tree t ON p.parent_id=t.id WHERE ${deleted ? "1=1" : "p.deleted_at IS NULL"})
     SELECT p.* FROM pages p JOIN tree t ON t.id=p.id`,
    databaseId,
    rowId,
  );
}

// ---- With the record into the trash and back ----

export type TrashedSubPages = { ids: string[]; deletedAt: string };
// Called by trashRow before the record leaves rows (its role still counts).
export async function trashRecordSubPages(user: Identity, database: Page, rowId: string, deletedAt: string): Promise<TrashedSubPages | undefined> {
  const ids: string[] = [];
  for (const child of await recordSubPageIds(database.id, rowId)) ids.push(...(await trashPageTree(user, child, deletedAt)));
  return ids.length ? { ids, deletedAt } : undefined;
}
// The record is back: so are its sub-pages that were trashed with it and
// are still in the trash (one restored on its own meanwhile stays where it
// went).
export async function restoreRecordSubPages(trashed: TrashedSubPages | undefined) {
  if (!trashed?.ids.length) return;
  for (const pid of trashed.ids) {
    const restored = (await run("UPDATE pages SET deleted_at=NULL WHERE id=? AND deleted_at=?", pid, trashed.deletedAt)).changes;
    // A prefix taken meanwhile by another database: a new one (as page.restore).
    if (restored) await claimTicketPrefix(pid);
  }
}
// The record is deleted for good: its sub-pages still waiting with it go too.
export async function purgeRecordSubPages(workspaceId: string, trashed: TrashedSubPages | undefined) {
  if (!trashed?.ids.length) return;
  const pages = await all<Page>(
    `SELECT * FROM pages WHERE id IN (${trashed.ids.map(() => "?").join(",")}) AND deleted_at=?`,
    ...trashed.ids,
    trashed.deletedAt,
  );
  if (pages.length) await purgePages(workspaceId, pages);
}

// ---- Moving the record ----

// The record moves to another database (lib/row-transfer.ts, "move"): its
// sub-pages go along, below it in the target database. Into another space
// their tags and properties of the old space are mapped as "auto" does when
// pages are moved (same name there, else a copy; lib/meta-scope-server.ts).
export async function moveRecordSubPages(user: Identity, source: Page, target: Page, rowId: string) {
  const tree = await recordSubTree(source.id, rowId, true);
  if (!tree.length) return;
  if (target.space_id !== source.space_id || target.workspace_id !== source.workspace_id) {
    const ids = tree.map((p) => p.id);
    const to = { workspaceId: target.workspace_id, spaceId: target.space_id };
    const foreign = await moveForeignMeta(ids, to);
    for (const p of tree) await run("UPDATE pages SET space_id=? WHERE id=?", target.space_id, p.id);
    await applyMovePlan(user, ids, foreign, { default: "auto" }, to);
  }
  await run("UPDATE pages SET parent_id=? WHERE parent_id=? AND parent_row_id=?", target.id, source.id, rowId);
}
// The record becomes a page (lib/record-to-page.ts): its sub-pages become
// that page's sub-pages.
export async function adoptRecordSubPages(database: Page, rowId: string, page: Page) {
  const tree = await recordSubTree(database.id, rowId, true);
  if (!tree.length) return;
  if (page.space_id !== database.space_id)
    for (const p of tree) await run("UPDATE pages SET space_id=? WHERE id=?", page.space_id, p.id);
  await run("UPDATE pages SET parent_id=?,parent_row_id=NULL WHERE parent_id=? AND parent_row_id=?", page.id, database.id, rowId);
}

// ---- What the app shows ----

export type RecordParent = { pageId: string; rowId: string; title: string; icon: string };
// The records the given (readable) pages sit under, those this person may
// see: for the sidebar, the breadcrumb and the record's sub-page list. A
// page below a record that is hidden from the person (reached through a
// grant of its own) shows without its record.
export async function recordParents(user: Identity, pages: Page[]): Promise<RecordParent[]> {
  const wanted = new Map<string, string>();
  for (const p of pages) if (p.parent_row_id && p.parent_id && !p.deleted_at) wanted.set(p.parent_row_id, p.parent_id);
  if (!wanted.size) return [];
  const byId = new Map(pages.map((p) => [p.id, p]));
  const out: RecordParent[] = [];
  const fieldsOf = new Map<string, Field[]>();
  for (const [rowId, pageId] of wanted) {
    const database = byId.get(pageId);
    if (!database || database.kind !== "database") continue;
    const row = await one<{ id: string; cells: string; icon: string | null; access: string; created_by: string | null }>(
      "SELECT id,cells,icon,access,created_by FROM rows WHERE id=? AND page_id=?",
      rowId,
      pageId,
    );
    if (!row || !(await rowRole(user, database, row))) continue;
    if (!fieldsOf.has(pageId))
      fieldsOf.set(pageId, JSON.parse((await one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", pageId))?.fields || "[]"));
    const title = cellText((JSON.parse(row.cells) as Record<string, unknown>)[fieldsOf.get(pageId)![0]?.id || "title"]);
    out.push({ pageId, rowId, title: title || "", icon: row.icon || "" });
  }
  return out;
}
// Pages below records hidden from the person: left out of exports and
// copies of the database made by them, as the records themselves are.
export async function hiddenRecordPageIds(user: Identity, pages: Page[]) {
  const byId = new Map(pages.map((p) => [p.id, p]));
  const hidden = new Set<string>();
  const under = await filterAsync(pages, async (p) => {
    if (!p.parent_row_id || !p.parent_id) return false;
    const database = byId.get(p.parent_id) || (await one<Page>("SELECT * FROM pages WHERE id=?", p.parent_id));
    if (!database) return false;
    const row = await one<{ id: string; access: string; created_by: string | null }>(
      "SELECT id,access,created_by FROM rows WHERE id=? AND page_id=?",
      p.parent_row_id,
      database.id,
    );
    return !!row && !(await rowRole(user, database, row));
  });
  for (const p of under) hidden.add(p.id);
  // And everything below them.
  let grown = true;
  while (grown) {
    grown = false;
    for (const p of pages)
      if (p.parent_id && hidden.has(p.parent_id) && !hidden.has(p.id)) {
        hidden.add(p.id);
        grown = true;
      }
  }
  return hidden;
}
// Pages of a page tree that sit below private records (and everything
// below them): a link or publication of the database never reaches them,
// as it never reaches the private records themselves.
export async function privateRecordPageIds(pages: Pick<Page, "id" | "parent_id" | "parent_row_id">[]) {
  const out = new Set<string>();
  const rowIds = [...new Set(pages.map((p) => p.parent_row_id).filter((r): r is string => !!r))];
  if (!rowIds.length) return out;
  const open = new Set(
    (await all<{ id: string }>(
      `SELECT id FROM rows WHERE access!='private' AND id IN (${rowIds.map(() => "?").join(",")})`,
      ...rowIds,
    )).map((r) => r.id),
  );
  // A record not in rows (in the trash) shares nothing either.
  for (const p of pages) if (p.parent_row_id && !open.has(p.parent_row_id)) out.add(p.id);
  let grown = out.size > 0;
  while (grown) {
    grown = false;
    for (const p of pages)
      if (p.parent_id && out.has(p.parent_id) && !out.has(p.id)) {
        out.add(p.id);
        grown = true;
      }
  }
  return out;
}
