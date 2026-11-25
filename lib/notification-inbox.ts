// The inbox's notifications: the newest ones with the bootstrap, older
// ones page by page (GET /api/notifications/inbox?before=<id>), the number
// of unread ones for the badges, and the command for several at once.
import { z } from "zod";
import { all, nowText, one, run } from "./db";
import { HttpError } from "./auth";
import { LOCKED_NOTICE, lockedNotification } from "./journal-extras";
import { mapAsync } from "./each-async";
import type { Bootstrap, Identity } from "./types";

type InboxRow = Bootstrap["notifications"][number];
// The bootstrap's first page; GET …/inbox pages after it.
export const INBOX_FIRST = 100;
export const INBOX_PAGE = 50;
const COLUMNS =
  "id,body,markup,page_id,row_id,thread_id,link,kind,read_at,created_at,actor_id,subtype,severity,params,excerpt";

// Newest first; `before`: the id of the last one the client has.
export async function inboxNotifications(user: Identity, { before, limit = INBOX_FIRST }: { before?: string | null; limit?: number } = {}) {
  let where = "";
  const args: (string | number)[] = [user.id];
  if (before) {
    const cursor = await one<{ created_at: string; seq: number }>(
      "SELECT created_at,seq FROM notifications WHERE id=? AND user_id=?",
      before,
      user.id,
    );
    // Removed meanwhile: start again from the newest.
    if (cursor) {
      where = " AND (created_at<? OR (created_at=? AND seq<?))";
      args.push(cursor.created_at, cursor.created_at, cursor.seq);
    }
  }
  const rows = await all<InboxRow & { kind: string | null }>(
    `SELECT ${COLUMNS} FROM notifications WHERE user_id=? AND push_only IS NULL${where} ORDER BY created_at DESC,seq DESC LIMIT ?`,
    ...args,
    limit + 1,
  );
  const locked = await lockedNotification();
  const notifications = await mapAsync(rows.slice(0, limit), async (n) =>
    // Behind a journal PIN not entered: only that the journal is locked –
    // no text, values or excerpt.
    (await locked(n, user.id))
      ? { ...n, body: LOCKED_NOTICE, markup: null, subtype: null, severity: null, params: null, excerpt: null }
      : n,
  );
  return { notifications, more: rows.length > limit };
}

export async function unreadNotifications(userId: string) {
  return Number(
    (await one<{ n: number }>("SELECT COUNT(*) n FROM notifications WHERE user_id=? AND read_at IS NULL AND push_only IS NULL", userId))?.n || 0,
  );
}

// notification.bulk: read, unread or remove several of your own at once.
export const notificationBulkSchema = z.object({
  notificationIds: z.array(z.string().min(1).max(100)).min(1).max(500),
  op: z.enum(["read", "unread", "delete"]),
});
export async function notificationBulk(user: Identity, input: unknown) {
  const { notificationIds, op } = notificationBulkSchema.parse(input);
  const ids = [...new Set(notificationIds)];
  const marks = ids.map(() => "?").join(",");
  const changed =
    op === "delete"
      ? (await run(`DELETE FROM notifications WHERE user_id=? AND id IN (${marks})`, user.id, ...ids)).changes
      : (await run(
          // Read stays read since then; unread clears it.
          `UPDATE notifications SET read_at=${op === "read" ? "COALESCE(read_at,?)" : "?"} WHERE user_id=? AND id IN (${marks})`,
          op === "read" ? nowText() : null,
          user.id,
          ...ids,
        )).changes;
  if (!Number(changed)) throw new HttpError(404, "Benachrichtigung nicht gefunden.");
  return { changed: Number(changed) };
}
