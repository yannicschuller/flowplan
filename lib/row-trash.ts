import { z } from "zod";
import { all, id, one, run } from "./db";
import { HttpError } from "./auth";
import { pageRole, requirePage } from "./permissions";
import { maintainRowOrders } from "./row-order-server";
import { cellText } from "./cell-text";
import type { Field, Identity, Page } from "./types";

// Deleted records keep their content, document and comments in the trash so
// they can be restored under the same id (relations pointing at them work
// again). Entries are purged after ROW_TRASH_DAYS.
export const ROW_TRASH_DAYS = 30;
type Payload = {
  row: Record<string, unknown>;
  document: { state: string; html: string; generation: string } | null;
  comments: Record<string, unknown>[];
};
// Called inside the command transaction instead of deleting a record directly.
export function trashRow(user: Identity, page: Page, rowId: string) {
  const row = one<Record<string, unknown> & { cells: string }>(
    "SELECT * FROM rows WHERE id=? AND page_id=?",
    rowId,
    page.id,
  );
  if (!row) return;
  const doc = one<{ state: Uint8Array; html: string; generation: string }>(
    "SELECT state,html,generation FROM row_documents WHERE row_id=?",
    rowId,
  );
  const fields = JSON.parse(
    one<{ fields: string }>(
      "SELECT fields FROM databases WHERE page_id=?",
      page.id,
    )?.fields || "[]",
  ) as Field[];
  const payload: Payload = {
    row,
    document: doc
      ? {
          state: Buffer.from(doc.state).toString("base64"),
          html: doc.html,
          generation: doc.generation,
        }
      : null,
    comments: all(
      "SELECT * FROM comments WHERE page_id=? AND row_id=?",
      page.id,
      rowId,
    ),
  };
  run(
    "INSERT OR REPLACE INTO row_trash(id,page_id,workspace_id,title,payload,deleted_by) VALUES(?,?,?,?,?,?)",
    rowId,
    page.id,
    page.workspace_id,
    cellText(JSON.parse(row.cells)[fields[0]?.id || "title"]).slice(0, 300) ||
      "Ohne Titel",
    JSON.stringify(payload),
    user.id,
  );
  run("DELETE FROM comments WHERE page_id=? AND row_id=?", page.id, rowId);
  run("DELETE FROM rows WHERE id=? AND page_id=?", rowId, page.id);
}

export function listRowTrash(user: Identity, workspaceId: string) {
  return all<
    Page & { trash_id: string; trash_title: string; deleted_at: string }
  >(
    `SELECT p.*,t.id trash_id,t.title trash_title,t.deleted_at FROM row_trash t
     JOIN pages p ON p.id=t.page_id WHERE t.workspace_id=? AND p.deleted_at IS NULL
     ORDER BY t.deleted_at DESC LIMIT 500`,
    workspaceId,
  )
    .filter((p) => pageRole(user, p))
    .map((p) => ({
      id: p.trash_id,
      title: p.trash_title,
      pageId: p.id,
      pageTitle: p.title,
      deletedAt: p.deleted_at,
    }));
}

const input = z.object({ trashId: z.string().uuid() });
function entry(user: Identity, raw: unknown) {
  const { trashId } = input.parse(raw);
  const found = one<{ page_id: string; payload: string }>(
    "SELECT page_id,payload FROM row_trash WHERE id=?",
    trashId,
  );
  if (!found) throw new HttpError(404, "Eintrag nicht im Papierkorb.");
  const page = requirePage(user, found.page_id, true);
  if (page.locked) throw new HttpError(409, "Diese Seite ist gesperrt.");
  return { trashId, page, payload: JSON.parse(found.payload) as Payload };
}
export function restoreTrashedRow(user: Identity, raw: unknown) {
  const { trashId, page, payload } = entry(user, raw);
  if (one("SELECT 1 FROM rows WHERE id=?", trashId))
    throw new HttpError(
      409,
      "Ein Eintrag mit dieser Kennung existiert bereits.",
    );
  const r = payload.row;
  run(
    "INSERT INTO rows(id,page_id,cells,position,created_at,updated_at,created_by,updated_by,content,icon,cover,recurrence) VALUES(?,?,?,?,?,CURRENT_TIMESTAMP,?,?,?,?,?,?)",
    trashId,
    page.id,
    String(r.cells),
    Number(r.position) || 0,
    String(r.created_at || ""),
    (r.created_by as string | null) ?? null,
    user.id,
    String(r.content || ""),
    String(r.icon || ""),
    String(r.cover || ""),
    String(r.recurrence || ""),
  );
  if (payload.document)
    run(
      "INSERT INTO row_documents(row_id,state,html,generation) VALUES(?,?,?,?)",
      trashId,
      Buffer.from(payload.document.state, "base64"),
      payload.document.html,
      id(),
    );
  for (const c of payload.comments)
    run(
      "INSERT OR IGNORE INTO comments(id,page_id,row_id,author_id,body,resolved,created_at) VALUES(?,?,?,?,?,?,?)",
      String(c.id),
      page.id,
      trashId,
      (c.author_id as string | null) ?? null,
      String(c.body),
      Number(c.resolved) || 0,
      String(c.created_at || ""),
    );
  run("DELETE FROM row_trash WHERE id=?", trashId);
  maintainRowOrders(page.id);
  return { ok: true, pageId: page.id, rowId: trashId };
}
export function purgeTrashedRow(user: Identity, raw: unknown) {
  const { trashId } = entry(user, raw);
  run("DELETE FROM row_trash WHERE id=?", trashId);
  return { ok: true };
}
export function expireRowTrash(days = ROW_TRASH_DAYS) {
  return Number(
    run(
      "DELETE FROM row_trash WHERE deleted_at<datetime('now',?)",
      `-${days} days`,
    ).changes,
  );
}
