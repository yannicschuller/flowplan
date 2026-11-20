// The person's "Ton bei neuen Benachrichtigungen" (#401,
// lib/notification-sound.ts), kept in users.notification_sound (NULL: never
// chosen, the default – "soft" – applies).
import { one, run } from "./db";
import { notificationSoundOf, notificationSoundSchema } from "./notification-sound";
import type { Identity } from "./types";

export async function userNotificationSound(userId: string) {
  return notificationSoundOf((await one<{ notification_sound: string | null }>("SELECT notification_sound FROM users WHERE id=?", userId))?.notification_sound);
}
export async function setUserNotificationSound(user: Identity, input: unknown) {
  const notificationSound = notificationSoundSchema.parse(input);
  await run("UPDATE users SET notification_sound=? WHERE id=?", notificationSound, user.id);
  return { notificationSound };
}
