// The widgets of 2026 (lib/mobile-widget-kinds.ts) and the colours of every
// widget answer (lib/mobile-widget-theme.ts): next appointment with "Join",
// continue reading, a dashboard's key figure, a deadline – each with the
// permission, PIN and end-to-end encryption rules of the other widgets.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Field, Identity, View } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-widgets-2026-"));
delete process.env.MEETING_HOSTS;
const { id, one, run } = await import("../lib/db");
const { command, bootstrap, database } = await import("../lib/api");
const { createWorkspace, createPage } = await import("../lib/seed");
const { htmlState } = await import("../lib/document-server");
const { registerMobileDevice } = await import("../lib/mobile-devices");
const { withContentLocale } = await import("../lib/content-locale");
const { derivePalette } = await import("../lib/workspace-theme");
const { FLOWPLAN_THEME } = await import("../lib/mobile-widget-theme");
const { joinUrl } = await import("../lib/mobile-widget-kinds");
const { taskKey } = await import("../lib/doc-tasks");
const W = await import("../lib/mobile-widgets");

const NOW = Date.now();
const TODAY = new Date(NOW).toISOString().slice(0, 10);
const day = (offset: number) => new Date(Date.parse(`${TODAY}T12:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
const at = (ms: number) => new Date(ms).toISOString().slice(0, 16);

async function account(name: string) {
  const uid = id(),
    token = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  await run("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)", token, uid, "[]", Date.now() + 3600000);
  const user = { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
  return { user, token };
}
async function phone(acc: { user: Identity; token: string }) {
  const { deviceToken } = await registerMobileDevice(acc.user, acc.token, { installationId: randomUUID(), platform: "ios" });
  return (await W.widgetUser(`Bearer ${deviceToken}`))!;
}
type Theme = { workspaceId: string | null; accent: string; accentDark: string; onAccent: string; onAccentDark: string };
type Result = { id: string | null; kind: string; ok: boolean; status?: number; error?: string; data?: Record<string, any>; theme: Theme };
async function widgets(user: Identity, list: { kind: string; config?: Record<string, unknown> }[], now = NOW) {
  return (await withContentLocale("en", async () => await W.widgetsData(user, { today: TODAY, zone: "UTC", widgets: list }, now))).widgets as Result[];
}
const one_ = async (user: Identity, kind: string, config: Record<string, unknown> = {}, now = NOW) => {
  const [result] = await widgets(user, [{ kind, config }], now);
  assert.equal(result.ok, true, `${kind}: ${result.error}`);
  return result.data!;
};
const failed = async (user: Identity, kind: string, config: Record<string, unknown>) => (await widgets(user, [{ kind, config }]))[0];
async function makeDatabase(user: Identity, wid: string, sid: string, title: string, fields: Field[], views?: View[]) {
  const pageId = ((await command(user, { action: "page.create", workspaceId: wid, spaceId: sid, kind: "database", title })) as { id: string }).id;
  const current = await database(pageId);
  await command(user, { action: "database.update", pageId, version: current.version, fields, views: views ?? current.views });
  return pageId;
}
const addRow = async (user: Identity, pageId: string, cells: Record<string, unknown>) => ((await command(user, { action: "row.create", pageId, cells })) as { id: string }).id;
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

const owner = await account("w26-owner"),
  editor = await account("w26-editor"),
  stranger = await account("w26-stranger");
const wid = await createWorkspace(owner.user.id, "Team");
const sid = (await bootstrap(owner.user, wid)).spaces[0].id;
await run("INSERT INTO members VALUES(?,?,?)", wid, editor.user.id, "editor");
await createWorkspace(stranger.user.id, "Elsewhere");
const O = await phone(owner),
  E = await phone(editor),
  S = await phone(stranger);

// ---- Theme ----

test("every answer carries the colours of its workspace: custom accent, default, plain look", async () => {
  const second = await createWorkspace(owner.user.id, "Second");
  const secondSpace = (await bootstrap(owner.user, second)).spaces[0].id;
  const doc = await createPage(second, secondSpace, owner.user.id, "Notes", "document");
  await run("UPDATE workspaces SET theme=? WHERE id=?", JSON.stringify({ accent: "#e0a000", background: "sepia" }), second);
  // Person-wide widgets: the workspace used last.
  await run("INSERT INTO workspace_activity(user_id,workspace_id,at) VALUES(?,?,?)", owner.user.id, wid, NOW);
  const [mine, page, broken] = await widgets(O, [
    { kind: "mentions" },
    { kind: "pinned", config: { mode: "page", pageId: doc } },
    { kind: "counter", config: { pageId: randomUUID() } },
  ]);
  assert.deepEqual(mine.theme, { workspaceId: wid, ...FLOWPLAN_THEME });
  const light = derivePalette("#e0a000", "light", "sepia"),
    dark = derivePalette("#e0a000", "dark", "sepia");
  assert.deepEqual(page.theme, { workspaceId: second, accent: light.blue, accentDark: dark.blue, onAccent: light.onAccent, onAccentDark: dark.onAccent });
  // Contrast-checked: the light accent is darker than the chosen yellow.
  assert.notEqual(page.theme.accent, "#e0a000");
  // A failed widget still gets colours (the person's workspace).
  assert.equal(broken.ok, false);
  assert.equal(broken.theme.workspaceId, wid);
  // The person chose Flowplan's own look: Flowplan's colours everywhere.
  await run("UPDATE users SET plain_look=1 WHERE id=?", owner.user.id);
  assert.deepEqual((await widgets(O, [{ kind: "pinned", config: { mode: "page", pageId: doc } }]))[0].theme, { workspaceId: second, ...FLOWPLAN_THEME });
  await run("UPDATE users SET plain_look=0 WHERE id=?", owner.user.id);
  // Someone else's page: not its workspace's colours, the person's own.
  const foreign = (await widgets(S, [{ kind: "pinned", config: { mode: "page", pageId: doc } }]))[0];
  assert.equal(foreign.ok, false);
  assert.notEqual(foreign.theme.workspaceId, second);
  assert.equal(foreign.theme.accent, FLOWPLAN_THEME.accent);
});

// ---- event ----

test("join links: only known video-meeting hosts, https, never arbitrary URLs", () => {
  const ok = [
    "https://zoom.us/j/123456789?pwd=abc",
    "https://acme.zoom.us/j/987654321",
    "https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0",
    "https://teams.live.com/meet/9876543210",
    "https://meet.google.com/abc-defg-hij",
    "https://acme.webex.com/meet/jdoe",
    "https://meet.jit.si/FlowplanStandup",
    "https://whereby.com/flowplan",
  ];
  for (const link of ok) assert.equal(joinUrl([`Dial in: ${link}.`]), new URL(link).href, link);
  for (const text of [
    "https://zoom.us.evil.example/j/123",
    "https://evil.example/zoom.us/j/123",
    "http://zoom.us/j/123",
    "https://zoom.us/",
    "https://meet.google.com/",
    "https://user:pw@zoom.us/j/1",
    "https://example.com/meeting",
    "zoom.us/j/123",
    "https://bbb.example.org/rooms/abc",
  ])
    assert.equal(joinUrl([text]), null, text);
  // In HTML (a synced description), the link of an anchor.
  assert.equal(joinUrl(['<p>Join <a href="https://meet.google.com/xyz-abcd-efg?authuser=0&amp;hs=1">here</a></p>']), "https://meet.google.com/xyz-abcd-efg?authuser=0&hs=1");
  // The instance's own meeting service (MEETING_HOSTS).
  assert.equal(joinUrl(["https://bbb.example.org/rooms/abc"], ["bbb.example.org"]), "https://bbb.example.org/rooms/abc");
  assert.equal(joinUrl(["https://bbb.example.org/"], ["bbb.example.org"]), null);
});

test("event: the next appointments with location and Join, countdown data, permissions", async () => {
  const cal = await makeDatabase(
    owner.user,
    wid,
    sid,
    "Calendar",
    [
      { id: "title", name: "Title", type: "text" },
      { id: "when", name: "When", type: "date" },
      { id: "until", name: "Until", type: "date" },
      { id: "where", name: "Location", type: "text" },
      { id: "link", name: "Link", type: "url" },
    ],
    [
      { id: "table", name: "Table", type: "table", filters: [], sorts: [] },
      { id: "cal", name: "Calendar", type: "calendar", filters: [], sorts: [], dateField: "when", endDateField: "until" },
    ],
  );
  await addRow(owner.user, cal, { title: "Over", when: at(NOW - 3 * 3_600_000), until: at(NOW - 2 * 3_600_000) });
  await addRow(owner.user, cal, { title: "Standup", when: at(NOW + 30 * 60_000), until: at(NOW + 45 * 60_000), where: "Room 4 · https://zoom.us/j/555" });
  const review = await addRow(owner.user, cal, { title: "Review", when: at(NOW + 2 * 3_600_000), until: at(NOW + 3 * 3_600_000), link: "https://evil.example/j/1" });
  await run("UPDATE rows SET content=? WHERE id=?", '<p>Teams: <a href="https://teams.microsoft.com/l/meetup-join/19%3aabc/0">join</a></p>', review);
  await addRow(owner.user, cal, { title: "Later", when: at(NOW + 5 * 3_600_000), until: at(NOW + 6 * 3_600_000), link: "https://example.com/doc" });
  await addRow(owner.user, cal, { title: "Far away", when: day(5) });
  const calendars = [`${cal}:cal`];

  const data = await one_(E, "event", { calendars, within: "48h" });
  assert.equal(data.title, "Next appointment");
  assert.deepEqual(data.items.map((i: { title: string }) => i.title), ["Standup", "Review", "Later"]);
  const [standup, rev, later] = data.items;
  assert.equal(standup.allDay, false);
  assert.equal(standup.start, new Date(Date.parse(`${at(NOW + 30 * 60_000)}Z`)).toISOString());
  assert.equal(standup.location, "Room 4 · https://zoom.us/j/555");
  assert.equal(standup.joinUrl, "https://zoom.us/j/555");
  assert.equal(standup.calendarName, "Calendar");
  assert.match(standup.url, new RegExp(cal));
  assert.equal(rev.joinUrl, "https://teams.microsoft.com/l/meetup-join/19%3aabc/0");
  assert.equal(later.joinUrl, undefined);
  assert.ok(bytes(data) <= W.MAX_WIDGET_BYTES);
  // Without Join, fewer, only today.
  const plain = await one_(E, "event", { calendars, within: "today", showJoin: false, max: 1 });
  assert.equal(plain.items.length, 1);
  assert.equal(plain.items[0].joinUrl, undefined);
  // The week reaches the all-day entry in five days.
  assert.ok((await one_(E, "event", { calendars, within: "week" })).total >= 4);
  // Options: the calendars with their ids for `calendars`.
  const options = (await W.widgetOptions(E, "event")) as { calendars: { id: string }[]; within: { id: string }[] };
  assert.ok(options.calendars.some((c) => c.id === `${cal}:cal`));
  assert.deepEqual(options.within.map((w) => w.id), ["today", "48h", "week"]);
  // A stranger sees nothing of it; an encrypted space nothing either.
  assert.deepEqual((await one_(S, "event", { calendars })).items, []);
  await assert.rejects(W.widgetData(W.widgetContext(E, TODAY, "UTC"), "event", { calendars: ["nope"] }));
  const vault = id();
  await run("INSERT INTO spaces(id,workspace_id,name,owner_id,visibility) VALUES(?,?,?,?,?)", vault, wid, "Vault", owner.user.id, "team");
  const secret = await createPage(wid, vault, owner.user.id, "Secret calendar", "database");
  await run("UPDATE databases SET fields=?,views=? WHERE page_id=?", JSON.stringify([{ id: "title", name: "Title", type: "text" }, { id: "when", name: "When", type: "date" }]), JSON.stringify([{ id: "cal", name: "Cal", type: "calendar", filters: [], sorts: [], dateField: "when" }]), secret);
  await run("INSERT INTO rows(id,page_id,cells) VALUES(?,?,?)", id(), secret, JSON.stringify({ title: "Merger call https://zoom.us/j/1", when: at(NOW + 60 * 60_000) }));
  await run("UPDATE spaces SET encrypted=1 WHERE id=?", vault);
  const hidden = await one_(O, "event", { calendars: [`${secret}:cal`] });
  assert.deepEqual(hidden.items, []);
  assert.doesNotMatch(JSON.stringify(hidden), /Merger/);
});

// ---- reading ----

test("reading: recently opened pages and library books with progress; PIN and E2EE as state only", async () => {
  const reader = await account("w26-reader");
  const rw = await createWorkspace(reader.user.id, "Reading");
  const rs = (await bootstrap(reader.user, rw)).spaces[0].id;
  const R = await phone(reader);
  const a = await createPage(rw, rs, reader.user.id, "Alpha", "document");
  const b = await createPage(rw, rs, reader.user.id, "Beta", "document");
  await run("INSERT INTO page_visits(user_id,page_id,seen_at) VALUES(?,?,?)", reader.user.id, a, NOW - 60_000);
  await run("INSERT INTO page_visits(user_id,page_id,seen_at) VALUES(?,?,?)", reader.user.id, b, NOW - 1000);
  const recent = await one_(R, "reading", { source: "recent", max: 2 });
  assert.deepEqual(recent.items.map((i: { title: string }) => i.title), ["Beta", "Alpha"]);
  assert.equal(recent.items[0].lastOpened, new Date(NOW - 1000).toISOString());
  assert.equal(recent.items[0].progress, undefined);
  // A journal behind a PIN: listed, but without title or icon.
  const diary = ((await command(reader.user, { action: "page.create", workspaceId: rw, spaceId: rs, title: "Diary secrets", kind: "journal" })) as { id: string }).id;
  await command(reader.user, { action: "journal.lock", pageId: diary, pin: "482915" });
  await run("DELETE FROM journal_unlocks WHERE page_id=?", diary);
  await run("INSERT INTO page_visits(user_id,page_id,seen_at) VALUES(?,?,?)", reader.user.id, diary, NOW);
  const locked = await one_(R, "reading", { source: "recent" });
  assert.deepEqual(locked.items[0], { id: diary, kind: "journal", url: `/#page=${diary}`, lastOpened: new Date(NOW).toISOString(), title: "", icon: "", locked: true });
  assert.doesNotMatch(JSON.stringify(locked), /Diary secrets/);

  // A library: book → two chapters; the second chapter read last.
  const shelf = id();
  await run("INSERT INTO spaces(id,workspace_id,name,owner_id,visibility,library) VALUES(?,?,?,?,?,1)", shelf, rw, "Shelf", reader.user.id, "team");
  const book = await createPage(rw, shelf, reader.user.id, "Handbook", "document");
  const one1 = await createPage(rw, shelf, reader.user.id, "Chapter 1", "document", book);
  const two = await createPage(rw, shelf, reader.user.id, "Chapter 2", "document", book);
  await run("UPDATE pages SET position=? WHERE id=?", 1, one1);
  await run("UPDATE pages SET position=? WHERE id=?", 2, two);
  await run("INSERT INTO page_visits(user_id,page_id,seen_at) VALUES(?,?,?)", reader.user.id, two, NOW - 500);
  const library = await one_(R, "reading", { source: "library" });
  assert.equal(library.title, "Continue reading");
  assert.equal(library.items.length, 1);
  assert.deepEqual(library.items[0], { id: two, kind: "book", url: `/#page=${two}`, lastOpened: new Date(NOW - 500).toISOString(), title: "Handbook", icon: library.items[0].icon, progress: 1, detail: "Chapter 2" });
  // Another person sees nothing of these.
  assert.deepEqual((await one_(S, "reading", { source: "library" })).items, []);
  // End-to-end encrypted shelf: nothing of it but, at most, that it is there.
  await run("UPDATE spaces SET encrypted=1 WHERE id=?", shelf);
  const sealed = await one_(R, "reading", { source: "library" });
  for (const item of sealed.items) assert.equal(item.encrypted, true);
  assert.doesNotMatch(JSON.stringify(sealed), /Handbook|Chapter/);
  const options = (await W.widgetOptions(R, "reading")) as { sources: { id: string }[]; max: number };
  assert.deepEqual(options.sources.map((s) => s.id), ["recent", "library"]);
  assert.equal(options.max, 6);
});

