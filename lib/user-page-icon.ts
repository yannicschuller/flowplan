// The person's "Seitensymbol" (#214, lib/page-icon-pref.ts), kept in
// users.page_icon (NULL: never chosen, the default applies).
import { one, run } from "./db";
import { pageIconPrefOf, pageIconPrefSchema } from "./page-icon-pref";
import type { Identity } from "./types";

export async function userPageIcon(userId: string) {
  return pageIconPrefOf((await one<{ page_icon: string | null }>("SELECT page_icon FROM users WHERE id=?", userId))?.page_icon);
}
export async function setUserPageIcon(user: Identity, input: unknown) {
  const pageIcon = pageIconPrefSchema.parse(input);
  await run("UPDATE users SET page_icon=? WHERE id=?", pageIcon, user.id);
  return { pageIcon };
}
