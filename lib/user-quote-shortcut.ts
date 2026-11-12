// The person's "`>` erzeugt" (#230, lib/quote-shortcut-pref.ts), kept in
// users.quote_shortcut (NULL: never chosen, the default – a toggle – applies).
import { one, run } from "./db";
import { quoteShortcutOf, quoteShortcutSchema } from "./quote-shortcut-pref";
import type { Identity } from "./types";

export async function userQuoteShortcut(userId: string) {
  return quoteShortcutOf((await one<{ quote_shortcut: string | null }>("SELECT quote_shortcut FROM users WHERE id=?", userId))?.quote_shortcut);
}
export async function setUserQuoteShortcut(user: Identity, input: unknown) {
  const quoteShortcut = quoteShortcutSchema.parse(input);
  await run("UPDATE users SET quote_shortcut=? WHERE id=?", quoteShortcut, user.id);
  return { quoteShortcut };
}
