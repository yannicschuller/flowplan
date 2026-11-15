// The person's "Formatierungsleiste anpassen" (#292, lib/toolbar-layout.ts),
// kept in users.toolbar_layout as JSON (NULL: never chosen or reset, the
// instance's default applies – toolbarLayoutDefault in
// lib/instance-settings.ts, else the built-in one).
import { one, run } from "./db";
import { instanceSettings } from "./instance-settings";
import { defaultToolbarLayout, parsedToolbarLayout, sameToolbarLayout, toolbarLayoutOf, toolbarLayoutSchema, type ToolbarLayout } from "./toolbar-layout";
import type { Identity } from "./types";

// The instance's default: what applies to everyone without a layout of
// their own.
export async function instanceToolbarLayout(): Promise<ToolbarLayout> {
  return (await instanceSettings()).toolbarLayoutDefault ?? defaultToolbarLayout();
}
// What applies to the person, the default it would be without their own
// layout, and whether they have one (the settings say "Angepasst").
export async function userToolbarLayoutState(userId: string): Promise<{ layout: ToolbarLayout; standard: ToolbarLayout; custom: boolean }> {
  const standard = await instanceToolbarLayout();
  const stored = (await one<{ toolbar_layout: string | null }>("SELECT toolbar_layout FROM users WHERE id=?", userId))?.toolbar_layout;
  // A broken value reads as none.
  const own = stored ? parsedToolbarLayout(stored) : null;
  return own ? { layout: own, standard, custom: true } : { layout: standard, standard, custom: false };
}
// Validated strictly (only known buttons, each once, bounded); a layout
// that is the instance's default is stored as NULL, so later changes of
// that default reach it.
export async function setUserToolbarLayout(user: Identity, input: unknown) {
  const parsed = toolbarLayoutSchema.parse(input);
  const standard = await instanceToolbarLayout();
  const layout = toolbarLayoutOf(parsed, standard);
  const custom = !!parsed && !sameToolbarLayout(layout, standard);
  await run("UPDATE users SET toolbar_layout=? WHERE id=?", custom ? JSON.stringify(layout) : null, user.id);
  return { toolbarLayout: layout, custom };
}
