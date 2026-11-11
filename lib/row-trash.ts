import { z } from "zod";
import { all, id, one, run, nowText, daysAgoText } from "./db";
import { HttpError } from "./auth";
import { pageRole, requirePage } from "./permissions";
import { lockedPageIds, requireUnlocked } from "./journal-extras";
import { maintainRowOrders } from "./row-order-server";
import { reindexRowTasks } from "./doc-tasks";
import { roleWithGrants, rowGrants, type RowGrant } from "./row-access";
import { cellText } from "./cell-text";
import { ct } from "./content-locale";
import type { Field, Identity, Page } from "./types";
import { filterAsync } from "./each-async";

// Deleted records keep their content, document and comments in the trash so
// they can be restored under the same id (relations pointing at them work
// again). Entries are purged after ROW_TRASH_DAYS.
export const ROW_TRASH_DAYS = 30;
type Payload = {
  row: Record<string, unknown>;
  document: { state: string; html: string; generation: string } | null;
  comments: Record<string, unknown>[];
  grants?: RowGrant[];
  // Removed with the record by the foreign keys; kept so a restore is
  // lossless (entries trashed before have none).
  snapshots?: { id: string; state: string; html: string; created_by: string | null; created_at: string; kind: string }[];
  sharedComments?: Record<string, unknown>[];
  reactions?: Record<string, unknown>[];
};
export const trashedRole = async (user: Identity, page: Page, payload: Payload) =>
  await roleWithGrants(
    user,
    page,
    {
      id: String(payload.row.id),
      access: String(payload.row.access || "inherit"),
      created_by: (payload.row.created_by as string | null) ?? null,
    },
    payload.grants || [],
  );
// Called inside the command transaction instead of deleting a record directly.
export async function trashRow(user: Identity, page: Page, rowId: string) {
  const row = await one<Record<string, unknown> & { cells: string }>(
    "SELECT * FROM rows WHERE id=? AND page_id=?",
    rowId,
    page.id,
  );
  if (!row) return;
  const doc = await one<{ state: Uint8Array; html: string; generation: string }>(
    "SELECT state,html,generation FROM row_documents WHERE row_id=?",
    rowId,
  );
  const fields = JSON.parse(
    (await one<{ fields: string }>(
      "SELECT fields FROM databases WHERE page_id=?",
      page.id,
    ))?.fields || "[]",
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
    comments: await all(
      "SELECT * FROM comments WHERE page_id=? AND row_id=?",
      page.id,
      rowId,
    ),
    grants: await rowGrants(rowId),
    snapshots: (await all<{ id: string; state: Uint8Array; html: string; created_by: string | null; created_at: string; kind: string }>(
      "SELECT id,state,html,created_by,created_at,kind FROM row_snapshots WHERE row_id=?",
      rowId,
    )).map((s) => ({ ...s, state: Buffer.from(s.state).toString("base64") })),
    sharedComments: await all(
      "SELECT id,name,body,resolved,created_at FROM shared_comments WHERE page_id=? AND row_id=?",
      page.id,
      rowId,
    ),
    reactions: await all(
      "SELECT r.comment_id,r.user_id,r.emoji,r.created_at FROM comment_reactions r JOIN comments c ON c.id=r.comment_id WHERE c.page_id=? AND c.row_id=?",
      page.id,
      rowId,
    ),
  };
  await run(
    "INSERT INTO row_trash(id,page_id,workspace_id,title,payload,deleted_by) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET page_id=excluded.page_id,workspace_id=excluded.workspace_id,title=excluded.title,payload=excluded.payload,deleted_by=excluded.deleted_by,deleted_at=excluded.deleted_at",
    rowId,
    page.id,
    page.workspace_id,
    cellText(JSON.parse(row.cells)[fields[0]?.id || "title"]).slice(0, 300) ||
      ct("Ohne Titel", "Untitled"),
    JSON.stringify(payload),
    user.id,
  );
  await run("DELETE FROM comments WHERE page_id=? AND row_id=?", page.id, rowId);
  await run("DELETE FROM rows WHERE id=? AND page_id=?", rowId, page.id);
}

export async function listRowTrash(user: Identity, workspaceId: string) {
  // Not even the titles of records behind a journal PIN.
  const locked = await lockedPageIds(user, workspaceId);
  return (await filterAsync(await all<
    Page & {
      trash_id: string;
      trash_title: string;
      deleted_at: string;
      payload: string;
    }
  >(
    `SELECT p.*,t.id trash_id,t.title trash_title,t.deleted_at,t.payload FROM row_trash t
     JOIN pages p ON p.id=t.page_id WHERE t.workspace_id=? AND p.deleted_at IS NULL
     ORDER BY t.deleted_at DESC LIMIT 500`,
    workspaceId,
  ), 
      async (p) =>
        await pageRole(user, p) &&
        !locked.has(p.id) &&
        await trashedRole(user, p, JSON.parse(p.payload)),
    ))
    .map((p) => ({
      id: p.trash_id,
      title: p.trash_title,
      pageId: p.id,
      pageTitle: p.title,
      deletedAt: p.deleted_at,
    }));
}

