// The person's "Menü bei Textauswahl" (#200, lib/text-menu-pref.ts), kept in
// users.text_menu (NULL: never chosen, the default applies).
import { one, run } from "./db";
import { textMenuPrefOf, textMenuPrefSchema } from "./text-menu-pref";
import type { Identity } from "./types";

export async function userTextMenu(userId: string) {
  return textMenuPrefOf((await one<{ text_menu: string | null }>("SELECT text_menu FROM users WHERE id=?", userId))?.text_menu);
}
export async function setUserTextMenu(user: Identity, input: unknown) {
  const textMenu = textMenuPrefSchema.parse(input);
  await run("UPDATE users SET text_menu=? WHERE id=?", textMenu, user.id);
  return { textMenu };
}
