import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-activity-"));
const { run, id, all, one } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap, pageData } = await import("../lib/api");
const { htmlState } = await import("../lib/document-server");
const { withActivity } = await import("../lib/page-activity");

const person = async (name: string) => {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
};
const anna = await person("Anna");
const ben = await person("Ben");
const wid = await createWorkspace(anna.id, "Team");
await run("INSERT INTO members VALUES(?,?,?)", wid, ben.id, "editor");
const space = (await bootstrap(anna, wid)).spaces[0].id;
const pageId = (
  (await command(anna, { action: "page.create", workspaceId: wid, spaceId: space, title: "Plan", kind: "document" })) as { id: string }
).id;
const open = async (user: Identity) =>
  (await withActivity(user, (await pageData(user, pageId)) as Parameters<typeof withActivity>[1])) as Awaited<ReturnType<typeof withActivity>> & {
    sinceVisit: { editors: string[]; changes: { type: string }[] | null } | null;
    readers: { name: string; current: boolean; self: boolean }[];
    following: boolean;
  };
const sync = async (user: Identity, html: string) => {
  const generation = String((await one<{ generation: string }>("SELECT generation FROM documents WHERE page_id=?", pageId))!.generation);
  await run("UPDATE documents SET state=NULL,html='' WHERE page_id=?", pageId);
  await command(user, {
    action: "document.sync",
    workspaceId: wid,
    pageId,
    generation,
    update: Buffer.from(htmlState(html)).toString("base64"),
  });
};
const changeNotes = async (user: Identity) =>
  await all<{ body: string; read_at: string | null }>(
    "SELECT body,read_at FROM notifications WHERE user_id=? AND kind='change'",
    user.id,
  );

test("the creator follows the page; others choose to", async () => {
  assert.equal((await open(anna)).following, true);
  assert.equal((await open(ben)).following, false);
  await command(ben, { action: "page.follow", pageId, follow: true });
  assert.equal((await open(ben)).following, true);
});

test("followers get one notification per page until they look again", async () => {
  await sync(anna, "<p>Erster Absatz</p><p>Zweiter Absatz</p>");
  assert.equal((await changeNotes(ben)).length, 1);
  assert.match((await changeNotes(ben))[0].body, /Anna hat „Plan“ geändert/);
  // More changes while the notification is unread: still one.
  await run("UPDATE page_edits SET at=at-120000");
  await sync(anna, "<p>Erster Absatz</p><p>Zweiter Absatz geändert</p>");
  assert.equal((await changeNotes(ben)).length, 1);
  // The editor is not told about their own change.
  assert.equal((await changeNotes(anna)).length, 0);
});

test("opening shows what changed since the last visit and marks it read", async () => {
  // Ben opened the page earlier (before Anna's last change).
  await run("UPDATE page_visits SET seen_at=seen_at-600000, html=? WHERE user_id=?", "<p>Erster Absatz</p><p>Zweiter Absatz</p>", ben.id);
  await run("UPDATE page_edits SET at=? WHERE user_id=?", Date.now(), anna.id);
  const first = await open(ben);
  assert.deepEqual(first.sinceVisit?.editors, ["Anna"]);
  assert.ok(first.sinceVisit?.changes?.some((c) => c.type === "changed"));
  assert.ok((await changeNotes(ben)).every((n) => n.read_at), "notification answered");
  // The second look has nothing new.
  assert.equal((await open(ben)).sinceVisit, null);
});

test("readers show who opened the page and whether they saw the latest state", async () => {
  const readers = (await open(anna)).readers;
  const benReader = readers.find((r) => r.name === "Ben")!;
  assert.equal(benReader.self, false);
  assert.equal(benReader.current, true);
  await run("UPDATE page_edits SET at=? WHERE user_id=?", Date.now() + 60_000, anna.id);
  assert.equal((await open(anna)).readers.find((r) => r.name === "Ben")!.current, false);
  // Recently viewed pages on the start page.
  const visits = ((await bootstrap(ben, wid)) as { recentVisits: { pageId: string }[] }).recentVisits;
  assert.equal(visits[0].pageId, pageId);
});

test("unfollowing stops notifications", async () => {
  await command(ben, { action: "page.follow", pageId, follow: false });
  await run("DELETE FROM notifications");
  await run("UPDATE page_edits SET at=at-120000");
  await sync(anna, "<p>Noch einmal</p>");
  assert.equal((await changeNotes(ben)).length, 0);
});
