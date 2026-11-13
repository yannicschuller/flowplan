// The person's "Seiten in voller Breite anzeigen" (#257,
// lib/page-width-pref.ts), kept in users.full_width_pages (NULL: never
// chosen, the default – off – applies).
import { one, run } from "./db";
import { fullWidthPagesOf, fullWidthPagesSchema } from "./page-width-pref";
import type { Identity } from "./types";

export async function userFullWidthPages(userId: string) {
  return fullWidthPagesOf((await one<{ full_width_pages: number | null }>("SELECT full_width_pages FROM users WHERE id=?", userId))?.full_width_pages);
}
export async function setUserFullWidthPages(user: Identity, input: unknown) {
  const fullWidthPages = fullWidthPagesSchema.parse(input);
  await run("UPDATE users SET full_width_pages=? WHERE id=?", fullWidthPages ? 1 : 0, user.id);
  return { fullWidthPages };
}
