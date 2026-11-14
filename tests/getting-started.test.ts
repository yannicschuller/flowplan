// The checklist "Erste Schritte" after the introduction (lib/getting-started.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-getting-started-"));
const { run, id, one } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");
const { checklistView } = await import("../lib/getting-started-items");
const { noteGettingStarted } = await import("../lib/getting-started");

async function person(name: string, extra: Partial<Identity> = {}): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "", ...extra } as Identity;
}
const items = (view: { items: { id: string; done: boolean }[] } | null | undefined) =>
  Object.fromEntries((view?.items || []).map((i) => [i.id, i.done]));

test("no list until the introduction ends; skipping the introduction by API starts none", async () => {
  const ada = await person("Ada");
  const wid = await createWorkspace(ada.id, "Ada");
  assert.equal((await bootstrap(ada, wid)).gettingStarted, null);
  await command(ada, { action: "profile.onboarded", workspaceId: wid });
  assert.equal((await bootstrap(ada, wid)).gettingStarted, null);
  // Without a list nothing is recorded (people who never saw the introduction).
  assert.equal(await noteGettingStarted(ada.id, wid, "page"), false);
});

test("items tick from what happens, once; by hand both ways; hidden and shown again", async () => {
  const ben = await person("Ben");
  const wid = await createWorkspace(ben.id, "Ben");
  const space = (await one<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=?", wid))!.id;
  const started = await command(ben, { action: "gettingStarted.start", workspaceId: wid, goal: "projects", source: "notion" });
  assert.deepEqual(items(started as never), { page: false, task: false, invite: false, app: false, search: false, import: false });
  const boot = await bootstrap(ben, wid);
  assert.equal(boot.gettingStarted?.goal, "projects");
  assert.equal(boot.gettingStarted?.source, "notion");
  assert.equal(boot.gettingStarted?.doneCount, 0);

  // A whiteboard is no page to write; a document is.
  await command(ben, { action: "page.create", workspaceId: wid, spaceId: space, title: "Board", kind: "whiteboard" });
  assert.equal(items((await bootstrap(ben, wid)).gettingStarted).page, false);
  await command(ben, { action: "page.create", workspaceId: wid, spaceId: space, title: "Erste Seite" });
  // A record in a database without anything to tick off is no task …
  const notes = (await command(ben, { action: "page.create", workspaceId: wid, spaceId: space, title: "Notizen", kind: "database", databaseKind: "documents" })) as { id: string };
  await command(ben, { action: "row.create", workspaceId: wid, pageId: notes.id, cells: {} });
  assert.equal(items((await bootstrap(ben, wid)).gettingStarted).task, false);
  // … one in a task database is.
  const todo = (await command(ben, { action: "page.create", workspaceId: wid, spaceId: space, title: "Aufgaben", kind: "database", databaseKind: "tasks" })) as { id: string };
  await command(ben, { action: "row.create", workspaceId: wid, pageId: todo.id, cells: {} });
  await command(ben, { action: "member.invite", workspaceId: wid, email: "cleo@example.test", role: "editor" });
  let view = (await bootstrap(ben, wid)).gettingStarted;
  assert.deepEqual(items(view), { page: true, task: true, invite: true, app: false, search: false, import: false });
  assert.equal(view?.doneCount, 3);
  // The first time counts.
  const first = JSON.parse((await one<{ done: string }>("SELECT done FROM getting_started WHERE user_id=?", ben.id))!.done).page;
  await command(ben, { action: "page.create", workspaceId: wid, spaceId: space, title: "Zweite Seite" });
  assert.equal(JSON.parse((await one<{ done: string }>("SELECT done FROM getting_started WHERE user_id=?", ben.id))!.done).page, first);

  // The browser reports the search; by hand it goes back too.
  await command(ben, { action: "gettingStarted.mark", workspaceId: wid, item: "search", done: true });
  await command(ben, { action: "gettingStarted.mark", workspaceId: wid, item: "page", done: false });
  view = (await bootstrap(ben, wid)).gettingStarted;
  assert.equal(items(view).search, true);
  assert.equal(items(view).page, false);
  await assert.rejects(async () => await command(ben, { action: "gettingStarted.mark", workspaceId: wid, item: "nonsense", done: true }));

  // An import ticks "Inhalte importieren".
  await command(ben, { action: "page.import", workspaceId: wid, spaceId: space, title: "Import", content: "# Hallo", format: "markdown" });
  assert.equal(items((await bootstrap(ben, wid)).gettingStarted).import, true);

  await command(ben, { action: "gettingStarted.hide", workspaceId: wid, hidden: true });
  assert.equal((await bootstrap(ben, wid)).gettingStarted?.hidden, true);
  // The introduction again shows it again, with what was done.
  await command(ben, { action: "gettingStarted.start", workspaceId: wid, goal: "team" });
  view = (await bootstrap(ben, wid)).gettingStarted;
  assert.equal(view?.hidden, false);
  assert.equal(view?.goal, "team");
  assert.equal(view?.source, "notion");
  assert.equal(items(view).search, true);
});

test("who sees which items: invitations for owners, nothing to write for viewers, no import after one in the introduction", async () => {
  const cleo = await person("Cleo");
  const wid = await createWorkspace(cleo.id, "Cleo");
  const dan = await person("Dan");
  await run("INSERT INTO members VALUES(?,?,?)", wid, dan.id, "viewer");
  await command(dan, { action: "gettingStarted.start", workspaceId: wid });
  assert.deepEqual(Object.keys(items((await bootstrap(dan, wid)).gettingStarted)), ["app", "search"]);
  const eve = await person("Eve");
  await run("INSERT INTO members VALUES(?,?,?)", wid, eve.id, "editor");
  await command(eve, { action: "gettingStarted.start", workspaceId: wid, source: "obsidian", imported: true });
  assert.deepEqual(Object.keys(items((await bootstrap(eve, wid)).gettingStarted)), ["page", "task", "app", "search"]);
  // Not a member: no list, no command.
  const stranger = await person("Fritz");
  await assert.rejects(async () => await command(stranger, { action: "gettingStarted.start", workspaceId: wid }), /Berechtigung/);
  // The pure view: done items count, an import before the start is left out.
  const view = checklistView(
    { startedAt: 100, hiddenAt: null, goal: null, source: null, done: { import: 100, page: 120 } },
    { owner: true, guest: false, canWrite: true },
  );
  assert.deepEqual(view.items.map((i) => i.id), ["page", "task", "invite", "app", "search"]);
  assert.equal(view.doneCount, 1);
  assert.equal(checklistView({ startedAt: 100, hiddenAt: null, goal: null, source: null, done: { import: 101 } }, { owner: true, guest: true, canWrite: true }).items.some((i) => i.id === "invite"), false);
});

test("the list goes with the account and with a merge", async () => {
  const { USER_REFERENCES } = await import("../lib/account-merge");
  assert.equal(USER_REFERENCES["getting_started.user_id"], "move");
  assert.equal(USER_REFERENCES["sample_spaces.user_id"], "move");
});
