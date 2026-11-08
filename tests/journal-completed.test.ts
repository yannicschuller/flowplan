// "An diesem Tag erledigt" (#169): records that became done on a journal
// day, computed from the status log (lib/journal-completed.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity, Page } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-journal-completed-"));
const { id, run, one } = await import("../lib/db");
const { command, database, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { rollJournal } = await import("../lib/journal");
const { completedOn, dayBounds, journalDayCompleted } = await import("../lib/journal-completed");

async function account(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@test.invalid`);
  return { id: uid, name, email: `${name}@test.invalid`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const owner = await account("owner"),
  member = await account("member"),
  guest = await account("guest");
const wid = await createWorkspace(owner.id, "Erledigt");
await run("INSERT INTO members VALUES(?,?,?)", wid, member.id, "editor");
const space = (await bootstrap(owner, wid)).spaces[0].id;
const act = async (body: Record<string, unknown>, as = owner): Promise<any> => await command(as, body);

async function tasksDatabase(title: string, spaceId = space, parentId?: string) {
  const pageId = (await act({ action: "page.create", workspaceId: wid, spaceId, kind: "database", title, databaseKind: "empty", ...(parentId ? { parentId } : {}) })).id as string;
  await act({
    action: "database.update",
    pageId,
    version: (await database(pageId)).version,
    fields: [
      { id: "title", name: "Titel", type: "text" },
      { id: "status", name: "Status", type: "select", options: ["Offen", "Erledigt"] },
    ],
    views: (await database(pageId)).views,
  });
  return pageId;
}
const version = async (rid: string) => (await one<{ version: number }>("SELECT version FROM rows WHERE id=?", rid))!.version;
const create = async (pageId: string, title: string, as = owner) =>
  (await act({ action: "row.create", pageId, cells: { title, status: "Offen" } }, as)).id as string;
const setStatus = async (pageId: string, rowId: string, status: string, as = owner) =>
  await act({ action: "row.update", pageId, rowId, version: await version(rowId), cells: { status } }, as);
// The log takes the time of the change; tests move it to a given moment.
const movedLog = async (rowId: string, done: 0 | 1, iso: string) => {
  const last = (await one<{ id: string }>("SELECT id FROM row_status_log WHERE row_id=? AND done=? ORDER BY at DESC LIMIT 1", rowId, done))!;
  await run("UPDATE row_status_log SET at=? WHERE id=?", Date.parse(iso), last.id);
};
const doneAt = async (rowId: string, iso: string) => await movedLog(rowId, 1, iso);
const titles = async (user: Identity, date: string, zone: string) => (await completedOn(user, wid, date, zone)).items.map((i) => i.title).sort();

const tasks = await tasksDatabase("Aufgaben");
const journalId = (await act({ action: "page.create", workspaceId: wid, spaceId: space, title: "Tagebuch", kind: "journal" })).id as string;
const journal = async () => (await one<Page>("SELECT * FROM pages WHERE id=?", journalId))!;

test("day boundaries follow the time zone", async () => {
  assert.deepEqual(dayBounds("2026-11-05", "Europe/Berlin"), { start: Date.parse("2026-11-04T23:00:00Z"), end: Date.parse("2026-11-05T23:00:00Z") });
  // Summer time ends on 25 October 2026 in Berlin: that day has 25 hours.
  const fall = dayBounds("2026-10-25", "Europe/Berlin");
  assert.equal(fall.end - fall.start, 25 * 3600_000);
  const late = await create(tasks, "Spät erledigt");
  await setStatus(tasks, late, "Erledigt");
  // 00:30 in Berlin on the 5th is still the 4th in UTC and in New York.
  await doneAt(late, "2026-11-04T23:30:00Z");
  assert.deepEqual(await titles(owner, "2026-11-05", "Europe/Berlin"), ["Spät erledigt"]);
  assert.deepEqual(await titles(owner, "2026-11-04", "Europe/Berlin"), []);
  assert.deepEqual(await titles(owner, "2026-11-04", "UTC"), ["Spät erledigt"]);
  assert.deepEqual(await titles(owner, "2026-11-04", "America/New_York"), ["Spät erledigt"]);
  // An unknown zone counts as UTC.
  assert.deepEqual(await titles(owner, "2026-11-04", "Mars/Olympus"), ["Spät erledigt"]);
  const [item] = (await completedOn(owner, wid, "2026-11-05", "Europe/Berlin")).items;
  assert.deepEqual(
    { pageId: item.pageId, rowId: item.rowId, database: item.database, at: item.at },
    { pageId: tasks, rowId: late, database: "Aufgaben", at: Date.parse("2026-11-04T23:30:00Z") },
  );
});

test("the journal day lists them; reopening removes a record, done again moves it to that day", async () => {
  const { dayId } = await rollJournal(owner, await journal(), "2026-11-06", "2026-11-06");
  const report = await create(tasks, "Bericht");
  await setStatus(tasks, report, "Erledigt");
  await doneAt(report, "2026-11-06T09:15:00Z");
  const list = async () => (await journalDayCompleted(owner, dayId, "Europe/Berlin")).items.map((i) => i.title);
  assert.deepEqual(await list(), ["Bericht"]);
  // Ticked off again: gone at once, nothing was copied into the day.
  await setStatus(tasks, report, "Offen");
  assert.deepEqual(await list(), []);
  await movedLog(report, 0, "2026-11-06T18:00:00Z");
  assert.deepEqual(await list(), []);
  assert.doesNotMatch(String((await one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", dayId))?.html || ""), /Bericht/);
  // Done once more, later: it belongs to the day of its latest completion.
  await setStatus(tasks, report, "Erledigt");
  await doneAt(report, "2026-11-07T08:00:00Z");
  assert.deepEqual(await list(), []);
  assert.deepEqual(await titles(owner, "2026-11-07", "Europe/Berlin"), ["Bericht"]);
  // Reopened once more: gone from that day as well.
  await setStatus(tasks, report, "Offen");
  assert.deepEqual(await titles(owner, "2026-11-07", "Europe/Berlin"), []);
});

test("a checkbox done rule counts as well; databases on the day page itself are left out", async () => {
  const { dayId } = await rollJournal(owner, await journal(), "2026-11-08", "2026-11-08");
  const checks = (await act({ action: "page.create", workspaceId: wid, spaceId: space, kind: "database", title: "Checkliste", databaseKind: "empty" })).id as string;
  await act({
    action: "database.update",
    pageId: checks,
    version: (await database(checks)).version,
    fields: [
      { id: "title", name: "Titel", type: "text" },
      { id: "ok", name: "Erledigt", type: "checkbox" },
    ],
    views: (await database(checks)).views,
  });
  const row = (await act({ action: "row.create", pageId: checks, cells: { title: "Häkchen", ok: false } })).id as string;
  await act({ action: "row.update", pageId: checks, rowId: row, version: await version(row), cells: { ok: true } });
  await doneAt(row, "2026-11-08T10:00:00Z");
  const inline = await tasksDatabase("Auf dem Tag", space, dayId);
  const there = await create(inline, "Steht schon da");
  await setStatus(inline, there, "Erledigt");
  await doneAt(there, "2026-11-08T11:00:00Z");
  assert.deepEqual((await journalDayCompleted(owner, dayId, "UTC")).items.map((i) => i.title), ["Häkchen"]);
  // Without the day to leave out, the inline database counts like any other.
  assert.deepEqual(await titles(owner, "2026-11-08", "UTC"), ["Häkchen", "Steht schon da"]);
});

test("only records the reader may see", async () => {
  const date = "2026-11-10";
  const { dayId } = await rollJournal(owner, await journal(), date, date);
  const shared = await create(tasks, "Für alle");
  await setStatus(tasks, shared, "Erledigt");
  await doneAt(shared, `${date}T08:00:00Z`);
  // A private record of the owner.
  const mine = await create(tasks, "Nur meins");
  await act({ action: "row.access", pageId: tasks, rowId: mine, access: "private", grants: [] });
  await setStatus(tasks, mine, "Erledigt");
  await doneAt(mine, `${date}T09:00:00Z`);
  // A database in a private space.
  const secretSpace = (await act({ action: "space.create", workspaceId: wid, name: "Geheim", private: true })).id as string;
  const secret = await tasksDatabase("Geheime Aufgaben", secretSpace);
  const hidden = await create(secret, "Geheim erledigt");
  await setStatus(secret, hidden, "Erledigt");
  await doneAt(hidden, `${date}T10:00:00Z`);
  // A database below a journal with a PIN.
  const pinJournal = (await act({ action: "page.create", workspaceId: wid, spaceId: space, title: "Privat", kind: "journal" })).id as string;
  const pinned = await tasksDatabase("PIN-Aufgaben", space, pinJournal);
  const behindPin = await create(pinned, "Hinter der PIN");
  await setStatus(pinned, behindPin, "Erledigt");
  await doneAt(behindPin, `${date}T11:00:00Z`);
  // A deleted database.
  const gone = await tasksDatabase("Weg");
  const trashed = await create(gone, "Im Papierkorb");
  await setStatus(gone, trashed, "Erledigt");
  await doneAt(trashed, `${date}T12:00:00Z`);
  await act({ action: "page.delete", pageId: gone });

  assert.deepEqual(await titles(owner, date, "UTC"), ["Für alle", "Geheim erledigt", "Hinter der PIN", "Nur meins"]);
  await act({ action: "journal.lock", pageId: pinJournal, pin: "471108" });
  await act({ action: "journal.relock", pageId: pinJournal });
  assert.deepEqual(await titles(owner, date, "UTC"), ["Für alle", "Geheim erledigt", "Nur meins"]);
  assert.deepEqual((await journalDayCompleted(member, dayId, "UTC")).items.map((i) => i.title), ["Für alle"]);
  await act({ action: "journal.unlock", pageId: pinJournal, pin: "471108" }, member);
  assert.deepEqual(await titles(member, date, "UTC"), ["Für alle", "Hinter der PIN"]);
  // A guest with only the journal shared sees the day, but none of the databases.
  await run("INSERT INTO members VALUES(?,?,?)", wid, guest.id, "viewer");
  await run("INSERT INTO workspace_guests(workspace_id,user_id) VALUES(?,?)", wid, guest.id);
  await act({ action: "grant.set", resourceId: journalId, userId: guest.id, role: "viewer" });
  assert.deepEqual(await journalDayCompleted(guest, dayId, "UTC"), { items: [], more: 0 });
  // Somebody without access to the journal gets no list at all.
  const stranger = await account("stranger");
  await assert.rejects(async () => await journalDayCompleted(stranger, dayId, "UTC"));
});

test("switched off in the journal settings, the day lists nothing", async () => {
  const date = "2026-11-12";
  const { dayId } = await rollJournal(owner, await journal(), date, date);
  const row = await create(tasks, "Schalter");
  await setStatus(tasks, row, "Erledigt");
  await doneAt(row, `${date}T12:00:00Z`);
  const list = async () => (await journalDayCompleted(owner, dayId, "UTC")).items.map((i) => i.title);
  // On by default.
  assert.equal((await act({ action: "journal.settings", pageId: journalId })).options.completed, true);
  assert.deepEqual(await list(), ["Schalter"]);
  const off = await act({ action: "journal.settings", pageId: journalId, options: { completed: false } });
  assert.equal(off.options.completed, false);
  assert.equal(off.options.place, true, "other options stay");
  assert.deepEqual(await list(), []);
  await act({ action: "journal.settings", pageId: journalId, options: { completed: true } });
  assert.deepEqual(await list(), ["Schalter"]);
});
