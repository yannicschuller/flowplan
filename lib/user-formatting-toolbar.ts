// The person's "Formatierungsleiste" (#235, lib/toolbar-pref.ts), kept in
// users.formatting_toolbar (NULL: never chosen, the default – shown – applies).
import { one, run } from "./db";
import { formattingToolbarOf, formattingToolbarSchema } from "./toolbar-pref";
import type { Identity } from "./types";

export async function userFormattingToolbar(userId: string) {
  return formattingToolbarOf(
    (await one<{ formatting_toolbar: string | null }>("SELECT formatting_toolbar FROM users WHERE id=?", userId))?.formatting_toolbar,
  );
}
export async function setUserFormattingToolbar(user: Identity, input: unknown) {
  const formattingToolbar = formattingToolbarSchema.parse(input);
  await run("UPDATE users SET formatting_toolbar=? WHERE id=?", formattingToolbar, user.id);
  return { formattingToolbar };
}
