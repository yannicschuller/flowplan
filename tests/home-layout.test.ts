import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";

// The personal start page: layout schema and its migration, where a layout
// comes from (workspace, personal default, team default, built-in), and
// what the widgets' data shows to whom (lib/home-layout.ts, lib/home-widgets.ts).
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-home-"));
const { id, one, run } = await import("../lib/db");
const { command, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { htmlState } = await import("../lib/document-server");
const { withContentLocale } = await import("../lib/content-locale");
const S = await import("../lib/home-layout-schema");
const { homeLayout } = await import("../lib/home-layout");
const { homeData, homeAction, homeOptions } = await import("../lib/home-widgets");

const TODAY = new Date().toISOString().slice(0, 10);
function account(name: string, isAdmin = false) {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin, disabled: 0, created_at: "" } as Identity;
}
const owner = account("home-owner"),
  member = account("home-member"),
  stranger = account("home-stranger");
const wid = createWorkspace(owner.id, "Home");
const sid = bootstrap(owner, wid).spaces[0].id;
run("INSERT INTO members VALUES(?,?,?)", wid, member.id, "editor");
const otherWid = createWorkspace(stranger.id, "Elsewhere");
const otherSid = bootstrap(stranger, otherWid).spaces[0].id;
const page = (user: Identity, w: string, s: string, title: string, kind = "document") =>
  (command(user, { action: "page.create", workspaceId: w, spaceId: s, title, kind }) as { id: string }).id;
const data = (user: Identity, widgets: { id: string; kind: string; config?: Record<string, unknown> }[], workspaceId = wid) =>
  withContentLocale("en", () => homeData(user, { workspaceId, today: TODAY, zone: "UTC", widgets: widgets.map((w) => ({ config: {}, ...w })) })).widgets as unknown as Result[];
type Result = { ok: boolean; status?: number; error?: string; data?: unknown };
const save = (user: Identity, layout: unknown, scope = "workspace", workspaceId = wid) => command(user, { action: "home.save", workspaceId, scope, layout }) as ReturnType<typeof homeLayout>;

test("the default layout is the start page as it was", () => {
  const layout = S.defaultLayout();
  assert.equal(layout.version, S.LAYOUT_VERSION);
  assert.deepEqual(layout.widgets.map((w) => w.kind), ["greeting", "recent", "recent", "quick", "pages"]);
  assert.ok(S.layoutSchema.safeParse(layout).success);
  assert.equal(homeLayout(owner, wid).source, "builtin");
  assert.equal(bootstrap(owner, wid).home?.source, "builtin");
});

test("parseLayout repairs and migrates instead of failing", () => {
  // Version 0: a plain list of widgets.
  const v0 = S.parseLayout([{ id: "t", kind: "tasks", size: "m", config: { filter: "today" } }]);
  assert.equal(v0.version, 1);
  assert.equal(v0.widgets[0].kind, "tasks");
  // Unknown kinds go, broken settings fall back one by one, ids stay unique.
  const repaired = S.parseLayout({
    version: 1,
    widgets: [
      { id: "x", kind: "teleporter", size: "s", config: {} },
      { id: "a", kind: "tasks", size: "huge", config: { filter: "someday", max: 4 } },
      { id: "a", kind: "notes", size: "s", config: { text: "hi" } },
    ],
    appearance: { density: "compact", background: "lava", header: { type: "color", value: "red" } },
  });
  assert.deepEqual(repaired.widgets.map((w) => w.kind), ["tasks", "notes"]);
  assert.equal(repaired.widgets[0].size, "m");
  assert.deepEqual(repaired.widgets[0].config, { source: "mine", filter: "due", max: 4 });
  assert.notEqual(repaired.widgets[0].id, repaired.widgets[1].id);
  assert.equal(repaired.appearance.density, "compact");
  assert.equal(repaired.appearance.background, "none");
  assert.equal(repaired.appearance.header.type, "none");
  // A newer version or garbage: the default.
  assert.equal(S.parseLayout({ version: 99, widgets: [] }).widgets.length, 5);
  assert.equal(S.parseLayout("{not json").widgets.length, 5);
});

