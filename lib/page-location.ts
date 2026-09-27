/** Internal links carry identifiers only; authorization remains on every API read. */
export type PageLocation = {
  pageId: string;
  rowId?: string;
  threadId?: string;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function parsePageLocation(hash: string): PageLocation | null {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  if (
    [...params.keys()].some((key) => !["page", "row", "thread"].includes(key))
  )
    return null;
  if (["page", "row", "thread"].some((key) => params.getAll(key).length > 1))
    return null;
  const pageId = params.get("page"),
    rowId = params.get("row"),
    threadId = params.get("thread");
  if (
    !pageId ||
    !uuid.test(pageId) ||
    (rowId !== null && !uuid.test(rowId)) ||
    (threadId !== null && !uuid.test(threadId))
  )
    return null;
  return {
    pageId,
    ...(rowId ? { rowId } : {}),
    ...(threadId ? { threadId } : {}),
  };
}
export function pageLocationHash(target: PageLocation): string {
  const params = new URLSearchParams({ page: target.pageId });
  if (target.rowId) params.set("row", target.rowId);
  if (target.threadId) params.set("thread", target.threadId);
  const hash = `#${params}`;
  return parsePageLocation(hash) ? hash : "#inbox";
}
export function notificationUrl(notification: {
  page_id: string | null;
  row_id?: string | null;
  thread_id?: string | null;
}): string {
  return notification.page_id
    ? `/${pageLocationHash({ pageId: notification.page_id, rowId: notification.row_id || undefined, threadId: notification.thread_id || undefined })}`
    : "/#inbox";
}

/** OIDC return paths are limited to the application root and validated hash targets. */
export function loginReturnPath(value: unknown): string {
  if (value === "/#inbox") return value;
  // Content shared from another app waits for the sign-in.
  if (typeof value === "string" && /^\/share-target\?[^#\\]{0,4000}$/.test(value) && !value.includes("//"))
    return value;
  if (typeof value !== "string" || !value.startsWith("/#")) return "/";
  const target = parsePageLocation(value.slice(1));
  return target ? `/${pageLocationHash(target)}` : "/";
}
