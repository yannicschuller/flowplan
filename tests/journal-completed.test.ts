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
const { completedOn, dayBounds, journalDayCompleted, completedMineChoice } = await import("../lib/journal-completed");
const { rowChanged } = await import("../lib/automations");
const { databaseSettings, storeSettings } = await import("../lib/database-settings");

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
  assert.deepEqual((await journalDayCompleted(member, dayId, "UTC", false)).items.map((i) => i.title), ["Für alle"]);
  await act({ action: "journal.unlock", pageId: pinJournal, pin: "471108" }, member);
  assert.deepEqual(await titles(member, date, "UTC"), ["Für alle", "Hinter der PIN"]);
  // A guest with only the journal shared sees the day, but none of the databases.
  await run("INSERT INTO members VALUES(?,?,?)", wid, guest.id, "viewer");
  await run("INSERT INTO workspace_guests(workspace_id,user_id) VALUES(?,?)", wid, guest.id);
  await act({ action: "grant.set", resourceId: journalId, userId: guest.id, role: "viewer" });
  assert.deepEqual(await journalDayCompleted(guest, dayId, "UTC", false), { items: [], more: 0, mine: false, all: 0 });
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

/* ---------- "Nur meine" (schema 96: who completed, person properties) ---------- */

// A team database: status, two person properties and a "ready" checkbox.
async function teamDatabase(title: string) {
  const pageId = (await act({ action: "page.create", workspaceId: wid, spaceId: space, kind: "database", title, databaseKind: "empty" })).id as string;
  await act({
    action: "database.update",
    pageId,
    version: (await database(pageId)).version,
    fields: [
      { id: "title", name: "Titel", type: "text" },
      { id: "status", name: "Status", type: "select", options: ["Offen", "Erledigt"] },
      { id: "who", name: "Zuständig", type: "person" },
      { id: "team", name: "Team", type: "person" },
      { id: "ready", name: "Bereit", type: "checkbox" },
    ],
    views: (await database(pageId)).views,
  });
  return pageId;
}
const team = await teamDatabase("Team");
const teamRow = async (title: string, cells: Record<string, unknown> = {}, as = owner) =>
  (await act({ action: "row.create", pageId: team, cells: { title, status: "Offen", ...cells } }, as)).id as string;
const logUser = async (rowId: string) =>
  (await one<{ user_id: string | null }>("SELECT user_id FROM row_status_log WHERE row_id=? ORDER BY at DESC LIMIT 1", rowId))!.user_id ?? null;
const listed = async (user: Identity, date: string, mine: boolean) =>
  (await completedOn(user, wid, date, "UTC", { mine })).items.map((i) => i.title).sort();
const cellsOf = async (rowId: string) => JSON.parse((await one<{ cells: string }>("SELECT cells FROM rows WHERE id=?", rowId))!.cells) as Record<string, unknown>;

