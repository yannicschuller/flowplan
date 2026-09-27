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

const person = (name: string) => {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
};
const anna = person("Anna");
const ben = person("Ben");
const wid = createWorkspace(anna.id, "Team");
run("INSERT INTO members VALUES(?,?,?)", wid, ben.id, "editor");
const space = bootstrap(anna, wid).spaces[0].id;
const pageId = (
  command(anna, { action: "page.create", workspaceId: wid, spaceId: space, title: "Plan", kind: "document" }) as { id: string }
).id;
const open = (user: Identity) =>
  withActivity(user, pageData(user, pageId) as Parameters<typeof withActivity>[1]) as ReturnType<typeof withActivity> & {
    sinceVisit: { editors: string[]; changes: { type: string }[] | null } | null;
    readers: { name: string; current: boolean; self: boolean }[];
    following: boolean;
  };
const sync = (user: Identity, html: string) => {
  const generation = String(one<{ generation: string }>("SELECT generation FROM documents WHERE page_id=?", pageId)!.generation);
  run("UPDATE documents SET state=NULL,html='' WHERE page_id=?", pageId);
  command(user, {
    action: "document.sync",
    workspaceId: wid,
    pageId,
    generation,
    update: Buffer.from(htmlState(html)).toString("base64"),
  });
};
const changeNotes = (user: Identity) =>
  all<{ body: string; read_at: string | null }>(
    "SELECT body,read_at FROM notifications WHERE user_id=? AND kind='change'",
    user.id,
  );

test("the creator follows the page; others choose to", () => {
  assert.equal(open(anna).following, true);
  assert.equal(open(ben).following, false);
  command(ben, { action: "page.follow", pageId, follow: true });
  assert.equal(open(ben).following, true);
});

test("followers get one notification per page until they look again", () => {
  sync(anna, "<p>Erster Absatz</p><p>Zweiter Absatz</p>");
  assert.equal(changeNotes(ben).length, 1);
  assert.match(changeNotes(ben)[0].body, /Anna hat „Plan“ geändert/);
  // More changes while the notification is unread: still one.
  run("UPDATE page_edits SET at=at-120000");
  sync(anna, "<p>Erster Absatz</p><p>Zweiter Absatz geändert</p>");
  assert.equal(changeNotes(ben).length, 1);
  // The editor is not told about their own change.
  assert.equal(changeNotes(anna).length, 0);
});

test("opening shows what changed since the last visit and marks it read", () => {
  // Ben opened the page earlier (before Anna's last change).
  run("UPDATE page_visits SET seen_at=seen_at-600000, html=? WHERE user_id=?", "<p>Erster Absatz</p><p>Zweiter Absatz</p>", ben.id);
  run("UPDATE page_edits SET at=? WHERE user_id=?", Date.now(), anna.id);
  const first = open(ben);
  assert.deepEqual(first.sinceVisit?.editors, ["Anna"]);
  assert.ok(first.sinceVisit?.changes?.some((c) => c.type === "changed"));
  assert.ok(changeNotes(ben).every((n) => n.read_at), "notification answered");
  // The second look has nothing new.
  assert.equal(open(ben).sinceVisit, null);
});

test("readers show who opened the page and whether they saw the latest state", () => {
  const readers = open(anna).readers;
  const benReader = readers.find((r) => r.name === "Ben")!;
  assert.equal(benReader.self, false);
  assert.equal(benReader.current, true);
  run("UPDATE page_edits SET at=? WHERE user_id=?", Date.now() + 60_000, anna.id);
  assert.equal(open(anna).readers.find((r) => r.name === "Ben")!.current, false);
  // Recently viewed pages on the start page.
  const visits = (bootstrap(ben, wid) as { recentVisits: { pageId: string }[] }).recentVisits;
  assert.equal(visits[0].pageId, pageId);
});

test("unfollowing stops notifications", () => {
  command(ben, { action: "page.follow", pageId, follow: false });
  run("DELETE FROM notifications");
  run("UPDATE page_edits SET at=at-120000");
  sync(anna, "<p>Noch einmal</p>");
  assert.equal(changeNotes(ben).length, 0);
});
