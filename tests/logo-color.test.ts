// "Logo-Farbe" (#591, lib/workspace-theme.ts): the mark at the top of the
// sidebar and in the browser tab follows the accent unless the workspace's
// look gives it a colour of its own – validated like the accent, optional
// (absent: follows the accent, as every look saved before).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-logo-color-"));
const { run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");
const theme = await import("../lib/workspace-theme");

async function account(name: string) {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}

test("without a logo colour the mark follows the accent; with one it takes that colour and the accent stays", () => {
  for (const mode of ["light", "dark"] as const) {
    const follows = theme.themeVariables({ accent: "#0f766e" }, mode);
    assert.equal(follows["--logo-from"], theme.logoColors("#0f766e").from);
    const own = theme.themeVariables({ accent: "#0f766e", logoColor: "#be123c" }, mode);
    const logo = theme.logoColors("#be123c");
    assert.deepEqual([own["--logo-from"], own["--logo-to"], own["--logo-ink"], own["--logo-glow"]], [logo.from, logo.to, logo.ink, `${logo.from}59`]);
    // Everything else still comes from the accent.
    for (const name of ["--blue", "--accent", "--avatar-bg", "--avatar-ink"]) assert.equal(own[name], follows[name], name);
    // A logo colour alone recolours only the mark.
    const only = theme.themeVariables({ logoColor: "#be123c" }, mode);
    assert.equal(only["--logo-from"], logo.from);
    for (const name of ["--blue", "--accent", "--avatar-bg"]) assert.equal(only[name], undefined, name);
  }
  assert.equal(theme.logoColorOf(null), null);
  assert.equal(theme.logoColorOf({ accent: "#0f766e" }), "#0f766e");
  assert.equal(theme.logoColorOf({ accent: "#0f766e", logoColor: null }), "#0f766e");
  assert.equal(theme.logoColorOf({ accent: "#0f766e", logoColor: "#be123c" }), "#be123c");
});

test("the browser tab's icon uses the logo colour as well", () => {
  assert.equal(theme.faviconHref(null), null);
  assert.equal(theme.faviconHref({ background: "sepia" }), null);
  const href = theme.faviconHref({ accent: "#0f766e", logoColor: "#be123c" })!;
  assert.equal(href, `data:image/svg+xml,${encodeURIComponent(theme.logoSvg(theme.logoColors("#be123c")))}`);
  assert.ok(theme.faviconHref({ logoColor: "#be123c" }));
});

test("validated like the accent, optional and backwards compatible", () => {
  assert.equal(theme.workspaceThemeSchema.safeParse({ logoColor: "#BE123C" }).success, true);
  for (const bad of ["red", "#be12", "url(x)", "#be123c; color:red", 12]) assert.equal(theme.workspaceThemeSchema.safeParse({ logoColor: bad }).success, false, String(bad));
  assert.deepEqual(theme.normalizeTheme({ accent: "#0F766E", logoColor: "#BE123C" }), { accent: "#0f766e", logoColor: "#be123c" });
  assert.deepEqual(theme.normalizeTheme({ accent: "#0f766e", logoColor: null }), { accent: "#0f766e" }, "following the accent is stored as nothing");
  // A look saved before #591 reads as before.
  assert.deepEqual(theme.parseTheme('{"accent":"#0f766e"}'), { accent: "#0f766e" });
  const css = theme.themeCss({ theme: { accent: "#0f766e", logoColor: "#be123c" }, fonts: [] }, (x) => x);
  assert.ok(css.includes(`--logo-from:${theme.logoColors("#be123c").from}`));
});

test("owners save it with the look; everyone gets it in the bootstrap", async () => {
  const owner = await account("logo-owner"),
    editor = await account("logo-editor");
  const wid = await createWorkspace(owner.id, "Logo");
  await run("INSERT INTO members VALUES(?,?,?)", wid, editor.id, "editor");
  await assert.rejects(() => command(editor, { action: "workspace.theme", workspaceId: wid, theme: { logoColor: "#be123c" } }));
  await assert.rejects(() => command(owner, { action: "workspace.theme", workspaceId: wid, theme: { logoColor: "pink" } }));
  const saved = (await command(owner, { action: "workspace.theme", workspaceId: wid, theme: { accent: "#0F766E", logoColor: "#BE123C" } })) as import("../lib/workspace-theme").WorkspaceLook;
  assert.deepEqual(saved.theme, { accent: "#0f766e", logoColor: "#be123c" });
  assert.deepEqual((await bootstrap(editor, wid)).look?.theme, saved.theme);
  const back = (await command(owner, { action: "workspace.theme", workspaceId: wid, theme: { accent: "#0f766e", logoColor: null } })) as import("../lib/workspace-theme").WorkspaceLook;
  assert.deepEqual(back.theme, { accent: "#0f766e" });
});
