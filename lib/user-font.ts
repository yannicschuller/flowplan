// The person's "Schriftart" (#512, lib/personal-font.ts), kept in
// users.ui_font (NULL: never chosen or "Standard" – the workspace's
// interface font or Flowplan's own applies).
import { one, run } from "./db";
import { personalFontOf, personalFontSchema } from "./personal-font";
import type { Identity } from "./types";

export async function userFont(userId: string) {
  return personalFontOf((await one<{ ui_font: string | null }>("SELECT ui_font FROM users WHERE id=?", userId))?.ui_font);
}
export async function setUserFont(user: Identity, input: unknown) {
  const font = personalFontSchema.parse(input);
  await run("UPDATE users SET ui_font=? WHERE id=?", font, user.id);
  return { font };
}
