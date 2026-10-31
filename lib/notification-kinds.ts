// Kinds of notifications people can switch per channel (client-safe).
export const notificationKinds = {
  mention: "Erwähnungen",
  share: "Mit dir geteilte Seiten",
  comment: "Kommentare und Antworten",
  reminder: "Datums-Erinnerungen",
  guest: "Gastkommentare und Gasteinträge",
  change: "Änderungen an Seiten, denen du folgst",
  automation: "Automationen in Datenbanken",
  security: "Sicherheitshinweise zu deinem Konto und deinen Seiten",
} as const;
export type NotificationKind = keyof typeof notificationKinds;
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
  security: { inbox: true, push: true, email: true, messenger: true },
};
// SQL for "this channel is on for this person and kind": their own setting,
// else the default (table notification_defaults, filled from the map above).
// The chat-app column of a person's row may be NULL (rows saved before it
// existed): then the default applies.
export function notificationOn(channel: NotificationChannel, user: string, kind: string) {
  return `COALESCE((SELECT np.${channel} FROM notification_prefs np WHERE np.user_id=${user} AND np.kind=${kind}),(SELECT nd.${channel} FROM notification_defaults nd WHERE nd.kind=${kind}),1)=1`;
}
export type NotificationPrefs = Record<NotificationKind, NotificationChannels>;
