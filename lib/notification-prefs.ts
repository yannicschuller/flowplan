import { z } from "zod";
import { all, run } from "./db";
import type { Identity } from "./types";
import {
  notificationDefaults,
  notificationKinds,
  type NotificationKind,
  type NotificationPrefs,
} from "./notification-kinds";
export { notificationKinds, type NotificationKind, type NotificationPrefs };

const kindIds = Object.keys(notificationKinds) as [
  NotificationKind,
  ...NotificationKind[],
];

// Unset kinds follow notificationDefaults.
export function notificationPrefs(user: Identity): NotificationPrefs {
  const stored = new Map(
    all<{ kind: string; inbox: number; push: number; email: number; messenger: number | null }>(
      "SELECT kind,inbox,push,email,messenger FROM notification_prefs WHERE user_id=?",
      user.id,
    ).map((p) => [p.kind, p]),
  );
  return Object.fromEntries(
    kindIds.map((kind) => {
      const p = stored.get(kind);
      return [
        kind,
        {
          inbox: p ? !!p.inbox : notificationDefaults[kind].inbox,
          push: p ? !!p.push : notificationDefaults[kind].push,
          email: p ? !!p.email : notificationDefaults[kind].email,
          // NULL: saved before the chat apps existed – the default applies.
          messenger: p && p.messenger !== null ? !!p.messenger : notificationDefaults[kind].messenger,
        },
      ];
    }),
  ) as NotificationPrefs;
}
export function setNotificationPref(user: Identity, input: unknown) {
  const b = z
    .object({
      kind: z.enum(kindIds),
      inbox: z.boolean(),
      push: z.boolean(),
      email: z.boolean().optional(),
      messenger: z.boolean().optional(),
    })
    .parse(input);
  const current = notificationPrefs(user)[b.kind];
  const email = b.email ?? current.email;
  const messenger = b.messenger ?? current.messenger;
  // Push is only sent for notifications that reach the inbox.
  run(
    `INSERT INTO notification_prefs(user_id,kind,inbox,push,email,messenger) VALUES(?,?,?,?,?,?)
     ON CONFLICT(user_id,kind) DO UPDATE SET inbox=excluded.inbox,push=excluded.push,email=excluded.email,messenger=excluded.messenger`,
    user.id,
    b.kind,
    b.inbox ? 1 : 0,
    b.inbox && b.push ? 1 : 0,
    // The e-mail summary is made of inbox notifications.
    b.inbox && email ? 1 : 0,
    // So are the messages to chat apps (lib/messengers.ts).
    b.inbox && messenger ? 1 : 0,
  );
  return notificationPrefs(user);
}

// Back to the defaults for every kind.
export function resetNotificationPrefs(user: Identity) {
  run("DELETE FROM notification_prefs WHERE user_id=?", user.id);
  return notificationPrefs(user);
}

// E-mail summaries on (as by default: what concerns the person directly)
// or off for every kind at once (the introduction).
export function setEmailForAll(user: Identity, input: unknown) {
  const on = z.boolean().parse(input);
  const prefs = notificationPrefs(user);
  for (const kind of kindIds)
    run(
      `INSERT INTO notification_prefs(user_id,kind,inbox,push,email) VALUES(?,?,?,?,?)
       ON CONFLICT(user_id,kind) DO UPDATE SET email=excluded.email`,
      user.id,
      kind,
      prefs[kind].inbox ? 1 : 0,
      prefs[kind].push ? 1 : 0,
      on && notificationDefaults[kind].email && prefs[kind].inbox ? 1 : 0,
    );
  return notificationPrefs(user);
}
