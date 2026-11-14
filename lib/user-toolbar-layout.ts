// The person's "Formatierungsleiste anpassen" (#292, lib/toolbar-layout.ts),
// kept in users.toolbar_layout as JSON (NULL: never chosen or reset, the
// default applies).
import { one, run } from "./db";
import { isDefaultToolbarLayout, toolbarLayoutOf, toolbarLayoutSchema } from "./toolbar-layout";
import type { Identity } from "./types";

export async function userToolbarLayout(userId: string) {
  return toolbarLayoutOf((await one<{ toolbar_layout: string | null }>("SELECT toolbar_layout FROM users WHERE id=?", userId))?.toolbar_layout);
}
// Validated strictly (only known buttons, each once, bounded); the default
// layout is stored as NULL, so later defaults reach it.
export async function setUserToolbarLayout(user: Identity, input: unknown) {
  const parsed = toolbarLayoutSchema.parse(input);
  const layout = toolbarLayoutOf(parsed);
  const stored = parsed && !isDefaultToolbarLayout(layout) ? JSON.stringify(layout) : null;
  await run("UPDATE users SET toolbar_layout=? WHERE id=?", stored, user.id);
  return { toolbarLayout: layout };
}
