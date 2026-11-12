/** Internal links carry identifiers only; authorization remains on every API read. */
export type PageLocation = {
  pageId: string;
  rowId?: string;
  threadId?: string;
  // An element of a whiteboard (element links, lib/whiteboard-links.ts).
  itemId?: string;
  // A block of the document (block links, lib/block-ids.ts).
  blockId?: string;
  // A record shown as a page of its own in the main area instead of a
  // dialog over its database (#231): "&full=1". Only with a record.
  full?: boolean;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function parsePageLocation(hash: string): PageLocation | null {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  if (
    [...params.keys()].some((key) => !["page", "row", "thread", "item", "block", "full"].includes(key))
  )
    return null;
  if (["page", "row", "thread", "item", "block", "full"].some((key) => params.getAll(key).length > 1))
    return null;
  const pageId = params.get("page"),
    rowId = params.get("row"),
    threadId = params.get("thread"),
    itemId = params.get("item"),
    blockId = params.get("block"),
    full = params.get("full");
  if (
    !pageId ||
    !uuid.test(pageId) ||
    (itemId !== null && !/^[\w-]{1,64}$/.test(itemId)) ||
    (blockId !== null && !/^[\w-]{1,64}$/.test(blockId)) ||
    (rowId !== null && !uuid.test(rowId)) ||
    (threadId !== null && !uuid.test(threadId)) ||
    (full !== null && (full !== "1" || rowId === null))
  )
    return null;
  return {
    pageId,
    ...(rowId ? { rowId } : {}),
    ...(threadId ? { threadId } : {}),
    ...(itemId ? { itemId } : {}),
    ...(blockId ? { blockId } : {}),
    ...(full ? { full: true } : {}),
  };
}
export function pageLocationHash(target: PageLocation): string {
  const params = new URLSearchParams({ page: target.pageId });
  if (target.rowId) params.set("row", target.rowId);
  if (target.threadId) params.set("thread", target.threadId);
  if (target.itemId) params.set("item", target.itemId);
  if (target.blockId) params.set("block", target.blockId);
  if (target.full && target.rowId) params.set("full", "1");
  const hash = `#${params}`;
  return parsePageLocation(hash) ? hash : "#inbox";
}
// Where a notification leads beyond pages (notifications.link): only
// in-app hash routes of the settings and the administration ("#admin/…",
// "#settings/…" with plain path segments) – never another address.
const notificationLink = /^#(admin|settings)(\/[A-Za-z0-9_-]{1,64}){0,3}$/;
export const isNotificationLink = (link: unknown): link is string =>
  typeof link === "string" && link.length <= 200 && notificationLink.test(link);
export function notificationUrl(notification: {
  page_id: string | null;
  row_id?: string | null;
  thread_id?: string | null;
  link?: string | null;
  kind?: string | null;
  body?: string | null;
}): string {
  if (!notification.page_id) {
    if (isNotificationLink(notification.link)) return `/${notification.link}`;
    // Incidents reported before notifications had a target (kind
    // "security", "Sicherheit: …"): the administration's security page.
    if (notification.kind === "security" && notification.body?.startsWith("Sicherheit: ")) return "/#admin/threats";
  }
  // A block of the page (a meeting's reminder, lib/meeting-reminders.ts): "block:<id>".
  const block = notification.page_id && typeof notification.link === "string" ? /^block:([\w-]{1,64})$/.exec(notification.link)?.[1] : undefined;
  return notification.page_id
    ? `/${pageLocationHash({ pageId: notification.page_id, rowId: notification.row_id || undefined, threadId: notification.thread_id || undefined, ...(block ? { blockId: block } : {}) })}`
    : "/#inbox";
}

/** OIDC return paths are limited to the application root and validated hash targets. */
export function loginReturnPath(value: unknown): string {
  if (value === "/#inbox") return value;
  // Where a notification leads (an incident of the instance).
  if (typeof value === "string" && value.startsWith("/#") && isNotificationLink(value.slice(1))) return value;
  // Signing in the desktop app through the browser (lib/desktop-sign-in.ts).
  if (typeof value === "string" && /^\/api\/auth\/desktop\?challenge=[A-Za-z0-9_-]{43}$/.test(value)) return value;
  // Content shared from another app waits for the sign-in.
  if (typeof value === "string" && /^\/share-target\?[^#\\]{0,4000}$/.test(value) && !value.includes("//"))
    return value;
  if (typeof value !== "string" || !value.startsWith("/#")) return "/";
  const target = parsePageLocation(value.slice(1));
  return target ? `/${pageLocationHash(target)}` : "/";
}
