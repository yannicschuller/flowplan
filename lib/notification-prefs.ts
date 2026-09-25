import { z } from "zod";
import { all, run } from "./db";
import type { Identity } from "./types";
import {
  notificationKinds,
  type NotificationKind,
  type NotificationPrefs,
} from "./notification-kinds";
export { notificationKinds, type NotificationKind, type NotificationPrefs };

const kindIds = Object.keys(notificationKinds) as [
  NotificationKind,
  ...NotificationKind[],
];

// Unset kinds are on for both channels.
export function notificationPrefs(user: Identity): NotificationPrefs {
  const stored = new Map(
    all<{ kind: string; inbox: number; push: number }>(
      "SELECT kind,inbox,push FROM notification_prefs WHERE user_id=?",
      user.id,
    ).map((p) => [p.kind, p]),
  );
  return Object.fromEntries(
    kindIds.map((kind) => {
      const p = stored.get(kind);
      return [kind, { inbox: p ? !!p.inbox : true, push: p ? !!p.push : true }];
    }),
  ) as NotificationPrefs;
}
export function setNotificationPref(user: Identity, input: unknown) {
  const b = z
    .object({
      kind: z.enum(kindIds),
      inbox: z.boolean(),
      push: z.boolean(),
    })
    .parse(input);
  // Push is only sent for notifications that reach the inbox.
  run(
    `INSERT INTO notification_prefs(user_id,kind,inbox,push) VALUES(?,?,?,?)
     ON CONFLICT(user_id,kind) DO UPDATE SET inbox=excluded.inbox,push=excluded.push`,
    user.id,
    b.kind,
    b.inbox ? 1 : 0,
    b.inbox && b.push ? 1 : 0,
  );
  return notificationPrefs(user);
}
