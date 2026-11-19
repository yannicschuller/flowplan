// The cheap 304 (#383, lib/kept-answers.ts): an answer's ETag is kept with
// the tables it was read from (lib/db.ts tracks reads and writes per table,
// triggers and foreign keys included) and answered right away while none of
// them was written. The test checks the tracking itself, and – the property
// that matters – that the kept 304 never answers when building the answer
// anew gives another ETag: after each of many kinds of writes, for the
// bootstrap and for pages, as the route does it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-kept-answers-"));
const { id, run, one, all, db, tableClockNow, tablesUnchangedSince, notificationParamIndex } = await import("../lib/db");
const { database } = await import("../lib/db-driver");
const { bootstrap, command, pageData } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { bootstrapResponse } = await import("../lib/bootstrap-pages");
const { jsonWithTag } = await import("../lib/etag");
const { withReadMemo, withTrackedReads } = await import("../lib/read-memo");
const { keepAnswer, keptNotModified, trackedAnswer, keptAnswerStats, forgetKeptAnswers, MAX_AGE } = await import("../lib/kept-answers");
const { notePresence } = await import("../lib/page-presence");
const { withActivity } = await import("../lib/page-activity");

const sqlite = database().backend === "sqlite";

async function user(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.com`);
  return { id: uid, name, email: `${name}@example.com`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const owner = await user("owner"),
  viewer = await user("viewer"),
  wid = await createWorkspace(owner.id, "Kept"),
  team = (await bootstrap(owner, wid)).spaces[0].id;
await run("INSERT INTO members(workspace_id,user_id,role) VALUES(?,?,?)", wid, viewer.id, "editor");
const page = async (extra: Record<string, unknown> = {}) =>
  ((await command(owner, { action: "page.create", workspaceId: wid, spaceId: team, title: "Seite", ...extra })) as { id: string }).id;
const doc = await page({ title: "Doc" });
const tasks = await page({ title: "Tasks", kind: "database" });

// As the route answers: the kept 304 first, else built, tracked and kept.
const ask = (tag: string | null) => new Request("http://localhost/x", { headers: tag ? { "if-none-match": tag } : {} });
async function getBootstrap(person: Identity, tag: string | null) {
  return await withReadMemo(async () => {
    const key = `bootstrap\n${wid}\n${person.id}`;
    const kept = keptNotModified(key, tag);
    if (kept) return { status: 304, tag: kept.headers.get("etag"), kept: true };
    const tracked = await trackedAnswer(() => bootstrap(person, wid));
    const response = keepAnswer(key, tracked, bootstrapResponse(ask(tag), tracked.value));
    return { status: response.status, tag: response.headers.get("etag"), kept: false };
  });
}
async function getPage(person: Identity, pid: string, tag: string | null) {
  return await withReadMemo(async () => {
    const key = `page\n${pid}\n1\n${person.id}`;
    const kept = keptNotModified(key, tag);
    if (kept) {
      await notePresence(pid, person.id);
      return { status: 304, tag: kept.headers.get("etag"), kept: true };
    }
    const tracked = await trackedAnswer(async () => await withActivity(person, await pageData(person, pid, { presence: true }), false));
    const response = keepAnswer(key, tracked, jsonWithTag(ask(tag), tracked.value));
    return { status: response.status, tag: response.headers.get("etag"), kept: false };
  });
}
// The ETag a build from scratch gives now (nothing kept, nothing noted).
async function freshBootstrapTag(person: Identity) {
  return await withReadMemo(async () => bootstrapResponse(ask(null), await bootstrap(person, wid)).headers.get("etag"));
}
async function freshPageTag(person: Identity, pid: string) {
  return await withReadMemo(async () => jsonWithTag(ask(null), await withActivity(person, await pageData(person, pid, { presence: false }), false)).headers.get("etag"));
}

test("reads and writes are tracked per table, with triggers and foreign keys", { skip: !sqlite }, async () => {
  const { tables } = await withTrackedReads(async () => {
    await one("SELECT p.id FROM pages p JOIN spaces s ON s.id=p.space_id WHERE p.id=?", doc);
    await all("SELECT name FROM users WHERE id IN (SELECT user_id FROM members WHERE workspace_id=?)", wid);
  });
  assert.deepEqual([...tables].sort(), ["members", "pages", "spaces", "users"]);
  const unchanged = (names: string[], write: () => unknown) => {
    const stamp = tableClockNow();
    return Promise.resolve(write()).then(() => tablesUnchangedSince(names, stamp));
  };
  // The table written, and only that.
  assert.equal(await unchanged(["favorites"], () => run("UPDATE pages SET icon='x' WHERE id=?", doc)), true, "another table");
  assert.equal(await unchanged(["pages"], () => run("UPDATE pages SET icon='y' WHERE id=?", doc)), false, "the table");
  // What triggers write: a page's change moves its cache version.
  assert.equal(await unchanged(["cache_versions"], () => run("UPDATE pages SET icon='z' WHERE id=?", doc)), false, "trigger target");
  // Foreign keys: deleting an account deletes its memberships.
  const someone = await user("someone");
  await run("INSERT INTO members(workspace_id,user_id,role) VALUES(?,?,?)", wid, someone.id, "viewer");
  assert.equal(await unchanged(["members"], () => run("DELETE FROM users WHERE id=?", someone.id)), false, "cascade");
  // Unknown writes count as everything.
  assert.equal(await unchanged(["favorites"], () => database().exec("UPDATE pages SET icon='' WHERE id='none'")), false, "exec");
  // Reads and reporting PRAGMAs change nothing.
  assert.equal(await unchanged(["pages"], () => all("PRAGMA table_info(pages)")), true, "PRAGMA table_info");
  assert.equal(await unchanged(["pages"], () => one("SELECT COUNT(*) n FROM pages")), true, "a read");
});

test("the recipient of a new notification is found in the statement", () => {
  assert.equal(notificationParamIndex("INSERT INTO notifications(id,user_id,body,page_id,kind) VALUES(?,?,?,?,'mention')"), 1);
  assert.equal(notificationParamIndex("INSERT INTO notifications(id,user_id,body,page_id,kind,link,push_only) VALUES(?,?,?,NULL,'study','#study',?)"), 1);
  assert.equal(notificationParamIndex("INSERT INTO notifications(kind,id,body,user_id) VALUES('x',?,?,?)"), 2);
  assert.equal(notificationParamIndex("INSERT INTO notifications(id,user_id,body) VALUES(?,'fixed',?)"), -1);
  assert.equal(notificationParamIndex("INSERT INTO notifications(id,user_id,body) SELECT id,user_id,'x' FROM other"), -1);
  assert.equal(notificationParamIndex("UPDATE notifications SET read_at=? WHERE user_id=?"), -1);
});

test("an unchanged refresh is answered from the kept tag, a change builds anew", { skip: !sqlite }, async () => {
  forgetKeptAnswers();
  const first = await getBootstrap(viewer, null);
  assert.equal(first.status, 200);
  const again = await getBootstrap(viewer, first.tag);
  assert.deepEqual([again.status, again.kept], [304, true], "kept 304");
  // Another tag (another browser state) is not answered from the kept one.
  assert.equal((await getBootstrap(viewer, 'W/"other"')).status, 200);
  // A change the answer shows: built anew, a new tag.
  const renewed = await getBootstrap(viewer, first.tag);
  await command(owner, { action: "page.update", pageId: doc, patch: { title: "Doc 2" } });
  const changed = await getBootstrap(viewer, renewed.tag);
  assert.deepEqual([changed.status, changed.kept], [200, false]);
  assert.notEqual(changed.tag, renewed.tag);
  assert.ok(keptAnswerStats().hits >= 1);
});

test("the kept 304 never answers when a fresh build differs (bootstrap and pages, many writes)", { skip: !sqlite }, async () => {
  forgetKeptAnswers();
  const tags = new Map<string, string | null>();
  // Each write, then every view: a kept 304 must equal what a build gives.
  const views: [string, () => Promise<{ status: number; tag: string | null; kept: boolean }>, () => Promise<string | null>][] = [
    ["bootstrap viewer", () => getBootstrap(viewer, tags.get("bootstrap viewer") ?? null), () => freshBootstrapTag(viewer)],
    ["bootstrap owner", () => getBootstrap(owner, tags.get("bootstrap owner") ?? null), () => freshBootstrapTag(owner)],
    ["doc viewer", () => getPage(viewer, doc, tags.get("doc viewer") ?? null), () => freshPageTag(viewer, doc)],
    ["tasks viewer", () => getPage(viewer, tasks, tags.get("tasks viewer") ?? null), () => freshPageTag(viewer, tasks)],
  ];
  let kept = 0;
  const round = async (label: string) => {
    for (const [name, get, fresh] of views) {
      const answer = await get();
      if (answer.kept) {
        kept++;
        assert.equal(await fresh(), answer.tag, `${label}: ${name} kept 304 equals a fresh build`);
      }
      tags.set(name, answer.tag);
    }
  };
  // Two rounds to settle (presence of the person, first answers).
  await round("start");
  await round("start again");
  await round("unchanged");
  const row = ((await command(owner, { action: "row.create", pageId: tasks, cells: { title: "A" } })) as { id: string }).id;
  const writes: [string, () => Promise<unknown>][] = [
    ["page rename", () => command(owner, { action: "page.update", pageId: doc, patch: { title: "Renamed" } })],
    ["new page", () => page({ title: "New" })],
    ["comment", () => command(owner, { action: "comment.create", pageId: doc, body: "Hallo @viewer" })],
    ["record", () => command(owner, { action: "row.update", pageId: tasks, rowId: row, version: 1, cells: { title: "B" } })],
    ["record added", () => command(owner, { action: "row.create", pageId: tasks, cells: { title: "C" } })],
    ["notification", () => run("INSERT INTO notifications(id,user_id,body,kind) VALUES(?,?,?,'mention')", id(), viewer.id, "Hallo")],
    ["notification read", () => run("UPDATE notifications SET read_at=CURRENT_TIMESTAMP WHERE user_id=?", viewer.id)],
    ["favourite", () => run("INSERT INTO favorites(user_id,page_id) VALUES(?,?)", viewer.id, doc)],
    ["member role", () => run("UPDATE members SET role='viewer' WHERE workspace_id=? AND user_id=?", wid, viewer.id)],
    ["page grant", () => run("INSERT INTO grants(resource_id,user_id,group_id,role,resource_kind,workspace_id) VALUES(?,?,?,?,?,?)", doc, viewer.id, "", "editor", "page", wid)],
    ["instance settings", () => run("INSERT INTO instance_settings(key,value) VALUES('announcement','\"Wartung\"') ON CONFLICT(key) DO UPDATE SET value=excluded.value")],
    ["account name", () => run("UPDATE users SET name='Owner N' WHERE id=?", owner.id)],
    ["someone else on the page", () => withReadMemo(() => notePresence(doc, owner.id))],
    ["page trashed", async () => command(owner, { action: "page.delete", pageId: await page({ title: "Gone" }) })],
  ];
  for (const [label, write] of writes) {
    await write();
    await round(label);
    await round(`${label}, again`);
  }
  assert.ok(kept > 10, `kept answers were used (${kept})`);
});

test("another connection's commit, the age and a reopened database end a kept answer", { skip: !sqlite }, async () => {
  forgetKeptAnswers();
  const first = await getBootstrap(viewer, null);
  assert.equal((await getBootstrap(viewer, first.tag)).kept, true);
  // A script writing the same file (another connection).
  const other = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
  other.exec("PRAGMA busy_timeout=5000");
  other.prepare("UPDATE workspaces SET name=? WHERE id=?").run("Renamed outside", wid);
  other.close();
  const after = await getBootstrap(viewer, first.tag);
  assert.equal(after.kept, false, "built anew after another connection's commit");
  assert.notEqual(after.tag, first.tag);
  // Older than MAX_AGE: built anew (and renewed with the same tag).
  const key = `bootstrap\n${wid}\n${viewer.id}`;
  assert.ok(keptNotModified(key, after.tag), "kept now");
  assert.equal(keptNotModified(key, after.tag, Date.now() + MAX_AGE + 1), null, "too old");
  // The safety-net refresh of a tab with the live signal (60 s) is still a
  // kept 304 – unless a quarter hour (a new day somewhere) begins between.
  const inMinute = Date.now() + 61_000;
  if (Math.floor(inMinute / 900_000) === Math.floor(Date.now() / 900_000)) assert.ok(keptNotModified(key, after.tag, inMinute), "after a minute");
  else assert.equal(keptNotModified(key, after.tag, inMinute), null, "a quarter hour began");
});

test("presence: someone new on the page, or someone dropping out, ends the kept answer", { skip: !sqlite }, async () => {
  forgetKeptAnswers();
  const other = await page({ title: "Presence" });
  let tag = (await getPage(viewer, other, null)).tag;
  tag = (await getPage(viewer, other, tag)).tag;
  assert.equal((await getPage(viewer, other, tag)).kept, true, "the same people: kept");
  await withReadMemo(() => notePresence(other, owner.id));
  const arrived = await getPage(viewer, other, tag);
  assert.equal(arrived.kept, false, "someone new: built anew");
  assert.notEqual(arrived.tag, tag);
  // The answer lasts until the first one present drops out of the window.
  const key = `page\n${other}\n1\n${viewer.id}`;
  const settled = await getPage(viewer, other, arrived.tag);
  assert.ok(keptNotModified(key, settled.tag), "kept");
  assert.equal(keptNotModified(key, settled.tag, Date.now() + 46_000), null, "someone dropped out");
});
