// The person's "Symbol bei externen Links" (#217,
// lib/external-link-icon-pref.ts), kept in users.external_link_icon (NULL:
// never chosen, the default – on – applies).
import { one, run } from "./db";
import { externalLinkIconOf, externalLinkIconSchema } from "./external-link-icon-pref";
import type { Identity } from "./types";

export async function userExternalLinkIcon(userId: string) {
  return externalLinkIconOf((await one<{ external_link_icon: number | null }>("SELECT external_link_icon FROM users WHERE id=?", userId))?.external_link_icon);
}
export async function setUserExternalLinkIcon(user: Identity, input: unknown) {
  const externalLinkIcon = externalLinkIconSchema.parse(input);
  await run("UPDATE users SET external_link_icon=? WHERE id=?", externalLinkIcon ? 1 : 0, user.id);
  return { externalLinkIcon };
}
