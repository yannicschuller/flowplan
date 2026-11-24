// Audit (Nov 2026): the web clipper wrote tags and the favicon past field
// write rules (#506), and a bookmark saved through the space path landed
// in a bookmarks database behind a journal PIN or a locked one (#507; the
// same lock gap in page.fromShare and bookmarks.import).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Field, Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-clipper-rules-"));
process.env.APP_URL = "https://flowplan.example.test";
const { run, id, one } = await import("../lib/db");
const { createWorkspace, createPage } = await import("../lib/seed");
const { bootstrap, command } = await import("../lib/api");
const { createApiToken } = await import("../lib/api-tokens");
const { clipperUser, saveClip } = await import("../lib/clipper");
const { addBookmarks } = await import("../lib/web-clip");

async function account(name: string) {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const status = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return 200;
  } catch (e) {
    return (e as { status?: number }).status ?? String(e);
  }
};
const owner = await account("rules-owner"),
  editor = await account("rules-editor");
const wid = await createWorkspace(owner.id, "Regeln");
await run("INSERT INTO members VALUES(?,?,?)", wid, editor.id, "editor");
const space = (await bootstrap(owner, wid)).spaces[0].id;
const token = (await createApiToken(editor, { name: "Clip", scope: "clipper" })).token;
const clip = await clipperUser(new Headers({ authorization: `Bearer ${token}` }));
const fieldsOf = async (pageId: string) => JSON.parse((await one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", pageId))!.fields) as Field[];
const cellsOf = async (rowId: string) => JSON.parse((await one<{ cells: string }>("SELECT cells FROM rows WHERE id=?", rowId))!.cells) as Record<string, unknown>;
const rowCount = async (pageId: string) => (await one<{ n: number }>("SELECT COUNT(*) n FROM rows WHERE page_id=?", pageId))!.n;
const BOOKMARK_FIELDS = [
  { id: "title", name: "Name", type: "text" },
  { id: "bm_url", name: "URL", type: "url" },
  { id: "bm_site", name: "Site", type: "select", options: [] },
  { id: "bm_note", name: "Note", type: "text" },
];

test("clipped tags keep out of a tag property the person may not change (#506)", async () => {
  const db = await createPage(wid, space, owner.id, "Liste", "database");
  await run("UPDATE databases SET fields=? WHERE page_id=?", JSON.stringify([
    { id: "title", name: "Name", type: "text" },
    { id: "link", name: "Link", type: "url" },
    { id: "tags", name: "Tags", type: "multiselect", options: ["approved"], access: { write: "owners" } },
  ]), db);
  for (const mode of ["page", "highlight"] as const) {
    const saved = await saveClip(clip, { mode, target: { workspaceId: wid, pageId: db }, url: "https://a.example/x", title: "A", html: "<p>x</p>", tags: ["Injected"] });
    assert.equal((await cellsOf(saved.rowId!)).tags, undefined);
  }
  assert.deepEqual((await fieldsOf(db)).find((f) => f.id === "tags")!.options, ["approved"]);
  // The owner still tags.
  const own = await saveClip(owner, { mode: "page", target: { workspaceId: wid, pageId: db }, url: "https://a.example/y", title: "B", html: "<p>y</p>", tags: ["Neu"] });
  assert.deepEqual((await cellsOf(own.rowId!)).tags, ["Neu"]);
});

test("bookmarks: tags and favicon only into properties the person may change (#506)", async () => {
  const db = await createPage(wid, space, owner.id, "Lesezeichen", "database");
  await run("UPDATE databases SET fields=? WHERE page_id=?", JSON.stringify([
    ...BOOKMARK_FIELDS,
    { id: "bm_favicon", name: "Favicon", type: "url", access: { write: "owners" } },
    { id: "bm_tags", name: "Tags", type: "multiselect", options: ["approved"], access: { write: "owners" } },
  ]), db);
  const saved = await saveClip(clip, { mode: "bookmark", target: { workspaceId: wid, pageId: db }, url: "https://b.example/1", favicon: "https://b.example/icon.png", tags: ["Injected"] });
  const cells = await cellsOf(saved.rowId!);
  assert.equal(cells.bm_favicon, undefined);
  assert.equal(cells.bm_tags, undefined);
  const fields = await fieldsOf(db);
  assert.deepEqual(fields.find((f) => f.id === "bm_tags")!.options, ["approved"]);
  assert.equal(fields.filter((f) => /tags/i.test(f.name)).length, 1, "no second tag property");
  assert.equal(cells.bm_url, "https://b.example/1");
});

test("no clipped bookmark through the space into a database behind a PIN or locked (#507)", async () => {
  const journal = await createPage(wid, space, owner.id, "Tagebuch", "journal");
  await run("INSERT INTO journal_settings(page_id,lock_hash) VALUES(?,?)", journal, "dummy-hash");
  const db = await createPage(wid, space, owner.id, "Lesezeichen", "database", journal);
  await run("UPDATE databases SET fields=? WHERE page_id=?", JSON.stringify(BOOKMARK_FIELDS), db);
  // The oldest bookmarks database of the space is the one resolved.
  await run("UPDATE pages SET created_at='2000-01-01 00:00:00' WHERE id=?", db);
  await addBookmarks(db, owner.id, [{ title: "geheim", url: "https://secret.example/plan" }]);
  const viaSpace = (url: string) => saveClip(clip, { mode: "bookmark", target: { workspaceId: wid, spaceId: space }, url });
  assert.equal(await status(() => viaSpace("https://x.example/2")), 403);
  // No duplicate answer either.
  assert.equal(await status(() => viaSpace("https://secret.example/plan")), 403);
  assert.equal(await rowCount(db), 1);
  // Locked (outside the journal) the same.
  await run("DELETE FROM journal_settings WHERE page_id=?", journal);
  await run("UPDATE pages SET locked=1 WHERE id=?", db);
  assert.equal(await status(() => viaSpace("https://x.example/3")), 403);
  assert.equal(await status(() => command(editor, { action: "page.fromShare", workspaceId: wid, spaceId: space, as: "bookmark", url: "https://x.example/4" })), 409);
  const html = '<DL><DT><A HREF="https://x.example/5">Fünf</A></DL>';
  assert.equal(await status(() => command(editor, { action: "bookmarks.import", workspaceId: wid, spaceId: space, html })), 409);
  assert.equal(await rowCount(db), 1);
  // Unlocked, all three work again.
  await run("UPDATE pages SET locked=0 WHERE id=?", db);
  assert.equal((await viaSpace("https://x.example/3")).pageId, db);
  await command(editor, { action: "page.fromShare", workspaceId: wid, spaceId: space, as: "bookmark", url: "https://x.example/4" });
  await command(editor, { action: "bookmarks.import", workspaceId: wid, spaceId: space, html });
  assert.equal(await rowCount(db), 4);
});
