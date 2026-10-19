// Kinds of notifications people can switch per channel (client-safe).
export const notificationKinds = {
  mention: "Erwähnungen",
  share: "Mit dir geteilte Seiten",
  comment: "Kommentare und Antworten",
  reminder: "Datums-Erinnerungen",
  guest: "Gastkommentare und Gasteinträge",
  change: "Änderungen an Seiten, denen du folgst",
  automation: "Automationen in Datenbanken",
} as const;
export type NotificationKind = keyof typeof notificationKinds;
// What applies until a person changes it: what concerns them directly
// arrives everywhere; changes on followed pages and automations only in the
// inbox, so small edits do not become push messages or e-mails.
export const notificationDefaults: Record<NotificationKind, { inbox: boolean; push: boolean; email: boolean }> = {
  mention: { inbox: true, push: true, email: true },
  share: { inbox: true, push: true, email: true },
  comment: { inbox: true, push: true, email: true },
  reminder: { inbox: true, push: true, email: true },
  guest: { inbox: true, push: true, email: false },
  change: { inbox: true, push: false, email: false },
  automation: { inbox: true, push: false, email: false },
};
// SQL for "this channel is on for this person and kind": their own setting,
// else the default (table notification_defaults, filled from the map above).
export function notificationOn(channel: "inbox" | "push" | "email", user: string, kind: string) {
  return `COALESCE((SELECT np.${channel} FROM notification_prefs np WHERE np.user_id=${user} AND np.kind=${kind}),(SELECT nd.${channel} FROM notification_defaults nd WHERE nd.kind=${kind}),1)=1`;
}
export type NotificationPrefs = Record<
  NotificationKind,
  { inbox: boolean; push: boolean; email: boolean }
>;
