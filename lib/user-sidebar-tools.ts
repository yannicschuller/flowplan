// The person's "Symbole unten in der Seitenleiste" (#589,
// lib/sidebar-tools-pref.ts), kept in users.sidebar_tools as JSON (NULL:
// never chosen or every symbol shown again).
import { one, run } from "./db";
import { hiddenSidebarToolsOf, hiddenSidebarToolsSchema } from "./sidebar-tools-pref";
import type { Identity } from "./types";

export async function userHiddenSidebarTools(userId: string) {
  return hiddenSidebarToolsOf((await one<{ sidebar_tools: string | null }>("SELECT sidebar_tools FROM users WHERE id=?", userId))?.sidebar_tools);
}
export async function setUserHiddenSidebarTools(user: Identity, input: unknown) {
  const hidden = hiddenSidebarToolsOf(hiddenSidebarToolsSchema.parse(input));
  await run("UPDATE users SET sidebar_tools=? WHERE id=?", hidden.length ? JSON.stringify(hidden) : null, user.id);
  return { hidden };
}
