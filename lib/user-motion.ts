// The person's "Animationen" (#260, lib/motion-pref.ts), kept in users.motion
// (NULL: never chosen, the default – normal – applies).
import { one, run } from "./db";
import { motionPrefOf, motionPrefSchema } from "./motion-pref";
import type { Identity } from "./types";

export async function userMotion(userId: string) {
  return motionPrefOf((await one<{ motion: string | null }>("SELECT motion FROM users WHERE id=?", userId))?.motion);
}
export async function setUserMotion(user: Identity, input: unknown) {
  const motion = motionPrefSchema.parse(input);
  await run("UPDATE users SET motion=? WHERE id=?", motion, user.id);
  return { motion };
}
