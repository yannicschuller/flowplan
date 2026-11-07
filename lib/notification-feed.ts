// The newest inbox notifications in short, for apps that ask by themselves
// instead of receiving push: the desktop app (flowplan-desktop) has no push
// service in Electron and polls GET /api/notifications with the session of
// its profile. It gets what the inbox shows – the line in the reader's
// language, where it leads – plus whether the person wants push for that kind
// (Settings → Notifications), so the app shows a system notification only
// where push would have arrived too.
import { all, one } from "./db";
import { cellText } from "./cell-text";
import { contentLocale } from "./content-locale";
import { localizedMessage } from "./i18n-errors";
import { notificationOn } from "./notification-kinds";
import { notificationUrl } from "./page-location";
import { pageRole } from "./permissions";
import { hiddenRowIds } from "./row-access";
import { LOCKED_NOTICE, lockedNotification } from "./journal-extras";
import type { Field, Identity, Page } from "./types";
import { mapAsync } from "./each-async";

const LIMIT = 50;
// Without `since`: the latest few, enough for an app to know what is old.
const FIRST = 20;

// "2026-10-22 08:15:00" (SQLite, UTC) ↔ ISO 8601.
const toIso = (value: string) => `${value.replace(" ", "T")}Z`;
const toSql = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);

// `since`: server time (ISO 8601 or milliseconds, lib/offline-changes.ts
// parseSince); notifications from that second on, the app drops the ones it
// already knows by their id.
export async function notificationFeed(user: Identity, since: number | null) {
  const rows = await all<{
    id: string;
    kind: string | null;
    body: string | null;
    page_id: string | null;
    row_id: string | null;
    thread_id: string | null;
    link: string | null;
    read_at: string | null;
    created_at: string;
    push: number;
  }>(
    `SELECT n.id,n.kind,n.body,n.page_id,n.row_id,n.thread_id,n.link,n.read_at,n.created_at,
       ${notificationOn("push", "n.user_id", "n.kind")} push
     FROM notifications n WHERE n.user_id=? ${since === null ? "" : "AND n.created_at>=?"}
     ORDER BY n.created_at DESC, n.seq DESC LIMIT ?`,
    ...(since === null ? [user.id, FIRST] : [user.id, toSql(since), LIMIT]),
  );
  const unread = Number(
    (await one<{ n: number }>("SELECT COUNT(*) n FROM notifications WHERE user_id=? AND read_at IS NULL", user.id))?.n || 0,
  );
  const locale = contentLocale();
  const pages = new Map<string, Page | null>();
  const pageOf = async (pid: string) => {
    if (!pages.has(pid)) {
      const page = await one<Page>("SELECT * FROM pages WHERE id=? AND deleted_at IS NULL", pid);
      pages.set(pid, page && await pageRole(user, page) ? page : null);
    }
    return pages.get(pid)!;
  };
  const locked = await lockedNotification();
  return {
    now: new Date().toISOString(),
    unread,
    notifications: await mapAsync(rows, async (n) => {
      const page = n.page_id ? (await pageOf(n.page_id)) : null;
      // Behind a journal PIN not entered: neither its text nor the record.
      const secret = !!page && await locked(n, user.id);
      // Like push (lib/push.ts): nothing for a page that is gone or no
      // longer readable, and nothing about a record hidden from the reader.
      const hidden = !!n.row_id && !!page && (await hiddenRowIds(user, page)).has(n.row_id);
      const gone = (!!n.page_id && !page) || hidden;
      let detail = "";
      if (page && n.row_id && !hidden && !secret) {
        const fields = JSON.parse((await one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", page.id))?.fields || "[]") as Field[];
        const cells = await one<{ cells: string }>("SELECT cells FROM rows WHERE id=? AND page_id=?", n.row_id, page.id);
        if (cells) detail = cellText((JSON.parse(cells.cells) as Record<string, unknown>)[fields[0]?.id || "title"]).trim();
      }
      return {
        id: n.id,
        kind: n.kind,
        text: localizedMessage(secret ? LOCKED_NOTICE : n.body || "", locale).slice(0, 300),
        detail: detail.slice(0, 120),
        url: gone ? "/#inbox" : notificationUrl(n),
        createdAt: toIso(n.created_at),
        read: !!n.read_at,
        push: !!n.push && !gone,
      };
    }),
  };
}