// ---- metric ----

test("metric: one number tile of a dashboard with series and delta; permissions", async () => {
  const tickets = await makeDatabase(owner.user, wid, sid, "Tickets", [
    { id: "title", name: "Title", type: "text" },
    { id: "points", name: "Points", type: "number" },
  ]);
  await addRow(owner.user, tickets, { title: "A", points: 3 });
  await addRow(owner.user, tickets, { title: "B", points: 5 });
  const dash = ((await command(owner.user, { action: "page.create", workspaceId: wid, spaceId: sid, kind: "dashboard", title: "Overview" })) as { id: string }).id;
  await command(owner.user, {
    action: "dashboard.save",
    pageId: dash,
    tiles: [
      { id: "open", type: "number", source: tickets, title: "Open tickets" },
      { id: "sum", type: "number", source: tickets, aggregate: "sum", field: "points", target: 20 },
      { id: "note", type: "text", text: "Hello" },
    ],
  });
  const options = (await W.widgetOptions(E, "metric")) as { dashboards: { id: string; widgets: { id: string; name: string }[] }[] };
  const listed = options.dashboards.find((d) => d.id === dash)!;
  assert.deepEqual(listed.widgets, [{ id: "open", name: "Open tickets" }, { id: "sum", name: "Tickets" }]);
  // Yesterday's value, as the widget kept it then.
  const key = createHash("sha256").update(JSON.stringify(["metric", E.id, dash, "open"])).digest("hex");
  await run("INSERT INTO widget_counter_days(key,user_id,day,value,at) VALUES(?,?,?,?,?)", key, E.id, day(-1), 1, NOW - 86_400_000);
  const open = await one_(E, "metric", { dashboardId: dash, widgetId: "open" });
  assert.deepEqual(
    { label: open.label, value: open.value, formatted: open.formatted, series: open.series, delta: open.delta, url: open.url },
    { label: "Open tickets", value: 2, formatted: "2", series: [1, 2], delta: 1, url: `/#page=${dash}` },
  );
  const sum = await one_(E, "metric", { dashboardId: dash, widgetId: "sum" });
  assert.equal(sum.value, 8);
  assert.equal(sum.target, 20);
  assert.equal(sum.series, undefined);
  // A text tile or an unknown one is no key figure; strangers get nothing.
  assert.equal((await failed(E, "metric", { dashboardId: dash, widgetId: "note" })).status, 404);
  assert.equal((await failed(S, "metric", { dashboardId: dash, widgetId: "open" })).status, 404);
  assert.equal((await failed(E, "metric", { dashboardId: tickets, widgetId: "open" })).status, 400);
  // A source in an encrypted space: only that state.
  const vault = id();
  await run("INSERT INTO spaces(id,workspace_id,name,owner_id,visibility) VALUES(?,?,?,?,?)", vault, wid, "Vault 2", owner.user.id, "team");
  const secretDb = await createPage(wid, vault, owner.user.id, "Secret numbers", "database");
  await command(owner.user, { action: "dashboard.save", pageId: dash, tiles: [{ id: "x", type: "number", source: secretDb, title: "" }] });
  await run("UPDATE spaces SET encrypted=1 WHERE id=?", vault);
  const sealed = await one_(O, "metric", { dashboardId: dash, widgetId: "x" });
  assert.equal(sealed.encrypted, true);
  assert.equal(sealed.value, undefined);
});

