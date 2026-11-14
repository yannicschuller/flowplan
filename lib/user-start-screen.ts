// The person's "Beim Öffnen auf dem Handy" (lib/start-screen.ts), kept in
// users.start_screen (NULL: never chosen, the default – the app – applies).
import { one, run } from "./db";
import { startScreenOf, startScreenSchema } from "./start-screen";
import type { Identity } from "./types";

export async function userStartScreen(userId: string) {
  return startScreenOf((await one<{ start_screen: string | null }>("SELECT start_screen FROM users WHERE id=?", userId))?.start_screen);
}
export async function setUserStartScreen(user: Identity, input: unknown) {
  const startScreen = startScreenSchema.parse(input);
  await run("UPDATE users SET start_screen=? WHERE id=?", startScreen, user.id);
  return { startScreen };
}
