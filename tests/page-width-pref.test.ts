// "Seiten in voller Breite anzeigen" (#257, lib/page-width-pref.ts,
// lib/user-page-width.ts): every page at full width for one person, saved
// on the server, validated and delivered with the bootstrap; the pages'
// own "Volle Breite" stays as stored.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-page-width-"));
const { run, id, one } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");
const pref = { ...(await import("../lib/page-width-pref")), ...(await import("../lib/page-width-pref-client")) };
const { commandActions } = await import("../lib/openapi");

async function account(name: string) {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const rejects = async (fn: () => Promise<unknown>) =>
  await assert.rejects(fn, (e: unknown) => (e as { status?: number }).status === 400 || (e as Error).name === "ZodError");

test("off by default; only an explicit on counts; the page's own switch still applies", () => {
  assert.equal(pref.DEFAULT_FULL_WIDTH_PAGES, false);
  for (const value of [null, undefined, 0, "0", false, "", "true", 2]) assert.equal(pref.fullWidthPagesOf(value), false, String(value));
  for (const value of [1, "1", true]) assert.equal(pref.fullWidthPagesOf(value), true, String(value));
  assert.equal(pref.showsFullWidth(0, false), false);
  assert.equal(pref.showsFullWidth(1, false), true, "the page's switch");
  assert.equal(pref.showsFullWidth(0, true), true, "the person's setting");
  assert.equal(pref.showsFullWidth(1, true), true);
});

test("the browser's copy changes with the bootstrap", () => {
  assert.equal(pref.fullWidthPages(), false);
  pref.setFullWidthPagesLocal(true);
  assert.equal(pref.fullWidthPages(), true);
  pref.setFullWidthPagesLocal(undefined);
  assert.equal(pref.fullWidthPages(), false, "a bootstrap without the field means the default");
});

test("each person saves the choice; pages stay as stored; values are validated", async () => {
  const anna = await account("wide-anna"),
    ben = await account("wide-ben");
  const wid = await createWorkspace(anna.id, "Breite");
  await run("INSERT INTO members VALUES(?,?,?)", wid, ben.id, "editor");
  const boot = await bootstrap(anna, wid);
  assert.equal(boot.fullWidthPages, false, "never chosen: the default");
  assert.equal((await one<{ full_width_pages: number | null }>("SELECT full_width_pages FROM users WHERE id=?", anna.id))?.full_width_pages, null);
  const page = (await command(anna, { action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, title: "Notizen", kind: "document" })) as { id: string };
  assert.deepEqual(await command(anna, { action: "profile.fullWidthPages", fullWidthPages: true }), { fullWidthPages: true });
  assert.equal((await bootstrap(anna, wid)).fullWidthPages, true);
  assert.equal((await bootstrap(ben, wid)).fullWidthPages, false, "only for that person");
  assert.equal((await one<{ full_width: number }>("SELECT full_width FROM pages WHERE id=?", page.id))?.full_width, 0, "the page itself is unchanged");
  for (const bad of ["yes", 1, 0, null, undefined, "true", { on: true }])
    await rejects(() => command(anna, { action: "profile.fullWidthPages", fullWidthPages: bad }));
  assert.equal((await bootstrap(anna, wid)).fullWidthPages, true, "a rejected value changes nothing");
  await command(anna, { action: "profile.fullWidthPages", fullWidthPages: false });
  assert.equal((await bootstrap(anna, wid)).fullWidthPages, false);
  assert.equal((await one<{ full_width_pages: number }>("SELECT full_width_pages FROM users WHERE id=?", anna.id))?.full_width_pages, 0);
});

test("the command is documented in the API", () => {
  const doc = commandActions.find((a) => a.action === "profile.fullWidthPages");
  assert.ok(doc);
  assert.equal(doc!.input.safeParse({ action: "profile.fullWidthPages", fullWidthPages: true }).success, true);
  assert.equal(doc!.input.safeParse({ action: "profile.fullWidthPages", fullWidthPages: "on" }).success, false);
});
