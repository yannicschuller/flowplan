// How the inbox shows a notification: its line built in the reader's
// language from notifications.subtype and params (lib/notification-fields.ts)
// – the person who caused it, what happened, where, and a detail – plus its
// group, the main action and what counts as "the same" for collapsing.
// Rows without a subtype (older ones, kinds that only carry a text) show
// their `body` as it is (translated where the server's catalogue knows it).
import { securityRules, type SecurityRule } from "./security-kinds";
import { isNotificationSubtype, notificationCategory, type NotificationCategory, type NotificationSubtype } from "./notification-kinds";
import type { Bootstrap } from "./types";

type Note = Bootstrap["notifications"][number];
type T = (de: string, en: string) => string;

export type NotificationLine = {
  category: NotificationCategory;
  subtype: NotificationSubtype | null;
  // The person: shown as an avatar, their name before the title.
  actor?: { id: string | null; name: string };
  // With an actor the verb phrase ("hat dich erwähnt"), else the subject.
  title: string;
  // Where it happened: a page, a workspace.
  place?: string;
  // A comment's first words, a task, a date, an incident's numbers.
  detail?: string;
  severity?: "warn" | "critical";
  // Only the body (no structured fields): show it as the line.
  plain: boolean;
};

export function notificationParams(n: Pick<Note, "params">): Record<string, string> {
  if (!n.params) return {};
  try {
    const value = JSON.parse(n.params);
    return value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, String(v ?? "")]))
      : {};
  } catch {
    return {};
  }
}

export function notificationLine(
  n: Note,
  t: T,
  members: readonly { id: string; name: string }[] = [],
  // The body as the reader should see it (components: serverMessage).
  body: (text: string) => string = (text) => text,
): NotificationLine {
  const subtype = isNotificationSubtype(n.subtype) ? n.subtype : null;
  const category = notificationCategory(n.kind, subtype);
  const p = notificationParams(n);
  const severity = n.severity === "critical" || n.severity === "warn" ? n.severity : undefined;
  const actorName = (n.actor_id && members.find((m) => m.id === n.actor_id)?.name) || p.actor;
  const actor = actorName ? { id: n.actor_id || null, name: actorName } : undefined;
  const untitled = t("Ohne Titel", "Untitled");
  const page = p.page || untitled;
  const excerpt = n.excerpt || undefined;
  const plain = (): NotificationLine => ({ category, subtype: null, title: body(n.body || ""), severity, plain: true });
  if (!subtype) return plain();
  // A person's action: without the person known, the body says it best.
  const by = (title: string, more: Partial<NotificationLine> = {}): NotificationLine =>
    actor ? { category, subtype, actor, title, place: page, plain: false, ...more } : plain();
  switch (subtype) {
    case "mention":
      return by(t("hat dich erwähnt", "mentioned you"));
    case "record_mention":
      return by(t("hat dich in einem Eintrag erwähnt", "mentioned you in a record"));
    case "comment_mention":
      return by(t("hat dich in einem Kommentar erwähnt", "mentioned you in a comment"), { detail: excerpt });
    case "comment":
      return by(t("hat kommentiert", "commented"), { detail: excerpt });
    case "comment_text":
      return by(t("hat eine Textstelle kommentiert", "commented on a passage"), { detail: excerpt });
    case "comment_reply":
      return by(t("hat auf einen Kommentar geantwortet", "replied to a comment"), { detail: excerpt });
    case "assignment":
      return by(t("hat dir eine Aufgabe gegeben", "gave you a task"), { detail: p.task });
    case "share":
      return by(t("hat eine Seite mit dir geteilt", "shared a page with you"));
    case "workspace_added":
      return by(t("hat dich zu einem Arbeitsbereich hinzugefügt", "added you to a workspace"), { place: p.workspace || undefined });
    case "change":
      return by(t("hat eine Seite geändert", "changed a page"));
    case "task_due":
      return { category, subtype, title: p.task ? t(`Heute fällig: ${p.task}`, `Due today: ${p.task}`) : body(n.body), place: p.page || undefined, plain: false };
    case "date_reminder":
      return {
        category,
        subtype,
        title: t(`Erinnerung: ${p.record || untitled}`, `Reminder: ${p.record || untitled}`),
        detail: p.field && p.date ? `${p.field}: ${p.date}` : p.date || undefined,
        plain: false,
      };
    case "approval":
      return {
        category,
        subtype,
        title: t(`Freigabe erbeten: ${p.workflow || "Workflow"}`, `Approval requested: ${p.workflow || "Workflow"}`),
        detail: p.message || t("Bitte genehmigen oder ablehnen.", "Please approve or reject."),
        plain: false,
      };
    case "incident": {
      const rule = securityRules[p.rule as SecurityRule];
      if (!rule) return plain();
      return { category, subtype, title: t(rule.de, rule.en), detail: p.detail || undefined, severity: severity ?? (rule.severity === "critical" ? "critical" : "warn"), plain: false };
    }
  }
  return plain();
}

// The button that says what to do with it; none where opening is all.
export function notificationActionLabel(line: Pick<NotificationLine, "subtype">, t: T): string | null {
  switch (line.subtype) {
    case "incident":
      return t("Zum Vorfall", "View incident");
    case "approval":
      return t("Prüfen", "Review");
    case "assignment":
    case "task_due":
      return t("Zur Aufgabe", "Open task");
    case "date_reminder":
      return t("Zum Eintrag", "Open record");
    case "comment_mention":
    case "comment":
    case "comment_text":
    case "comment_reply":
      return t("Antworten", "Reply");
    default:
      return null;
  }
}

// Notifications that say the same: an incident of one rule, or one person's
// comments, changes … on one page. Others stand alone (their id).
export function similarKey(n: Note, line: NotificationLine): string {
  if (line.subtype === "incident") return `incident:${notificationParams(n).rule}`;
  if (line.subtype && line.actor && n.page_id && line.subtype !== "assignment" && line.subtype !== "approval")
    return `${line.subtype}:${line.actor.id || line.actor.name}:${n.page_id}`;
  return n.id;
}

export function categoryLabel(category: NotificationCategory, t: T): string {
  switch (category) {
    case "mention":
      return t("Erwähnungen", "Mentions");
    case "comment":
      return t("Kommentare", "Comments");
    case "task":
      return t("Aufgaben", "Tasks");
    case "share":
      return t("Freigaben", "Shares and approvals");
    case "security":
      return t("Sicherheit", "Security");
    default:
      return t("System", "System");
  }
}
