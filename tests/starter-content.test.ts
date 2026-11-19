// Starter content for new accounts (#381, lib/starter-content.ts): the
// pages of a space an administrator chose are copied into every new
// personal workspace – nested pages, databases with records, fields and
// views, files – without comments, history, shares or permissions; the
// built-in pages stay the fallback.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-starter-"));
const { one, all, run, id } = await import("../lib/db");
const { createWorkspace, ensureWorkspace } = await import("../lib/seed");
const { command, database } = await import("../lib/api");
const { upsertUser } = await import("../lib/auth");
const { instanceSettings } = await import("../lib/instance-settings");
const { starterSpaceStatus, starterSpaceChoices } = await import("../lib/starter-content");
const { htmlState } = await import("../lib/document-server");

async function user(name: string, isAdmin = false): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, disabled: 0, created_at: "", groups: [], isAdmin };
}
const act = async (who: Identity, input: Record<string, unknown>) => (await command(who, input)) as Record<string, unknown> & { id: string };

// The administrator's workspace with an "Onboarding" space.
const admin = await user("Admin", true);
const colleague = await user("Colleague");
const wid = await createWorkspace(admin.id, "Company");
await run("INSERT INTO members VALUES(?,?,?)", wid, colleague.id, "editor");
const onboarding = await act(admin, { action: "space.create", workspaceId: wid, name: "Onboarding", private: false });
const guide = await act(admin, { action: "page.create", workspaceId: wid, spaceId: onboarding.id, title: "Start here" });
const child = await act(admin, { action: "page.create", workspaceId: wid, spaceId: onboarding.id, parentId: guide.id, title: "First week" });
const grandchild = await act(admin, { action: "page.create", workspaceId: wid, spaceId: onboarding.id, parentId: child.id, title: "Day one" });
const tasks = await act(admin, { action: "page.create", workspaceId: wid, spaceId: onboarding.id, title: "Onboarding tasks", kind: "database" });
const board = await act(admin, { action: "page.create", workspaceId: wid, spaceId: onboarding.id, title: "Ideas", kind: "whiteboard" });
await act(admin, { action: "row.create", pageId: tasks.id, cells: { title: "Set up laptop" } });
await act(admin, { action: "row.create", pageId: tasks.id, cells: { title: "Meet the team" } });
const db0 = await database(tasks.id);
await act(admin, {
  action: "database.update",
  pageId: tasks.id,
  version: db0.version,
  fields: [...db0.fields, { id: "notes", name: "Notes", type: "text" }],
  views: [...db0.views, { ...db0.views[0], id: "mine", name: "My board", type: "board" }],
});
// A file the guide shows.
const fid = id(),
  bytes = Buffer.from("starter attachment");
mkdirSync(join(process.env.FLOWPLAN_DATA_DIR!, "uploads"), { recursive: true });
writeFileSync(join(process.env.FLOWPLAN_DATA_DIR!, "uploads", fid), bytes);
await run("INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)", fid, guide.id, "welcome.txt", "text/plain", bytes.length, admin.id);
const html = `<h2>Welcome aboard</h2><p><a href="/#page=${child.id}">First week</a> <a href="/api/files/${fid}">Attachment</a></p>`;
await run("UPDATE documents SET html=?,state=? WHERE page_id=?", html, htmlState(html), guide.id);
// What stays behind: comments, history, shares, public links, permissions, presence.
await act(admin, { action: "comment.create", pageId: guide.id, body: "Internal remark" });
await act(admin, { action: "page.snapshot", pageId: guide.id });
await act(admin, { action: "page.publish", pageId: guide.id, enabled: true, includeChildren: true });
await act(admin, { action: "grant.set", resourceId: child.id, userId: colleague.id, role: "viewer" });
await run("INSERT INTO presence(page_id,user_id,seen) VALUES(?,?,?)", guide.id, colleague.id, Date.now());
for (const [table, key, page] of [["comments", "page_id", guide.id], ["snapshots", "page_id", guide.id], ["publications", "page_id", guide.id], ["grants", "resource_id", child.id], ["presence", "page_id", guide.id]])
  assert.ok(await one(`SELECT 1 FROM ${table} WHERE ${key}=?`, page), `source has ${table}`);
// A page in the trash is not starter content.
const trashed = await act(admin, { action: "page.create", workspaceId: wid, spaceId: onboarding.id, title: "Old draft" });
await run("UPDATE pages SET deleted_at=CURRENT_TIMESTAMP WHERE id=?", trashed.id);

