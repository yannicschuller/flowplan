// Kinds of notifications people can switch per channel (client-safe).
export const notificationKinds = {
  mention: "Erwähnungen",
  comment: "Kommentare und Antworten",
  reminder: "Datums-Erinnerungen",
  guest: "Gastkommentare und Gasteinträge",
  change: "Änderungen an Seiten, denen du folgst",
  automation: "Automationen in Datenbanken",
} as const;
export type NotificationKind = keyof typeof notificationKinds;
export type NotificationPrefs = Record<
  NotificationKind,
  { inbox: boolean; push: boolean; email: boolean }
>;
