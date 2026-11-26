// Kinds of notifications people can switch per channel (client-safe).
export const notificationKinds = {
  mention: "Erwähnungen",
  share: "Mit dir geteilte Seiten",
  comment: "Kommentare und Antworten",
  reminder: "Datums-Erinnerungen",
  guest: "Gastkommentare und Gasteinträge",
  change: "Änderungen an Seiten, denen du folgst",
  automation: "Automationen in Datenbanken",
  // Workflows (#168): what a workflow sends (notify.person), and its own
  // errors, pauses and approvals – muted separately (docs/specs/workflows.md §6.4).
  workflow: "Nachrichten von Workflows",
  workflow_ops: "Fehler, Pausen und Freigaben von Workflows",
  security: "Sicherheitshinweise zu deinem Konto und deinen Seiten",
  // Incidents of the detection rules (lib/security-detect.ts): only for
  // administrators, see adminOnlyKinds.
  incident: "Sicherheitsvorfälle der Instanz",
  // The daily reminder to study flashcards (lib/study-reminders.ts): push
  // only by default – it is no news to keep in the inbox.
  study: "Lernerinnerungen",
  // The instance's AI quota (#382, lib/ai/quota.ts): the warning and the
  // ceiling reached – only for administrators.
  ai_quota: "KI-Kontingent der Instanz",
  // The weekly summary of new and returning server errors (lib/error-digest.ts):
  // only for administrators, in the inbox by default.
  error_digest: "Wöchentliche Fehlerübersicht",
} as const;
export type NotificationKind = keyof typeof notificationKinds;
// Kinds only administrators get and see in the settings.
export const adminOnlyKinds: readonly NotificationKind[] = ["incident", "ai_quota", "error_digest"];
// Kinds whose other channels do not hang on the inbox: a study reminder is
// pushed without being kept in the inbox (notifications.push_only,
// lib/study-reminders.ts). For every other kind push, e-mail and chat apps
// carry what the inbox holds.
export const inboxFreeKinds: readonly NotificationKind[] = ["study"];
export const kindsFor = (admin: boolean) =>
  (Object.keys(notificationKinds) as NotificationKind[]).filter((kind) => admin || !adminOnlyKinds.includes(kind));
// What applies until a person changes it: what concerns them directly
// arrives everywhere; changes on followed pages and automations only in the
// inbox, so small edits do not become push messages or e-mails. The chat
// apps (Telegram, Gotify, ntfy, Matrix – lib/messengers.ts) only matter once
// a person connected one; then what concerns them directly arrives there
// too, guest activity, changes and automations not.
export type NotificationChannel = "inbox" | "push" | "email" | "messenger";
export type NotificationChannels = Record<NotificationChannel, boolean>;
export const notificationDefaults: Record<NotificationKind, NotificationChannels> = {
  mention: { inbox: true, push: true, email: true, messenger: true },
  share: { inbox: true, push: true, email: true, messenger: true },
  comment: { inbox: true, push: true, email: true, messenger: true },
  reminder: { inbox: true, push: true, email: true, messenger: true },
  guest: { inbox: true, push: true, email: false, messenger: false },
  change: { inbox: true, push: false, email: false, messenger: false },
  automation: { inbox: true, push: false, email: false, messenger: false },
  workflow: { inbox: true, push: true, email: true, messenger: true },
  workflow_ops: { inbox: true, push: true, email: true, messenger: true },
  security: { inbox: true, push: true, email: true, messenger: true },
  incident: { inbox: true, push: true, email: true, messenger: true },
  study: { inbox: false, push: true, email: false, messenger: false },
  ai_quota: { inbox: true, push: true, email: true, messenger: false },
  error_digest: { inbox: true, push: false, email: false, messenger: false },
};// SQL for "this channel is on for this person and kind": their own setting,
// else the default (table notification_defaults, filled from the map above).
// The chat-app column of a person's row may be NULL (rows saved before it
// existed): then the default applies.
export function notificationOn(channel: NotificationChannel, user: string, kind: string) {
  return `COALESCE((SELECT np.${channel} FROM notification_prefs np WHERE np.user_id=${user} AND np.kind=${kind}),(SELECT nd.${channel} FROM notification_defaults nd WHERE nd.kind=${kind}),1)=1`;
}
export type NotificationPrefs = Record<NotificationKind, NotificationChannels>;

// From which severity an administrator hears about incidents of the
// instance (notification_prefs.min_severity of their "incident" row; none =
// all). The rules (lib/security-kinds.ts securityRules) only know "warn" and
// "critical" today, so the settings offer "all" and "critical"; "warn" stays
// valid for when rules with "info" exist.
export const incidentThresholds = ["all", "warn", "critical"] as const;
export type IncidentThreshold = (typeof incidentThresholds)[number];
const severityRank = { info: 0, warn: 1, critical: 2 } as const;
export function incidentPasses(threshold: IncidentThreshold, severity: string) {
  if (threshold === "all") return true;
  return (severityRank[severity as keyof typeof severityRank] ?? 2) >= severityRank[threshold];
}

// What a notification is within its kind (notifications.subtype): the
// inbox builds its line from it and notifications.params in the reader's
// language (lib/notification-display.ts). Rows without one (older ones, and
// kinds that only have a text) show their `body`.
export const notificationSubtypes = [
  "mention", // in a page
  "record_mention", // in a record's text
  "comment_mention", // in a comment
  "comment", // a page or record comment
  "comment_text", // a comment on a passage of text
  "comment_reply", // an answer in a passage's thread
  "assignment", // a task given in a page
  "task_due", // a task due today
  "share", // a page shared with you
  "workspace_added", // added to a workspace
  "date_reminder", // a date property's reminder
  "approval", // a workflow asks for approval
  "incident", // a security incident of the instance
  "change", // a followed page changed
] as const;
export type NotificationSubtype = (typeof notificationSubtypes)[number];
export const isNotificationSubtype = (value: unknown): value is NotificationSubtype =>
  typeof value === "string" && (notificationSubtypes as readonly string[]).includes(value);

// The groups of the inbox: what concerns you most first.
export const notificationCategories = ["share", "task", "mention", "comment", "security", "system"] as const;
export type NotificationCategory = (typeof notificationCategories)[number];
export function notificationCategory(kind: string | null | undefined, subtype?: string | null): NotificationCategory {
  if (subtype === "assignment" || subtype === "task_due") return "task";
  if (subtype === "approval") return "share";
  switch (kind) {
    case "mention":
      return "mention";
    case "comment":
    case "guest":
      return "comment";
    case "reminder":
      return "task";
    case "share":
      return "share";
    case "security":
    case "incident":
      return "security";
    default:
      return "system";
  }
}
