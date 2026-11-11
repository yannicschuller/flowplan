// "Seitensymbol" (#214, lib/page-icon-pref.ts, lib/user-page-icon.ts): the
// page icon above the title (default) or small next to it. The choice is
// saved per person on the server, validated, comes with the bootstrap and
// leaves the pages themselves alone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-page-icon-"));
const { run, id, one } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");
const { commandActionNames } = await import("../lib/openapi");
const pref = { ...(await import("../lib/page-icon-pref")), ...(await import("../lib/page-icon-pref-client")) };

async function account(name: string) {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const rejects = async (fn: () => Promise<unknown>, status: number) =>
  await assert.rejects(fn, (e: unknown) => (e as { status?: number }).status === status || (status === 400 && (e as Error).name === "ZodError"));

test("stored values are read leniently: unknown or missing is the default, above the title", () => {
  assert.equal(pref.DEFAULT_PAGE_ICON_PREF, "above");
  assert.equal(pref.pageIconPrefOf("inline"), "inline");
  assert.equal(pref.pageIconPrefOf("above"), "above");
  for (const value of [null, undefined, "", "left", "INLINE", 1, true]) assert.equal(pref.pageIconPrefOf(value), "above", String(value));
});

test("the browser's copy changes with the bootstrap and tells its listeners", () => {
  assert.equal(pref.pageIconPref(), "above");
  pref.setPageIconPrefLocal("inline");
  assert.equal(pref.pageIconPref(), "inline");
  pref.setPageIconPrefLocal(undefined);
  assert.equal(pref.pageIconPref(), "above", "a bootstrap without the field means the default");
});

test("the command is documented for the API and the SDKs", () => {
  assert.ok(commandActionNames.includes("profile.pageIcon"));
});

test("each person saves their choice; it comes with the bootstrap on every device, is validated and leaves the page alone", async () => {
  const anna = await account("page-icon-anna"),
    ben = await account("page-icon-ben");
  const wid = await createWorkspace(anna.id, "Symbole");
  await run("INSERT INTO members VALUES(?,?,?)", wid, ben.id, "editor");
  assert.equal((await bootstrap(anna, wid)).pageIcon, "above", "never chosen: the default");
  assert.equal((await one<{ page_icon: string | null }>("SELECT page_icon FROM users WHERE id=?", anna.id))?.page_icon, null);

  const page = await one<{ id: string; title: string; icon: string }>("SELECT id,title,icon FROM pages WHERE workspace_id=? AND deleted_at IS NULL ORDER BY id LIMIT 1", wid);
  assert.ok(page);

  assert.deepEqual(await command(anna, { action: "profile.pageIcon", pageIcon: "inline" }), { pageIcon: "inline" });
  assert.equal((await bootstrap(anna, wid)).pageIcon, "inline");
  assert.equal((await bootstrap(ben, wid)).pageIcon, "above", "only for that person");
  // The page's title and icon stay as they are – nothing is put into the title.
  assert.deepEqual(await one("SELECT id,title,icon FROM pages WHERE id=?", page.id), page);

  assert.deepEqual(await command(anna, { action: "profile.pageIcon", pageIcon: "above" }), { pageIcon: "above" });
  assert.equal((await bootstrap(anna, wid)).pageIcon, "above");
  await command(anna, { action: "profile.pageIcon", pageIcon: "inline" });

  for (const bad of ["left", "", null, true, 2, undefined, { value: "inline" }])
    await rejects(() => command(anna, { action: "profile.pageIcon", pageIcon: bad }), 400);
  assert.equal((await bootstrap(anna, wid)).pageIcon, "inline", "a rejected value changes nothing");

  // A value written outside Flowplan reads as the default.
  await run("UPDATE users SET page_icon=? WHERE id=?", "bogus", ben.id);
  assert.equal((await bootstrap(ben, wid)).pageIcon, "above");
});
