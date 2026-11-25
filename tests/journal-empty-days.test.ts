// The automatic tidying of empty journal days (lib/journal.ts rollJournal):
// a day with nothing of its own but something under "An diesem Tag
// erledigt" (tasks and records done that day elsewhere, as the person
// opening the journal sees the list) stays; a really empty day goes to the
// trash, never away for good, and comes back when its date is opened again.
// A day a person moved to the trash stays there.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity, Page } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-journal-empty-days-"));
const { id, run, one, all } = await import("../lib/db");
const { command, bootstrap, pageData } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { htmlState } = await import("../lib/document-server");
const { rollJournal, openJournalDay, ensureJournalDay } = await import("../lib/journal");

async function account(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@test.invalid`);
  return { id: uid, name, email: `${name}@test.invalid`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const lena = await account("Lena"),
  max = await account("Max");
const wid = await createWorkspace(lena.id, "Tagebuch");
await run("INSERT INTO members VALUES(?,?,?)", wid, max.id, "editor");
const space = (await bootstrap(lena, wid)).spaces[0].id;
const act = async (body: Record<string, unknown>, as = lena): Promise<any> => await command(as, { workspaceId: wid, ...body });
const BERLIN = "Europe/Berlin";

const pageOf = async (pid: string) => (await one<Page>("SELECT * FROM pages WHERE id=?", pid))!;
const html = async (pid: string) => String((await one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", pid))?.html || "");
const setHtml = async (pid: string, body: string) => await run("UPDATE documents SET state=?,html=? WHERE page_id=?", htmlState(body), body, pid);
// Written as the editor does (document.sync): ticking a task logs it for "An diesem Tag erledigt".
const sync = async (pid: string, body: string, as = lena) => {
  const generation = String((await one<{ generation: string }>("SELECT generation FROM documents WHERE page_id=?", pid))!.generation);
  await run("UPDATE documents SET state=NULL,html='' WHERE page_id=?", pid);
  await act({ action: "document.sync", pageId: pid, generation, update: Buffer.from(htmlState(body)).toString("base64") }, as);
};
const item = (text: string, checked = false) => `<li data-type="taskItem" data-checked="${checked}"><p>${text}</p></li>`;
const list = (...items: string[]) => `<ul data-type="taskList">${items.join("")}</ul>`;

let n = 0;
// A task in an ordinary page, ticked off by `as` at `iso`.
async function tickedElsewhere(iso: string, as = lena) {
  const text = `Erledigt woanders ${++n}`;
  const pid = (await act({ action: "page.create", spaceId: space, title: `Notizen ${n}`, kind: "document" })).id as string;
  await sync(pid, list(item(text)), as);
  await sync(pid, list(item(text, true)), as);
  const logged = await one<{ id: string }>("SELECT id FROM task_done_log WHERE page_id=?", pid);
  assert.ok(logged, "the tick is logged");
  await run("UPDATE task_done_log SET at=? WHERE id=?", Date.parse(iso), logged!.id);
}
// A journal whose newest day `date` holds only a task carried over from the day before.
async function journalWithCarriedDay(name: string, date: string) {
  const jid = (await act({ action: "page.create", spaceId: space, title: `Journal ${name}`, kind: "journal" })).id as string;
  const before = shift(date, -1);
  const first = (await rollJournal(lena, await pageOf(jid), before, before)).dayId;
  await setHtml(first, `<p>Notiz ${name}</p>${list(item(`Offen ${name}`))}`);
  const day = (await rollJournal(lena, await pageOf(jid), date, date)).dayId;
  assert.match(await html(day), new RegExp(`Offen ${name}`));
  return { jid, day };
}
const shift = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
// `zone` null: a client that sends none.
const roll = async (jid: string, date: string, zone: string | null = BERLIN, as = lena) =>
  await rollJournal(as, await pageOf(jid), date, date, false, { zone: zone ?? undefined });
const datesOf = async (jid: string) =>
  (await all<Page>("SELECT * FROM pages WHERE parent_id=? AND journal_date IS NOT NULL ORDER BY journal_date", jid)).map((d) => `${d.journal_date}${d.deleted_at ? " (trash)" : ""}`);

test("a day with only carried tasks but tasks done elsewhere that day stays", async () => {
  const { jid, day } = await journalWithCarriedDay("kept", "2026-08-11");
  await tickedElsewhere("2026-08-11T10:00:00Z");
  const next = (await roll(jid, "2026-08-12")).dayId;
  assert.deepEqual(await datesOf(jid), ["2026-08-10", "2026-08-11", "2026-08-12"]);
  // The open task moved on as usual and is no longer on the kept day.
  assert.doesNotMatch(await html(day), /Offen kept/);
  assert.match(await html(next), /Offen kept/);
});

test("a really empty day goes to the trash (restorable), without the tasks that moved on", async () => {
  const { jid, day } = await journalWithCarriedDay("empty", "2026-08-21");
  const next = (await roll(jid, "2026-08-22")).dayId;
  assert.deepEqual(await datesOf(jid), ["2026-08-20", "2026-08-21 (trash)", "2026-08-22"]);
  const trashed = await pageOf(day);
  assert.ok(trashed.deleted_at, "in the trash, not deleted for good");
  assert.equal(trashed.journal_date, "2026-08-21");
  assert.doesNotMatch(await html(day), /Offen empty/);
  assert.match(await html(next), /Offen empty/);
  // Not in the day list, in the trash of the workspace.
  const days = ((await pageData(lena, jid)) as { journal: { days: { id: string }[] } }).journal.days;
  assert.ok(!days.some((d) => d.id === day));
  assert.ok((await bootstrap(lena, wid)).pages.some((p) => p.id === day && p.deleted_at));
  // The next roll neither brings it back nor makes another one.
  await roll(jid, "2026-08-23");
  assert.deepEqual(await datesOf(jid), ["2026-08-20", "2026-08-21 (trash)", "2026-08-22 (trash)", "2026-08-23"]);
  // Restored from the trash it is a day again; its task is not doubled.
  await act({ action: "page.restore", pageId: day });
  assert.deepEqual(await datesOf(jid), ["2026-08-20", "2026-08-21", "2026-08-22 (trash)", "2026-08-23"]);
  const after = ((await pageData(lena, jid)) as { journal: { days: { id: string }[] } }).journal.days;
  assert.ok(after.some((d) => d.id === day));
  const tasks = await all("SELECT 1 FROM doc_tasks t JOIN pages p ON p.id=t.page_id WHERE p.parent_id=? AND p.deleted_at IS NULL AND t.text='Offen empty'", jid);
  assert.equal(tasks.length, 1);
});

test("opening the date of a day the journal put in the trash brings that day back, once", async () => {
  const { jid, day } = await journalWithCarriedDay("again", "2026-09-01");
  await roll(jid, "2026-09-02");
  assert.ok((await pageOf(day)).deleted_at);
  // The day picker (journal.roll with `day`).
  const today = new Date().toISOString().slice(0, 10);
  const picked = (await act({ action: "journal.roll", pageId: jid, date: today, zone: BERLIN, day: "2026-09-01" })) as { dayId: string; changed: boolean };
  assert.deepEqual([picked.dayId, picked.changed], [day, true]);
  assert.equal((await pageOf(day)).deleted_at, null);
  assert.deepEqual(await datesOf(jid), ["2026-08-31", "2026-09-01", "2026-09-02"]);
  const again = await openJournalDay(lena, await pageOf(jid), "2026-09-01", today);
  assert.deepEqual([again.dayId, again.changed], [day, false]);
  // A workflow appending to such a day ("An Journaltag anhängen") as well.
  await roll(jid, "2026-09-03");
  const d2 = (await all<Page>("SELECT * FROM pages WHERE parent_id=? AND journal_date='2026-09-02'", jid))[0];
  assert.ok(d2.deleted_at);
  const ensured = await ensureJournalDay(lena, await pageOf(jid), "2026-09-02", "2026-09-03");
  assert.deepEqual([ensured.dayId, ensured.created], [d2.id, true]);
  // Still empty, the day brought back by opening its date went again with
  // the next new day (#547: the days of the last week are judged again).
  assert.deepEqual(await datesOf(jid), ["2026-08-31", "2026-09-01 (trash)", "2026-09-02", "2026-09-03"]);
});

test("a day a person moved to the trash stays there, also one the journal had put there before", async () => {
  const { jid, day } = await journalWithCarriedDay("person", "2026-09-11");
  await roll(jid, "2026-09-12");
  // The roll was a while ago (deleted_at has whole seconds).
  await run("UPDATE pages SET deleted_at='2026-09-12 07:00:00' WHERE id=?", day);
  await run("UPDATE audit SET detail='2026-09-12 07:00:00' WHERE action='journal.dayTrashed' AND resource_id=?", day);
  await act({ action: "page.restore", pageId: day });
  await act({ action: "page.delete", pageId: day });
  const today = new Date().toISOString().slice(0, 10);
  await assert.rejects(act({ action: "journal.roll", pageId: jid, date: today, day: "2026-09-11" }), /Papierkorb/);
  await assert.rejects(ensureJournalDay(lena, await pageOf(jid), "2026-09-11", "2026-09-12"), /Papierkorb/);
  assert.deepEqual(await datesOf(jid), ["2026-09-10", "2026-09-11 (trash)", "2026-09-12"]);
});

test("“Nur meine” by default: someone else's ticks keep the day only for whoever chose “Alle”", async () => {
  const mine = await journalWithCarriedDay("mine", "2026-09-21");
  await tickedElsewhere("2026-09-21T09:00:00Z", max);
  await roll(mine.jid, "2026-09-22");
  assert.ok((await pageOf(mine.day)).deleted_at, "Lena's list (only hers) is empty");
  const everyone = await journalWithCarriedDay("all", "2026-09-21");
  await act({ action: "journal.completedMine", pageId: everyone.jid, mine: false });
  await roll(everyone.jid, "2026-09-22");
  assert.equal((await pageOf(everyone.day)).deleted_at, null, "Lena sees all ticks of the day");
});

test("the day in the person's time zone; without one, in any time zone; nothing when the list is switched off", async () => {
  // 23:30 UTC on 1 October is already the 2nd in Berlin.
  await tickedElsewhere("2026-10-01T23:30:00Z");
  const berlin = await journalWithCarriedDay("berlin", "2026-10-01");
  await roll(berlin.jid, "2026-10-02", BERLIN);
  assert.ok((await pageOf(berlin.day)).deleted_at);
  const utc = await journalWithCarriedDay("utc", "2026-10-01");
  await roll(utc.jid, "2026-10-02", "UTC");
  assert.equal((await pageOf(utc.day)).deleted_at, null);
  const unknown = await journalWithCarriedDay("unknown", "2026-10-01");
  await roll(unknown.jid, "2026-10-02", null);
  assert.equal((await pageOf(unknown.day)).deleted_at, null, "without a zone it rather stays");
  const off = await journalWithCarriedDay("off", "2026-10-01");
  await act({ action: "journal.settings", pageId: off.jid, options: { completed: false } });
  await roll(off.jid, "2026-10-02", "UTC");
  assert.ok((await pageOf(off.day)).deleted_at, "the journal does not show the list");
});