test("the strict schema refuses what the editor never sends", () => {
  const ok = S.defaultLayout();
  const bad = (layout: unknown) => !S.layoutSchema.safeParse(layout).success;
  assert.ok(bad({ ...ok, widgets: [{ id: "l", kind: "links", size: "s", config: { links: [{ title: "x", url: "javascript:alert(1)" }] } }] }));
  assert.ok(bad({ ...ok, appearance: { ...ok.appearance, header: { type: "image", value: "https://evil.example/x.png", position: 50 } } }));
  assert.ok(bad({ ...ok, appearance: { ...ok.appearance, icon: "<script>" } }));
  assert.ok(bad({ ...ok, widgets: Array.from({ length: S.MAX_HOME_WIDGETS + 1 }, (_, i) => S.makeWidget("notes", `n${i}`)) }));
  assert.ok(!bad({ ...ok, widgets: [S.makeWidget("links", "l", { links: [{ title: "Docs", url: "https://flowplan.org" }, { title: "", url: "mailto:a@b.c" }] })] }));
});

test("layouts per workspace, a personal default, a team default; reset goes back one step", () => {
  const mine = { ...S.defaultLayout(), widgets: [S.makeWidget("tasks", "t1"), S.makeWidget("notes", "n1")] };
  let state = save(member, mine);
  assert.equal(state.source, "workspace");
  assert.deepEqual(state.layout.widgets.map((w) => w.id), ["t1", "n1"]);
  assert.equal(state.fallbackSource, "builtin");
  // Another member is not affected.
  assert.equal(homeLayout(owner, wid).source, "builtin");
  // Only owners set the team default; members see it once they reset.
  assert.throws(() => command(member, { action: "home.default", workspaceId: wid, layout: mine }));
  command(owner, { action: "home.default", workspaceId: wid, layout: { ...S.defaultLayout(), widgets: [S.makeWidget("calendar", "c1"), S.makeWidget("notes", "secret", { text: "owner's note" })] } });
  assert.equal(homeLayout(member, wid).source, "workspace");
  state = command(member, { action: "home.reset", workspaceId: wid }) as typeof state;
  assert.equal(state.source, "team");
  assert.deepEqual(state.layout.widgets.map((w) => w.kind), ["calendar", "notes"]);
  // Notes never travel with a team default.
  assert.equal((state.layout.widgets[1].config as { text: string }).text, "");
  // The personal default wins over the team default.
  state = save(member, mine, "personal");
  assert.equal(state.source, "personal");
  assert.equal(state.fallbackSource, "team");
  assert.equal(homeLayout(member, wid).source, "personal");
  state = command(member, { action: "home.reset", workspaceId: wid }) as typeof state;
  assert.equal(state.source, "team");
  command(owner, { action: "home.default", workspaceId: wid, layout: null });
  assert.equal(homeLayout(member, wid).source, "builtin");
  // Not a member: nothing to save.
  assert.throws(() => save(stranger, mine));
});

test("notes save on their own; the layout stays small", () => {
  save(owner, { ...S.defaultLayout(), widgets: [S.makeWidget("notes", "pad"), S.makeWidget("tasks", "t")] });
  command(owner, { action: "home.note", workspaceId: wid, widgetId: "pad", text: "Buy milk" });
  const state = homeLayout(owner, wid);
  assert.equal((state.layout.widgets[0].config as { text: string }).text, "Buy milk");
  assert.equal(state.layout.widgets[1].kind, "tasks");
  assert.throws(() => command(owner, { action: "home.note", workspaceId: wid, widgetId: "t", text: "x" }));
  assert.throws(() => command(owner, { action: "home.note", workspaceId: wid, widgetId: "pad", text: "x".repeat(S.MAX_NOTE_LENGTH + 1) }));
  // Leaving the workspace removes the layout for it.
  run("DELETE FROM members WHERE workspace_id=? AND user_id=?", wid, member.id);
  assert.equal(one("SELECT 1 x FROM home_layouts WHERE user_id=? AND workspace_id=?", member.id, wid), undefined);
  run("INSERT INTO members VALUES(?,?,?)", wid, member.id, "editor");
});