test("the status log records who completed; mine: done by me or assigned to me", async () => {
  const date = "2026-11-20";
  // Done by the member, assigned to nobody.
  const byMember = await teamRow("Vom Mitglied", {}, member);
  await setStatus(team, byMember, "Erledigt", member);
  await doneAt(byMember, `${date}T08:00:00Z`);
  assert.equal(await logUser(byMember), member.id);
  // Assigned to the member, ticked off by the owner.
  const assigned = await teamRow("Dem Mitglied zugewiesen", { who: member.id });
  await setStatus(team, assigned, "Erledigt");
  await doneAt(assigned, `${date}T09:00:00Z`);
  assert.equal(await logUser(assigned), owner.id);
  // Among several people of a multi-person property.
  const together = await teamRow("Gemeinsam", { team: [owner.id, member.id] });
  await setStatus(team, together, "Erledigt");
  await doneAt(together, `${date}T10:00:00Z`);
  // Somebody else's, unassigned.
  const others = await teamRow("Vom Inhaber");
  await setStatus(team, others, "Erledigt");
  await doneAt(others, `${date}T11:00:00Z`);

  assert.deepEqual(await listed(member, date, true), ["Dem Mitglied zugewiesen", "Gemeinsam", "Vom Mitglied"]);
  assert.deepEqual(await listed(member, date, false), ["Dem Mitglied zugewiesen", "Gemeinsam", "Vom Inhaber", "Vom Mitglied"]);
  // The owner ticked off three of them; "Vom Mitglied" is not theirs.
  assert.deepEqual(await listed(owner, date, true), ["Dem Mitglied zugewiesen", "Gemeinsam", "Vom Inhaber"]);
  const list = await completedOn(member, wid, date, "UTC", { mine: true });
  assert.equal(list.mine, true);
  assert.equal(list.all, 4, "how many “Alle” would list");
  assert.equal(list.more, 0);
  // Reopened and done again by the owner: the latest change counts.
  await setStatus(team, byMember, "Offen");
  await movedLog(byMember, 0, `${date}T11:30:00Z`);
  await setStatus(team, byMember, "Erledigt");
  // The new entry, written now (before the test's day), moves to 12:00.
  await run("UPDATE row_status_log SET at=? WHERE row_id=? AND done=1 AND at<?", Date.parse(`${date}T12:00:00Z`), byMember, Date.parse(`${date}T00:00:00Z`));
  assert.equal(await logUser(byMember), owner.id);
  assert.deepEqual(await listed(member, date, true), ["Dem Mitglied zugewiesen", "Gemeinsam"]);
});

test("entries from before schema 96 have no user: mine only by the assignment", async () => {
  const date = "2026-11-21";
  const old = await teamRow("Alt, ohne Zuweisung", {}, member);
  await setStatus(team, old, "Erledigt", member);
  await doneAt(old, `${date}T08:00:00Z`);
  const oldAssigned = await teamRow("Alt, zugewiesen", { who: member.id }, member);
  await setStatus(team, oldAssigned, "Erledigt", member);
  await doneAt(oldAssigned, `${date}T09:00:00Z`);
  await run("UPDATE row_status_log SET user_id=NULL WHERE row_id IN (?,?)", old, oldAssigned);
  assert.deepEqual(await listed(member, date, true), ["Alt, zugewiesen"]);
  assert.deepEqual(await listed(member, date, false), ["Alt, ohne Zuweisung", "Alt, zugewiesen"]);
  assert.deepEqual(await listed(owner, date, true), []);
});