const input = z.object({ trashId: z.string().uuid() });
async function entry(user: Identity, raw: unknown) {
  const { trashId } = input.parse(raw);
  const found = await one<{ page_id: string; payload: string }>(
    "SELECT page_id,payload FROM row_trash WHERE id=?",
    trashId,
  );
  if (!found) throw new HttpError(404, "Eintrag nicht im Papierkorb.");
  const page = await requirePage(user, found.page_id, true);
  if (page.locked) throw new HttpError(409, "Diese Seite ist gesperrt.");
  await requireUnlocked(user, page);
  const payload = JSON.parse(found.payload) as Payload;
  const role = await trashedRole(user, page, payload);
  if (!role) throw new HttpError(404, "Eintrag nicht im Papierkorb.");
  if (role === "viewer")
    throw new HttpError(403, "Dieser Eintrag ist für dich schreibgeschützt.");
  return { trashId, page, payload };
}
export async function restoreTrashedRow(user: Identity, raw: unknown) {
  const { trashId, page, payload } = await entry(user, raw);
  if (await one("SELECT 1 FROM rows WHERE id=?", trashId))
    throw new HttpError(
      409,
      "Ein Eintrag mit dieser Kennung existiert bereits.",
    );
  const r = payload.row;
  // Two-way relations sync the other side on insert, which fails for a
  // linked record deleted meanwhile: that link is dropped, as the other
  // side already dropped it when this record was deleted.
  const cells = JSON.parse(String(r.cells)) as Record<string, unknown>;
  const twoWay = new Set(
    (await all<{ field_id: string }>("SELECT field_id FROM relation_endpoints WHERE page_id=?", page.id)).map((e) => e.field_id),
  );
  const fields = JSON.parse(
    (await one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", page.id))?.fields || "[]",
  ) as Field[];
  for (const f of fields) {
    if (f.type !== "relation" || !twoWay.has(f.id) || !Array.isArray(cells[f.id])) continue;
    cells[f.id] = await filterAsync(
      cells[f.id] as unknown[],
      async (target) =>
        typeof target === "string" &&
        ((f.relationPage === page.id && target === trashId) ||
          !!(await one("SELECT 1 FROM rows WHERE id=? AND page_id=?", target, f.relationPage || ""))),
    );
  }
  await run(
    // The ticket number comes back too (unless another record took it).
    "INSERT INTO rows(id,page_id,cells,position,created_at,updated_at,created_by,updated_by,content,icon,cover,recurrence,access,number,repeat) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    trashId,
    page.id,
    JSON.stringify(cells),
    Number(r.position) || 0,
    String(r.created_at || ""), nowText(),
    (r.created_by as string | null) ?? null,
    user.id,
    String(r.content || ""),
    String(r.icon || ""),
    String(r.cover || ""),
    String(r.recurrence || ""),
    ["readonly", "private"].includes(String(r.access))
      ? String(r.access)
      : "inherit",
    Number.isInteger(r.number) && !(await one("SELECT 1 FROM rows WHERE page_id=? AND number=?", page.id, r.number as number))
      ? (r.number as number)
      : null,
    String(r.repeat || ""),
  );
  for (const g of payload.grants || [])
    await run(
      "INSERT INTO row_grants(row_id,user_id,group_id,role) VALUES(?,?,?,?) ON CONFLICT DO NOTHING",
      trashId,
      g.user_id,
      g.group_id,
      g.role,
    );
  if (payload.document)
    await run(
      "INSERT INTO row_documents(row_id,state,html,generation) VALUES(?,?,?,?)",
      trashId,
      Buffer.from(payload.document.state, "base64"),
      payload.document.html,
      id(),
    );
  for (const c of payload.comments)
    await run(
      "INSERT INTO comments(id,page_id,row_id,author_id,body,resolved,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING",
      String(c.id),
      page.id,
      trashId,
      (c.author_id as string | null) ?? null,
      String(c.body),
      Number(c.resolved) || 0,
      String(c.created_at || ""),
    );
  for (const c of payload.reactions || [])
    await run(
      // Not for people deleted meanwhile.
      "INSERT INTO comment_reactions(comment_id,user_id,emoji,created_at) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM users WHERE id=?) AND EXISTS(SELECT 1 FROM comments WHERE id=?) ON CONFLICT DO NOTHING",
      String(c.comment_id),
      String(c.user_id),
      String(c.emoji),
      Number(c.created_at) || Date.now(),
      String(c.user_id),
      String(c.comment_id),
    );
  for (const c of payload.sharedComments || [])
    await run(
      "INSERT INTO shared_comments(id,page_id,row_id,name,body,resolved,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING",
      String(c.id),
      page.id,
      trashId,
      String(c.name),
      String(c.body),
      Number(c.resolved) || 0,
      String(c.created_at || ""),
    );
  for (const s of payload.snapshots || [])
    await run(
      "INSERT INTO row_snapshots(id,row_id,state,html,created_by,created_at,kind) VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING",
      s.id,
      trashId,
      Buffer.from(s.state, "base64"),
      s.html,
      s.created_by ?? null,
      s.created_at,
      s.kind || "auto",
    );
  await run("DELETE FROM row_trash WHERE id=?", trashId);
  await maintainRowOrders(page.id);
  // Its tasks went with it (lib/db.ts, schema 76): back into "My tasks".
  await reindexRowTasks(user, page, [trashId]);
  return { ok: true, pageId: page.id, rowId: trashId };
}
export async function purgeTrashedRow(user: Identity, raw: unknown) {
  const { trashId } = await entry(user, raw);
  await run("DELETE FROM row_trash WHERE id=?", trashId);
  return { ok: true };
}
export async function expireRowTrash(days = ROW_TRASH_DAYS) {
  return Number(
    (await run(
      "DELETE FROM row_trash WHERE deleted_at<?",
      daysAgoText(days),
    )).changes,
  );
}