// ---- deadline ----

test("deadline: a record's due date, done and overdue; a document task; hidden fields and strangers", async () => {
  const projects = await makeDatabase(owner.user, wid, sid, "Projects", [
    { id: "title", name: "Title", type: "text" },
    { id: "due", name: "Due", type: "date" },
    { id: "done", name: "Done", type: "checkbox" },
  ]);
  const launch = await addRow(owner.user, projects, { title: "Launch", due: day(3) });
  const late = await addRow(owner.user, projects, { title: "Taxes", due: day(-2) });
  const call = await addRow(owner.user, projects, { title: "Call", due: `${day(1)}T09:30` });
  const finished = await addRow(owner.user, projects, { title: "Old", due: day(-5), done: true });
  assert.deepEqual(await one_(E, "deadline", { pageId: projects, rowId: launch }), {
    title: "Launch",
    page: "Projects",
    due: day(3),
    allDay: true,
    done: false,
    overdue: false,
    url: `/#page=${projects}&row=${launch}`,
  });
  assert.equal((await one_(E, "deadline", { pageId: projects, rowId: late })).overdue, true);
  const timed = await one_(E, "deadline", { pageId: projects, rowId: call });
  assert.equal(timed.due, `${day(1)}T09:30:00Z`);
  assert.equal(timed.allDay, false);
  const old = await one_(E, "deadline", { pageId: projects, rowId: finished });
  assert.equal(old.done, true);
  assert.equal(old.overdue, false);
  // Options: databases with a due date, their records (open first), my tasks.
  const options = (await W.widgetOptions(E, "deadline", { pageId: projects })) as { databases: { id: string }[]; records: { id: string; done: boolean }[] };
  assert.ok(options.databases.some((d) => d.id === projects));
  assert.equal(options.records.length, 4);
  assert.equal(options.records.at(-1)!.id, finished);
  // Strangers, wrong config.
  assert.equal((await failed(S, "deadline", { pageId: projects, rowId: launch })).status, 404);
  assert.equal((await failed(E, "deadline", { pageId: projects, rowId: randomUUID() })).status, 404);
  assert.equal((await failed(E, "deadline", { pageId: projects })).status, 400);
  // A due date the person may not read: no date at all.
  const current = await database(projects);
  await command(owner.user, {
    action: "database.update",
    pageId: projects,
    version: current.version,
    fields: current.fields.map((f: Field) => (f.id === "due" ? { ...f, access: { read: "owners" } } : f)),
    views: current.views,
  });
  const blind = await one_(E, "deadline", { pageId: projects, rowId: late });
  assert.equal(blind.due, null);
  assert.equal(blind.overdue, false);
  assert.equal((await one_(O, "deadline", { pageId: projects, rowId: late })).due, day(-2));

  // A document task, as the tasks widget names it (key + index).
  const plan = ((await command(owner.user, { action: "page.create", workspaceId: wid, spaceId: sid, title: "Plan", kind: "document" })) as { id: string }).id;
  const html = `<ul data-type="taskList"><li data-type="taskItem" data-checked="false" data-due="${day(-1)}"><p>Send invoice</p></li></ul>`;
  const generation = String((await one<{ generation: string }>("SELECT generation FROM documents WHERE page_id=?", plan))!.generation);
  await command(owner.user, { action: "document.sync", workspaceId: wid, pageId: plan, generation, update: Buffer.from(htmlState(html)).toString("base64") });
  const task = await one_(E, "deadline", { pageId: plan, taskKey: taskKey("Send invoice"), index: 0 });
  assert.equal(task.title, "Send invoice");
  assert.equal(task.due, day(-1));
  assert.equal(task.overdue, true);
  assert.equal((await failed(E, "deadline", { pageId: plan, taskKey: taskKey("Nope") })).status, 404);
  assert.equal((await failed(S, "deadline", { pageId: plan, taskKey: taskKey("Send invoice") })).status, 404);
});

test("older apps: new kinds only when asked, the answer shape of the old kinds unchanged", async () => {
  const [result] = await widgets(O, [{ kind: "focus" }]);
  assert.deepEqual(Object.keys(result).sort(), ["data", "id", "kind", "ok", "theme"]);
  assert.ok(W.widgetKinds.indexOf("study") < W.widgetKinds.indexOf("event"));
});
