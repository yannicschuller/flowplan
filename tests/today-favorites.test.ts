// "Heute" favourites of journals (#537, schema 137, lib/today-favorites.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-today-fav-"));
const { one, all, run, id, db, SCHEMA_VERSION } = await import("../lib/db");
const { command, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { commandOverlay } = await import("../lib/optimistic-commands");
const { archiveSchema } = await import("../lib/archive");
const { removeFromWorkspace } = await import("../lib/workspace-lifecycle");

async function user(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}-${uid}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, disabled: 0, created_at: "", groups: [], isAdmin: false };
}
async function fixture() {
  const owner = await user("Owner"),
    viewer = await user("Viewer"),
    stranger = await user("Stranger"),
    wid = await createWorkspace(owner.id, "Today favourites");
  await run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
  const sid = (await one<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=?", wid))!.id;
  const page = async (title: string, kind = "document") =>
    ((await command(owner, { action: "page.create", workspaceId: wid, spaceId: sid, title, kind })) as { id: string }).id;
  return { owner, viewer, stranger, wid, sid, page };
}
const boot = async (u: Identity, wid: string) => (await bootstrap(u, wid)) as unknown as { favorites: string[]; todayFavorites: string[] };

test("schema 137 creates today_favorites with its own primary key", () => {
  assert.equal(SCHEMA_VERSION, 137);
  const columns = (db().prepare("PRAGMA table_info(today_favorites)").all() as { name: string; pk: number }[]);
  assert.deepEqual(columns.map((c) => c.name), ["user_id", "page_id", "created_at"]);
  assert.deepEqual(columns.filter((c) => c.pk).map((c) => c.name), ["user_id", "page_id"]);
  const keys = db().prepare("PRAGMA foreign_key_list(today_favorites)").all() as { table: string; on_delete: string }[];
  assert.deepEqual(keys.map((k) => `${k.table}:${k.on_delete}`).sort(), ["pages:CASCADE", "users:CASCADE"]);
});

test("favorite.today adds and removes a journal's Heute link, separate from the page favourite", async () => {
  const f = await fixture();
  const journal = await f.page("Diary", "journal");
  await command(f.owner, { action: "favorite.today", pageId: journal, value: true });
  let b = await boot(f.owner, f.wid);
  assert.deepEqual(b.todayFavorites, [journal]);
  assert.ok(!b.favorites.includes(journal), "the page favourite stays off");
  // Both at once.
  await command(f.owner, { action: "favorite", pageId: journal, value: true });
  b = await boot(f.owner, f.wid);
  assert.deepEqual(b.todayFavorites, [journal]);
  assert.ok(b.favorites.includes(journal));
  // Twice is once.
  await command(f.owner, { action: "favorite.today", pageId: journal, value: true });
  assert.equal((await all("SELECT 1 FROM today_favorites WHERE user_id=?", f.owner.id)).length, 1);
  // Removing the Heute link keeps the page favourite.
  await command(f.owner, { action: "favorite.today", pageId: journal, value: false });
  b = await boot(f.owner, f.wid);
  assert.deepEqual(b.todayFavorites, []);
  assert.ok(b.favorites.includes(journal));
  // Per person: a viewer may have one too, the owner's list is unaffected.
  await command(f.viewer, { action: "favorite.today", pageId: journal, value: true });
  assert.deepEqual((await boot(f.viewer, f.wid)).todayFavorites, [journal]);
  assert.deepEqual((await boot(f.owner, f.wid)).todayFavorites, []);
});

test("only journals the person may read get a Heute favourite", async () => {
  const f = await fixture();
  const doc = await f.page("Notes");
  const journal = await f.page("Diary", "journal");
  await assert.rejects(() => command(f.owner, { action: "favorite.today", pageId: doc, value: true }), /Journal/);
  await assert.rejects(() => command(f.stranger, { action: "favorite.today", pageId: journal, value: true }));
  await assert.rejects(() => command(f.owner, { action: "favorite.today", pageId: journal, value: "yes" }));
  assert.equal((await all("SELECT 1 FROM today_favorites WHERE page_id IN (?,?)", doc, journal)).length, 0);
});

test("a trashed or purged journal and lost access take the Heute favourite away", async () => {
  const f = await fixture();
  const journal = await f.page("Diary", "journal");
  await command(f.owner, { action: "favorite.today", pageId: journal, value: true });
  await command(f.viewer, { action: "favorite.today", pageId: journal, value: true });
  // Access lost: removed from the workspace, the viewer's goes with them.
  await removeFromWorkspace(f.viewer.id, f.wid);
  assert.equal((await all("SELECT 1 FROM today_favorites WHERE user_id=?", f.viewer.id)).length, 0);
  await command(f.owner, { action: "page.delete", pageId: journal });
  assert.deepEqual((await boot(f.owner, f.wid)).todayFavorites, []);
  await command(f.owner, { action: "page.restore", pageId: journal });
  assert.deepEqual((await boot(f.owner, f.wid)).todayFavorites, [journal]);
  await command(f.owner, { action: "page.delete", pageId: journal });
  await command(f.owner, { action: "page.purge", pageId: journal });
  assert.equal((await all("SELECT 1 FROM today_favorites WHERE page_id=?", journal)).length, 0);
});

test("the optimistic overlay adds and removes the Heute favourite at once", () => {
  const pageId = "00000000-0000-4000-8000-000000000001";
  const on = commandOverlay({ action: "favorite.today", pageId, value: true }, { userId: "u", userName: "U" })!;
  const base = { favorites: [] } as never as Parameters<NonNullable<typeof on.boot>>[0];
  const added = on.boot!(base);
  assert.deepEqual(added.todayFavorites, [pageId]);
  assert.deepEqual(added.favorites, []);
  const off = commandOverlay({ action: "favorite.today", pageId, value: false }, { userId: "u", userName: "U" })!;
  assert.deepEqual(off.boot!(added).todayFavorites, []);
});

test("archives without Heute favourites read as none", () => {
  assert.deepEqual(archiveSchema.shape.todayFavorites.parse(undefined), []);
});