const personal = async (uid: string) => (await one<{ workspace_id: string }>("SELECT workspace_id FROM members WHERE user_id=? AND role='owner'", uid))!.workspace_id;
const pagesOf = async (workspace: string) =>
  await all<{ id: string; title: string; parent_id: string | null; kind: string; created_by: string; position: number }>(
    "SELECT id,title,parent_id,kind,created_by,position FROM pages WHERE workspace_id=? AND deleted_at IS NULL ORDER BY position,id",
    workspace,
  );
const titles = async (workspace: string) => (await pagesOf(workspace)).map((p) => p.title).sort();

test("without a chosen space new accounts get the built-in pages", async () => {
  const fresh = await user("Fresh");
  await ensureWorkspace(fresh.id);
  assert.deepEqual(await titles(await personal(fresh.id)), ["Meeting-Notizen", "Produkt-Roadmap", "Team-Handbuch", "Willkommen bei Flowplan"]);
});

test("only readable, unencrypted spaces can be chosen, and the chooser is the saving admin", async () => {
  const choices = await starterSpaceChoices(admin);
  assert.ok(choices.some((s) => s.id === onboarding.id && s.name === "Onboarding" && s.workspace === "Company"));
  // Someone else's space (the administrator is no member there).
  const other = await user("Other");
  const otherWs = await createWorkspace(other.id, "Private");
  const otherSpace = (await one<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=?", otherWs))!.id;
  assert.ok(!(await starterSpaceChoices(admin)).some((s) => s.id === otherSpace));
  await assert.rejects(() => command(admin, { action: "admin.settings", settings: { starterSpace: otherSpace } }), /Bereich nicht gefunden/);
  // Not for people who are no administrators.
  await assert.rejects(() => command(colleague, { action: "admin.settings", settings: { starterSpace: onboarding.id } }));
  // The chooser cannot be sent along.
  await command(admin, { action: "admin.settings", settings: { starterSpace: onboarding.id, starterBy: colleague.id } });
  const saved = await instanceSettings();
  assert.equal(saved.starterSpace, onboarding.id);
  assert.equal(saved.starterBy, admin.id);
  assert.equal(saved.starterKeepWelcome, true);
  const status = await starterSpaceStatus();
  assert.equal(status?.problem, null);
  assert.equal(status?.name, "Onboarding");
  assert.equal(status?.pages, 5);
});

test("a new account gets a copy of the space: nested pages, databases, files – nothing else", async () => {
  const existing = await user("Existing");
  await ensureWorkspace(existing.id);
  const before = await titles(await personal(existing.id));
  const newcomer = await user("Newcomer");
  await ensureWorkspace(newcomer.id);
  const ws = await personal(newcomer.id);
  const pages = await pagesOf(ws);
  // Welcome page first, then the space's pages; no built-in examples.
  assert.equal(pages.filter((p) => !p.parent_id)[0].title, "Willkommen bei Flowplan");
  assert.deepEqual(pages.map((p) => p.title).sort(), ["Day one", "First week", "Ideas", "Onboarding tasks", "Start here", "Willkommen bei Flowplan"]);
  assert.ok(pages.every((p) => p.created_by === newcomer.id));
  const byTitle = (t: string) => pages.find((p) => p.title === t)!;
  // Nesting.
  assert.equal(byTitle("First week").parent_id, byTitle("Start here").id);
  assert.equal(byTitle("Day one").parent_id, byTitle("First week").id);
  assert.equal(byTitle("Ideas").kind, "whiteboard");
  // New ids, all in the new workspace's only space.
  for (const source of [guide.id, child.id, grandchild.id, tasks.id, board.id]) assert.ok(!pages.some((p) => p.id === source));
  const spaces = await all<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=?", ws);
  assert.equal(spaces.length, 1);
  // Database: records, fields and views.
  const db = await database(byTitle("Onboarding tasks").id);
  assert.ok(db.fields.some((f) => f.id === "notes"));
  assert.ok(db.views.some((v) => v.name === "My board" && v.type === "board"));
  const rows = await all<{ cells: string; created_by: string }>("SELECT cells,created_by FROM rows WHERE page_id=? ORDER BY position", byTitle("Onboarding tasks").id);
  assert.deepEqual(rows.map((r) => JSON.parse(r.cells).title), ["Set up laptop", "Meet the team"]);
  assert.ok(rows.every((r) => r.created_by === newcomer.id));
  // The file is copied, readable for the new owner, and the links point to the copies.
  const file = (await one<{ id: string; created_by: string }>("SELECT id,created_by FROM files WHERE page_id=?", byTitle("Start here").id))!;
  assert.notEqual(file.id, fid);
  assert.equal(file.created_by, newcomer.id);
  assert.equal(readFileSync(join(process.env.FLOWPLAN_DATA_DIR!, "uploads", file.id), "utf8"), "starter attachment");
  const copiedHtml = (await one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", byTitle("Start here").id))!.html;
  assert.match(copiedHtml, new RegExp(`/api/files/${file.id}`));
  assert.match(copiedHtml, new RegExp(`#page=${byTitle("First week").id}`));
  // Left behind.
  const ids = pages.map((p) => p.id);
  const marks = ids.map(() => "?").join(",");
  for (const table of ["comments", "snapshots", "publications", "share_links", "presence"])
    assert.equal((await all(`SELECT 1 FROM ${table} WHERE page_id IN (${marks})`.replace("page_id", table === "share_links" ? "root_id" : "page_id"), ...ids)).length, 0, table);
  assert.equal((await all(`SELECT 1 FROM grants WHERE resource_id IN (${marks})`, ...ids)).length, 0);
  // The new account is not a member of the source workspace, the source is unchanged.
  assert.equal(await one("SELECT 1 FROM members WHERE workspace_id=? AND user_id=?", wid, newcomer.id), undefined);
  assert.equal((await all("SELECT 1 FROM pages WHERE space_id=? AND deleted_at IS NULL", onboarding.id)).length, 5);
  // Existing accounts stay as they were.
  await ensureWorkspace(existing.id);
  assert.deepEqual(await titles(await personal(existing.id)), before);
  assert.equal((await all("SELECT 1 FROM members WHERE user_id=?", existing.id)).length, 1);
});

test("without the welcome page only the space's pages", async () => {
  await command(admin, { action: "admin.settings", settings: { starterKeepWelcome: false } });
  const newcomer = await user("Second");
  await ensureWorkspace(newcomer.id);
  assert.deepEqual(await titles(await personal(newcomer.id)), ["Day one", "First week", "Ideas", "Onboarding tasks", "Start here"]);
});

test("accounts from SSO get the starter content on their first sign-in", async () => {
  const sso = await upsertUser("oidc|starter-1", "Sam Sso", "sam@example.test");
  await ensureWorkspace(sso.id);
  assert.deepEqual(await titles(await personal(sso.id)), ["Day one", "First week", "Ideas", "Onboarding tasks", "Start here"]);
  // A second sign-in copies nothing again.
  await ensureWorkspace(sso.id);
  assert.equal((await pagesOf(await personal(sso.id))).length, 5);
});

test("a gone space or a failing copy falls back to the built-in pages", async () => {
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void errors.push(args.join(" "));
  try {
    // A record that cannot be copied: the copy fails, the account does not.
    const broken = id();
    await run("INSERT INTO pages(id,workspace_id,space_id,parent_id,title,kind,created_by,position,icon) VALUES(?,?,?,?,?,?,?,?,?)", broken, wid, onboarding.id, null, "Broken", "database", admin.id, 99, "file");
    const failing = await user("Failing");
    await ensureWorkspace(failing.id);
    assert.deepEqual(await titles(await personal(failing.id)), ["Meeting-Notizen", "Produkt-Roadmap", "Team-Handbuch", "Willkommen bei Flowplan"]);
    assert.ok(errors.some((e) => e.includes("Starter content")));
    // Nothing of the failed copy is left.
    assert.equal((await all("SELECT 1 FROM pages WHERE workspace_id=? AND title='Start here'", await personal(failing.id))).length, 0);
    await run("DELETE FROM pages WHERE id=?", broken);
    // The space in the trash.
    await run("UPDATE spaces SET deleted_at=CURRENT_TIMESTAMP WHERE id=?", onboarding.id);
    assert.equal((await starterSpaceStatus())?.problem, "space gone");
    const late = await user("Late");
    await ensureWorkspace(late.id);
    assert.deepEqual(await titles(await personal(late.id)), ["Meeting-Notizen", "Produkt-Roadmap", "Team-Handbuch", "Willkommen bei Flowplan"]);
    assert.ok(errors.filter((e) => e.includes("space gone")).length >= 1);
  } finally {
    console.error = original;
    await run("UPDATE spaces SET deleted_at=NULL WHERE id=?", onboarding.id);
  }
});

test("demo accounts keep their own examples", async () => {
  // lib/demo.ts builds its workspace with createWorkspace, not ensureWorkspace.
  const demo = await user("Demo");
  const ws = await createWorkspace(demo.id, "Demo");
  assert.deepEqual(await titles(ws), ["Willkommen bei Flowplan"]);
});

test("choosing none goes back to the built-in pages", async () => {
  await command(admin, { action: "admin.settings", settings: { starterSpace: null } });
  const settings = await instanceSettings();
  assert.equal(settings.starterSpace, null);
  assert.equal(settings.starterBy, null);
  assert.equal(await starterSpaceStatus(), null);
  const later = await user("Later");
  await ensureWorkspace(later.id);
  assert.ok((await titles(await personal(later.id))).includes("Produkt-Roadmap"));
});
