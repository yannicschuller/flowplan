// Today's journal entry without a connection (#333): the list kept on the
// device (lib/journal-offline.ts), the command that creates the day once
// online and appends the text (journal.roll with `append`), and the
// commands that need the server (lib/offline-actions.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
import {
  offlineEntryById,
  offlineEntryCommand,
  offlineEntryFor,
  offlineEntryHasText,
  parseOfflineJournal,
  withOfflineEntry,
  withoutOfflineEntry,
  type OfflineJournalEntry,
} from "../lib/journal-offline";
import { needsServer, onlineOnlyActions } from "../lib/offline-actions";
import { queueableActions } from "../lib/offline-queue";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-journal-offline-"));
const { run, id, one, all } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");

const J = "11111111-2222-4333-8444-555555555555";
const entry = (over: Partial<OfflineJournalEntry> = {}): OfflineJournalEntry => ({
  id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  journalId: J,
  date: "2026-11-17",
  html: "<p>Offline</p>",
  key: "key-00000001",
  at: 1,
  ...over,
});

test("the list on the device: unreadable data counts as nothing, one entry per journal and day", () => {
  assert.deepEqual(parseOfflineJournal(null), []);
  assert.deepEqual(parseOfflineJournal("{nope"), []);
  assert.deepEqual(parseOfflineJournal(JSON.stringify({ id: 1 })), []);
  const good = entry();
  assert.deepEqual(parseOfflineJournal(JSON.stringify([good, { ...good, id: "x" }, { ...good, date: "17.11.2026" }])), [good]);
  const other = entry({ id: "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee", date: "2026-11-16" });
  let list = withOfflineEntry([good], other);
  assert.equal(list.length, 2);
  assert.equal(offlineEntryFor(list, J, "2026-11-16")?.id, other.id);
  assert.equal(offlineEntryById(list, good.id)?.date, "2026-11-17");
  // A new entry for the same day takes the old one's place.
  list = withOfflineEntry(list, { ...good, id: "cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee", html: "<p>Neu</p>" });
  assert.equal(list.length, 2);
  assert.equal(offlineEntryFor(list, J, "2026-11-17")?.html, "<p>Neu</p>");
  assert.deepEqual(withoutOfflineEntry(list, other.id).map((e) => e.date), ["2026-11-17"]);
});

test("only an entry with something in it creates a day", () => {
  assert.equal(offlineEntryHasText(""), false);
  assert.equal(offlineEntryHasText("<p></p>"), false);
  assert.equal(offlineEntryHasText("<p> &nbsp; </p>"), false);
  assert.equal(offlineEntryHasText("<p>Hallo</p>"), true);
  assert.equal(offlineEntryHasText('<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p></p></li></ul>'), true);
  assert.equal(offlineEntryHasText('<img src="/api/files/x">'), true);
});

test("today's entry is created as usual, an earlier one as the day picker does", () => {
  assert.deepEqual(offlineEntryCommand(entry(), "2026-11-17"), {
    action: "journal.roll",
    pageId: J,
    date: "2026-11-17",
    append: "<p>Offline</p>",
    write: true,
    recreate: true,
  });
  // Written before midnight, sent the next morning.
  assert.deepEqual(offlineEntryCommand(entry(), "2026-11-18"), {
    action: "journal.roll",
    pageId: J,
    date: "2026-11-18",
    append: "<p>Offline</p>",
    day: "2026-11-17",
  });
});

test("creating pages, spaces and imports needs the server; records stay queueable", () => {
  for (const action of ["page.create", "page.duplicate", "space.create", "collection.create", "form.submit"]) assert.ok(needsServer({ action }), action);
  for (const action of ["row.create", "row.update", "document.sync", "journal.roll", "capture.record"]) assert.equal(needsServer({ action }), false, action);
  for (const action of queueableActions) assert.equal(onlineOnlyActions.has(action), false, action);
});

async function person(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name.toLowerCase()}@example.test`);
  return { id: uid, name, email: `${name.toLowerCase()}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const owner = await person("Mira");
const wid = await createWorkspace(owner.id, "Offline");
const space = (await bootstrap(owner, wid)).spaces[0].id;
const act = async (b: Record<string, unknown>) => (await command(owner, { workspaceId: wid, ...b })) as Record<string, unknown>;
const html = async (pageId: string) => String((await one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", pageId))?.html || "");
// The server's day (journal.roll checks the client's date against it).
const today = new Date().toISOString().slice(0, 10);
const shift = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

for (const create of ["auto", "write"] as const)
  test(`the text written offline goes into the new day after its template (create: ${create})`, async () => {
    const journal = String((await act({ action: "page.create", spaceId: space, title: `Journal ${create}`, kind: "journal" })).id);
    await act({ action: "journal.settings", pageId: journal, template: "<h3>Vorlage</h3><p></p>", options: { create } });
    const local = entry({ journalId: journal, date: today, html: "<p>Im Zug geschrieben</p>" });
    const result = (await act(offlineEntryCommand(local, today))) as { dayId: string; changed: boolean };
    assert.equal(result.changed, true);
    const days = await all<{ id: string }>("SELECT id FROM pages WHERE parent_id=? AND journal_date=? AND deleted_at IS NULL", journal, today);
    assert.deepEqual(days.map((d) => d.id), [result.dayId]);
    const stored = await html(result.dayId);
    assert.match(stored, /Vorlage/);
    assert.match(stored, /Im Zug geschrieben/);
    assert.ok(stored.indexOf("Vorlage") < stored.indexOf("Im Zug geschrieben"), "appended after the template");
    // A second entry for the same day (another device) is added to it.
    await act(offlineEntryCommand({ ...local, html: "<p>Noch etwas</p>" }, today));
    assert.match(await html(result.dayId), /Im Zug geschrieben.*Noch etwas/s);
    assert.equal((await all("SELECT id FROM pages WHERE parent_id=? AND journal_date=?", journal, today)).length, 1);
  });

test("an entry written yesterday goes into yesterday's page; an empty one adds nothing", async () => {
  const journal = String((await act({ action: "page.create", spaceId: space, title: "Gestern-Journal", kind: "journal" })).id);
  const yesterday = shift(today, -1);
  const result = (await act(offlineEntryCommand(entry({ journalId: journal, date: yesterday, html: "<p>Abends</p>" }), today))) as { dayId: string };
  assert.equal((await one<{ journal_date: string }>("SELECT journal_date FROM pages WHERE id=?", result.dayId))?.journal_date, yesterday);
  assert.match(await html(result.dayId), /Abends/);
  const before = await html(result.dayId);
  await act(offlineEntryCommand(entry({ journalId: journal, date: yesterday, html: "<p></p>" }), today));
  assert.equal(await html(result.dayId), before);
  // Too long for one request.
  await assert.rejects(act(offlineEntryCommand(entry({ journalId: journal, date: yesterday, html: `<p>${"x".repeat(1_000_001)}</p>` }), today)));
});