test("widget data stays in the workspace and follows permissions", () => {
  const doc = page(owner, wid, sid, "Plan");
  const generation = String(one<{ generation: string }>("SELECT generation FROM documents WHERE page_id=?", doc)!.generation);
  command(owner, {
    action: "document.sync",
    workspaceId: wid,
    pageId: doc,
    generation,
    update: Buffer.from(htmlState(`<p>Intro text</p><ul data-type="taskList"><li data-type="taskItem" data-checked="false" data-due="2020-01-01"><p>Old task</p></li></ul>`)).toString("base64"),
  });
  const [tasks] = data(owner, [{ id: "t", kind: "tasks" }]);
  assert.equal(tasks.ok, true);
  const items = (tasks as { data: { items: { text: string; canEdit: boolean; key: string; index: number }[] } }).data.items;
  assert.equal(items[0].text, "Old task");
  assert.equal(items[0].canEdit, true);
  // A page of another workspace: not here, even when named in the layout.
  const foreign = page(stranger, otherWid, otherSid, "Foreign");
  const [pinned] = data(owner, [{ id: "p", kind: "pinned", config: { pageId: foreign } }]);
  assert.equal(pinned.ok, false);
  assert.equal((pinned as { status: number }).status, 404);
  // Strangers get no data for a workspace they are not in.
  assert.throws(() => data(stranger, [{ id: "t", kind: "tasks" }]));
  // A private page of the owner stays out of the member's activity.
  const privateSpace = (command(owner, { action: "space.create", workspaceId: wid, name: "Private", private: true }) as { id: string }).id;
  const secret = page(owner, wid, privateSpace, "Salary review");
  command(owner, { action: "page.update", pageId: secret, patch: { title: "Salary review 2" } });
  run("INSERT INTO page_edits(page_id,user_id,at) VALUES(?,?,?) ON CONFLICT DO NOTHING", secret, owner.id, Date.now());
  const ownerActivity = (data(owner, [{ id: "a", kind: "activity" }])[0] as { data: { items: { pageId: string }[] } }).data.items;
  const memberActivity = (data(member, [{ id: "a", kind: "activity" }])[0] as { data: { items: { pageId: string }[] } }).data.items;
  assert.ok(ownerActivity.some((i) => i.pageId === secret));
  assert.ok(!memberActivity.some((i) => i.pageId === secret));
  const [pinnedSecret] = data(member, [{ id: "p", kind: "pinned", config: { pageId: secret } }]);
  assert.equal(pinnedSecret.ok, false);
  // The pinned page shows its text to who may read it.
  const [preview] = data(member, [{ id: "p", kind: "pinned", config: { pageId: doc } }]);
  assert.match((preview as { data: { excerpt: string } }).data.excerpt, /Intro text/);
  // Statistics of the week count only readable pages.
  const stats = (data(member, [{ id: "s", kind: "stats" }])[0] as { data: Record<string, number> }).data;
  assert.equal(typeof stats.pagesEdited, "number");
  // The instance status is for administrators only.
  assert.equal((data(owner, [{ id: "i", kind: "instance" }])[0] as { status: number }).status, 403);
  // Options list only this workspace's calendars and databases.
  assert.ok(Array.isArray((homeOptions(owner, { workspaceId: wid, kind: "calendar" }) as { calendars: unknown[] }).calendars));
  assert.throws(() => homeOptions(owner, { workspaceId: wid, kind: "database", pageId: foreign }));
});

test("ticking off a task and writing into the journal from the start page", async () => {
  const [before] = data(owner, [{ id: "t", kind: "tasks", config: { filter: "open" } }]);
  const task = (before as { data: { items: { source: string; pageId: string; rowId: string | null; index: number; key: string }[] } }).data.items[0];
  await withContentLocale("en", () => homeAction(owner, { action: "task.complete", ...task, done: true }));
  const [after] = data(owner, [{ id: "t", kind: "tasks", config: { filter: "open" } }]);
  assert.equal((after as { data: { items: unknown[] } }).data.items.length, 0);
  // Other actions are refused.
  await assert.rejects(() => homeAction(owner, { action: "capture.upload" }));

  const journal = page(owner, wid, sid, "Diary", "journal");
  await homeAction(owner, { action: "journal.note", journalId: journal, today: TODAY, text: "First line\nsecond line" });
  const [entry] = data(owner, [{ id: "j", kind: "journal", config: { journalId: journal } }]);
  const shown = (entry as { data: { journal: { written: boolean; excerpt: string } } }).data.journal;
  assert.equal(shown.written, true);
  assert.match(shown.excerpt, /First line/);
  // Behind a PIN: no excerpt, no writing.
  command(owner, { action: "journal.lock", pageId: journal, pin: "482915" });
  run("DELETE FROM journal_unlocks WHERE page_id=?", journal);
  const [locked] = data(owner, [{ id: "j", kind: "journal", config: { journalId: journal } }]);
  const lockedJournal = (locked as { data: { journal: Record<string, unknown> } }).data.journal;
  assert.equal(lockedJournal.locked, true);
  assert.ok(!lockedJournal.excerpt);
  await assert.rejects(() => homeAction(owner, { action: "journal.note", journalId: journal, today: TODAY, text: "sneaky" }));
});
