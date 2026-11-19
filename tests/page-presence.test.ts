import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity, Page } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-page-presence-"));
const { id, run, one, writeGeneration, transaction } = await import("../lib/db");
const { purgePages } = await import("../lib/workspace-lifecycle");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap, pageData } = await import("../lib/api");
const { withReadMemo } = await import("../lib/read-memo");
const { notePresence, pagePresence, PRESENT_MS } = await import("../lib/page-presence");

// Who has a page open (#383): kept in memory, no write per page GET; in
// cluster mode also in the presence table, at most every 15 s.
const account = async (name: string) => {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
};
const owner = await account("presence-owner"),
  member = await account("presence-member");
const wid = await createWorkspace(owner.id, "Presence");
await run("INSERT INTO members VALUES(?,?,?)", wid, member.id, "editor");
const space = (await bootstrap(owner, wid)).spaces[0];
const newPage = async (title: string) =>
  ((await command(owner, { action: "page.create", workspaceId: wid, spaceId: space.id, title, kind: "document" })) as { id: string }).id;
const present = (data: unknown) => (data as { present: { id: string; name: string }[] }).present;

test("the others on the page, without a write", async () => {
  const pageId = await newPage("Gemeinsam");
  // As before: the answer lists who was there before this request.
  assert.deepEqual(present(await pageData(owner, pageId)), []);
  assert.deepEqual(present(await pageData(member, pageId)), [{ id: owner.id, name: owner.name }]);
  const both = [owner, member].map((u) => ({ id: u.id, name: u.name })).sort((a, b) => (a.id < b.id ? -1 : 1));
  assert.deepEqual(present(await pageData(owner, pageId)), both);
  // Offline copies and prefetches do not count (presence: false).
  const other = await newPage("Vorab");
  await pageData(member, other, { presence: false });
  assert.deepEqual(present(await pageData(owner, other)), []);
  // No row in the table, and the read memo of other requests stays.
  assert.equal((await one<{ n: number }>("SELECT COUNT(*) n FROM presence"))!.n, 0);
  await withReadMemo(async () => {
    await pageData(member, pageId);
    const generation = writeGeneration();
    await pageData(member, pageId);
    assert.equal(writeGeneration(), generation);
  });
});

test("the window and a deleted page", async () => {
  const pageId = await newPage("Fenster");
  const now = Date.now();
  await notePresence(pageId, member.id, now - PRESENT_MS - 1);
  assert.deepEqual(await pagePresence(pageId, now), []);
  await notePresence(pageId, member.id, now - 1000);
  assert.deepEqual(await pagePresence(pageId, now), [{ id: member.id, name: member.name }]);
  const page = (await one<Page>("SELECT * FROM pages WHERE id=?", pageId))!;
  await transaction(async () => purgePages(wid, [page]));
  assert.equal(await one("SELECT 1 FROM pages WHERE id=?", pageId), undefined);
  assert.deepEqual(await pagePresence(pageId, now), []);
});

test("cluster mode: the table as well, at most every 15 s", async () => {
  const pageId = await newPage("Cluster");
  const saved = process.env.FLOWPLAN_CLUSTER;
  process.env.FLOWPLAN_CLUSTER = "1";
  try {
    const now = Date.now();
    await notePresence(pageId, member.id, now - 20_000);
    await notePresence(pageId, member.id, now - 10_000);
    const seen = async () => (await one<{ seen: number }>("SELECT seen FROM presence WHERE page_id=? AND user_id=?", pageId, member.id))?.seen;
    assert.equal(await seen(), now - 20_000, "written once within 15 s");
    await notePresence(pageId, member.id, now);
    assert.equal(await seen(), now);
    // Another instance's person, from the table.
    await run("INSERT INTO presence VALUES(?,?,?)", pageId, owner.id, now - 5000);
    const ids = (await pagePresence(pageId, now)).map((p) => p.id).sort();
    assert.deepEqual(ids, [owner.id, member.id].sort());
  } finally {
    if (saved === undefined) delete process.env.FLOWPLAN_CLUSTER;
    else process.env.FLOWPLAN_CLUSTER = saved;
  }
});
