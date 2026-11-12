// "Symbol bei externen Links" (#217, lib/external-link-icon-pref.ts,
// lib/user-external-link-icon.ts): the arrow after links to the web, on by
// default. The choice is saved per person on the server, validated and comes
// with the bootstrap.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-link-icon-"));
const { run, id, one } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");
const { commandActionNames } = await import("../lib/openapi");
const pref = { ...(await import("../lib/external-link-icon-pref")), ...(await import("../lib/external-link-icon-pref-client")) };

async function account(name: string) {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const rejects = async (fn: () => Promise<unknown>, status: number) =>
  await assert.rejects(fn, (e: unknown) => (e as { status?: number }).status === status || (status === 400 && (e as Error).name === "ZodError"));

test("stored values are read leniently: only an explicit off hides the arrow", () => {
  assert.equal(pref.DEFAULT_EXTERNAL_LINK_ICON, true);
  for (const value of [0, false, "0"]) assert.equal(pref.externalLinkIconOf(value), false, String(value));
  for (const value of [1, true, null, undefined, "", "off", 2, {}]) assert.equal(pref.externalLinkIconOf(value), true, String(value));
});

test("the browser's copy changes with the bootstrap and tells its listeners", () => {
  assert.equal(pref.externalLinkIcon(), true);
  pref.setExternalLinkIconLocal(false);
  assert.equal(pref.externalLinkIcon(), false);
  pref.setExternalLinkIconLocal(undefined);
  assert.equal(pref.externalLinkIcon(), true, "a bootstrap without the field means the default");
});

test("the command is documented for the API and the SDKs", () => {
  assert.ok(commandActionNames.includes("profile.externalLinkIcon"));
});

test("the stylesheet hides the arrow only on screen and only with the class", () => {
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  const rule = css.indexOf(`html.${pref.HIDE_EXTERNAL_LINK_ICON_CLASS}`);
  assert.ok(rule > 0, "a rule for the class");
  assert.match(css.slice(css.lastIndexOf("@media", rule), rule), /@media screen \{\s*$/);
});

test("each person saves their choice; it comes with the bootstrap on every device and is validated", async () => {
  const anna = await account("link-icon-anna"),
    ben = await account("link-icon-ben");
  const wid = await createWorkspace(anna.id, "Links");
  await run("INSERT INTO members VALUES(?,?,?)", wid, ben.id, "editor");
  assert.equal((await bootstrap(anna, wid)).externalLinkIcon, true, "never chosen: the default");
  assert.equal((await one<{ external_link_icon: number | null }>("SELECT external_link_icon FROM users WHERE id=?", anna.id))?.external_link_icon, null);

  assert.deepEqual(await command(anna, { action: "profile.externalLinkIcon", externalLinkIcon: false }), { externalLinkIcon: false });
  assert.equal((await bootstrap(anna, wid)).externalLinkIcon, false);
  assert.equal((await bootstrap(ben, wid)).externalLinkIcon, true, "only for that person");

  assert.deepEqual(await command(anna, { action: "profile.externalLinkIcon", externalLinkIcon: true }), { externalLinkIcon: true });
  assert.equal((await bootstrap(anna, wid)).externalLinkIcon, true);
  await command(anna, { action: "profile.externalLinkIcon", externalLinkIcon: false });

  for (const bad of ["off", "", null, 0, 1, undefined, { value: false }])
    await rejects(() => command(anna, { action: "profile.externalLinkIcon", externalLinkIcon: bad }), 400);
  assert.equal((await bootstrap(anna, wid)).externalLinkIcon, false, "a rejected value changes nothing");

  // A value written outside Flowplan reads as the default.
  await run("UPDATE users SET external_link_icon=? WHERE id=?", 7, ben.id);
  assert.equal((await bootstrap(ben, wid)).externalLinkIcon, true);
});
