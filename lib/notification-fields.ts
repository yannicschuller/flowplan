// The structured part of a notification (schema 136), next to its
// German `body`: who caused it, its type, an incident's severity, the values
// the inbox builds its line from in the reader's language
// (lib/notification-display.ts) and a short comment excerpt.
//
// A place that creates notifications appends the columns to its INSERT:
//   run(`INSERT INTO notifications(id,user_id,body,page_id,kind,${NOTIFICATION_FIELDS}) VALUES(?,?,?,?,'mention',${NOTIFICATION_FIELD_VALUES})`,
//       …, ...notificationFields({ actorId: user.id, subtype: "mention", params: { page: p.title } }))
// The recipient stays a plain parameter, so lib/db.ts still finds it for
// the live signal.
import type { NotificationSubtype } from "./notification-kinds";

export const NOTIFICATION_FIELDS = "actor_id,subtype,severity,params,excerpt";
export const NOTIFICATION_FIELD_VALUES = "?,?,?,?,?";
export const EXCERPT_LENGTH = 160;
const PARAM_LENGTH = 300;

export type NotificationFields = {
  actorId?: string | null;
  subtype: NotificationSubtype;
  severity?: "warn" | "critical" | null;
  params?: Record<string, string | number | null | undefined>;
  excerpt?: string | null;
};

// A comment's text as one short line: whitespace collapsed, cut at a word.
export function notificationExcerpt(text: string | null | undefined): string | null {
  const line = (text || "").replace(/\s+/g, " ").trim();
  if (!line) return null;
  if (line.length <= EXCERPT_LENGTH) return line;
  const cut = line.slice(0, EXCERPT_LENGTH - 1);
  const space = cut.lastIndexOf(" ");
  return `${space > EXCERPT_LENGTH / 2 ? cut.slice(0, space) : cut}…`;
}

// The values for NOTIFICATION_FIELD_VALUES, in that order.
export function notificationFields(f: NotificationFields): [string | null, string, string | null, string | null, string | null] {
  const params = Object.entries(f.params || {}).filter(([, v]) => v !== null && v !== undefined && v !== "");
  return [
    f.actorId || null,
    f.subtype,
    f.severity || null,
    params.length ? JSON.stringify(Object.fromEntries(params.map(([k, v]) => [k, typeof v === "string" ? v.slice(0, PARAM_LENGTH) : v]))) : null,
    f.excerpt ? notificationExcerpt(f.excerpt) : null,
  ];
}