test("share links and the Git connection record nobody; an automation its creator", async () => {
  const date = "2026-11-22";
  const page = (await one<Page>("SELECT * FROM pages WHERE id=?", team))!;
  const fields = (await database(team)).fields;
  const complete = async (rowId: string, who: Identity | null | "system") => {
    const before = await cellsOf(rowId);
    const after = { ...before, status: "Erledigt" };
    await run("UPDATE rows SET cells=? WHERE id=?", JSON.stringify(after), rowId);
    await rowChanged(who, page, rowId, before, after, fields);
  };
  // Through a share link (no account) and through the Git connection.
  const viaShare = await teamRow("Per Freigabelink");
  await complete(viaShare, null);
  assert.equal(await logUser(viaShare), null);
  await doneAt(viaShare, `${date}T08:00:00Z`);
  const viaGit = await teamRow("Per Git");
  await complete(viaGit, "system");
  assert.equal(await logUser(viaGit), null);
  await doneAt(viaGit, `${date}T08:30:00Z`);
  // An automation the member set up: "Bereit" ticked → status done.
  await act(
    {
      action: "database.settings",
      pageId: team,
      settings: { automations: [{ id: "ready-done", trigger: { type: "changed", field: "ready", to: "true" }, actions: [{ type: "set", field: "status", value: "Erledigt" }] }] },
    },
    member,
  );
  assert.equal((await databaseSettings(team)).automations?.[0].createdBy, member.id);
  const viaRule = await teamRow("Per Regel");
  await act({ action: "row.update", pageId: team, rowId: viaRule, version: await version(viaRule), cells: { ready: true } });
  assert.equal((await cellsOf(viaRule)).status, "Erledigt");
  assert.equal(await logUser(viaRule), member.id, "the rule acts for the person who set it up");
  await doneAt(viaRule, `${date}T09:00:00Z`);
  // A rule nobody set up (stored before rules had a creator): nobody.
  const settings = await databaseSettings(team);
  await storeSettings(team, { ...settings, automations: settings.automations!.map(({ createdBy: _by, ...a }) => a) });
  const viaOldRule = await teamRow("Per alter Regel");
  await act({ action: "row.update", pageId: team, rowId: viaOldRule, version: await version(viaOldRule), cells: { ready: true } });
  assert.equal((await cellsOf(viaOldRule)).status, "Erledigt");
  assert.equal(await logUser(viaOldRule), null);
  await doneAt(viaOldRule, `${date}T10:00:00Z`);
  await storeSettings(team, { ...settings, automations: [] });

  assert.deepEqual(await listed(member, date, true), ["Per Regel"]);
  assert.deepEqual(await listed(owner, date, true), [], "the owner only ticked “Bereit”");
  assert.deepEqual(await listed(owner, date, false), ["Per Freigabelink", "Per Git", "Per Regel", "Per alter Regel"]);
  // An account that no longer exists: nobody.
  const gone = await account("gone");
  await run("DELETE FROM users WHERE id=?", gone.id);
  const viaGone = await teamRow("Vom gelöschten Konto");
  await complete(viaGone, gone);
  assert.equal(await logUser(viaGone), null);
});

test("the day follows the reader's choice “Alle / Nur meine”, “Nur meine” by default", async () => {
  const date = "2026-11-23";
  const { dayId } = await rollJournal(owner, await journal(), date, date);
  const mineToo = await teamRow("Meins auch", {}, member);
  await setStatus(team, mineToo, "Erledigt", member);
  await doneAt(mineToo, `${date}T08:00:00Z`);
  const notMine = await teamRow("Nicht meins");
  await setStatus(team, notMine, "Erledigt");
  await doneAt(notMine, `${date}T09:00:00Z`);
  const day = async (as: Identity, mine?: boolean) => {
    const r = await journalDayCompleted(as, dayId, "UTC", mine);
    return { mine: r.mine, all: r.all, titles: r.items.map((i) => i.title) };
  };
  assert.equal(await completedMineChoice(member, journalId), null);
  assert.deepEqual(await day(member), { mine: true, all: 2, titles: ["Meins auch"] });
  assert.deepEqual(await day(member, false), { mine: false, all: 2, titles: ["Meins auch", "Nicht meins"] });
  // Chosen "Alle": remembered for the member, the owner keeps the default.
  assert.deepEqual(await act({ action: "journal.completedMine", pageId: journalId, mine: false }, member), { mine: false });
  assert.equal(await completedMineChoice(member, journalId), false);
  assert.deepEqual(await day(member), { mine: false, all: 2, titles: ["Meins auch", "Nicht meins"] });
  assert.deepEqual(await day(owner), { mine: true, all: 2, titles: ["Nicht meins"] });
  // An explicit filter wins over the choice.
  assert.deepEqual((await day(member, true)).titles, ["Meins auch"]);
  await act({ action: "journal.completedMine", pageId: journalId, mine: true }, member);
  assert.deepEqual((await day(member)).titles, ["Meins auch"]);
  // Stored with the other view choices: the property bar does not touch it.
  await act({ action: "page.collapseProperties", pageId: journalId, collapsed: true }, member);
  assert.equal(await completedMineChoice(member, journalId), true);
  // Only for journals the person may open.
  await assert.rejects(async () => await act({ action: "journal.completedMine", pageId: team, mine: true }, member), /Kein Journal/);
  const stranger = await account("outsider");
  await assert.rejects(async () => await act({ action: "journal.completedMine", pageId: journalId, mine: true }, stranger));
});
