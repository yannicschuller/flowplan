import { nowText } from "../lib/db-driver/dialect";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import type { Identity, Page } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-journal-"));
const { run, id, one } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap, pageData } = await import("../lib/api");
const { htmlState } = await import("../lib/document-server");
const { rollJournal, dayTitle, hasOwnEntry } = await import("../lib/journal");
const { documentSchema } = await import("../lib/document-schema");
const { Node: PMNode } = await import("@tiptap/pm/model");
const { yDocToProsemirrorJSON } = await import("y-prosemirror");

const uid = id();
await run(
  "INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)",
  uid,
  uid,
  "Jana",
  "jana@example.test",
);
const user = {
  id: uid,
  name: "Jana",
  email: "jana@example.test",
  groups: [],
  isAdmin: false,
  disabled: 0,
  created_at: "",
} as Identity;
const wid = await createWorkspace(user.id, "Journal");
const space = (await bootstrap(user, wid)).spaces[0].id;
const journalId = (
  (await command(user, {
    action: "page.create",
    workspaceId: wid,
    spaceId: space,
    title: "Mein Journal",
    kind: "journal",
  })) as { id: string }
).id;
const journal = async () => (await one<Page>("SELECT * FROM pages WHERE id=?", journalId))!;
const roll = async (day: string) => await rollJournal(user, await journal(), day, day);
const days = async () =>
  ((await pageData(user, journalId)) as { journal: { days: { id: string; journal_date: string }[] } })
    .journal.days;
const html = async (pageId: string) =>
  String((await one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", pageId))!.html);
// Writes a document as a user would (a full Yjs state).
const write = async (pageId: string, body: string) =>
  await run(
    "UPDATE documents SET state=?,html=? WHERE page_id=?",
    htmlState(body),
    body,
    pageId,
  );
const task = (text: string, checked = false, since?: string) =>
  `<li data-type="taskItem" data-checked="${checked}"${since ? ` data-journal-since="${since}"` : ""}><p>${text}</p></li>`;
const tasks = (...items: string[]) => `<ul data-type="taskList">${items.join("")}</ul>`;

test("day titles are German and dates outside the server day are refused", async () => {
  assert.equal(dayTitle("2026-09-26"), "Samstag, 26. September 2026");
  await assert.rejects(
    async () => await rollJournal(user, await journal(), "2026-09-20", "2026-09-26"),
    /Serverzeit/,
  );
});

test("a new day gets its page once; open tasks move over, done ones stay", async () => {
  const first = await roll("2026-09-01");
  assert.equal(first.changed, true);
  assert.equal((await roll("2026-09-01")).changed, false, "same day: nothing new");
  const monday = first.dayId;
  const page = (await one<Page>("SELECT * FROM pages WHERE id=?", monday))!;
  assert.equal(page.title, "Dienstag, 1. September 2026");
  assert.equal(page.parent_id, journalId);
  assert.equal(page.journal_date, "2026-09-01");
  await write(
    monday,
    `<p>Heute viel geschafft</p>${tasks(task("Bericht schreiben"), task("Mails", true))}`,
  );
  const tuesday = (await roll("2026-09-02")).dayId;
  // Open task moved (not copied), done task and text stay on Monday.
  assert.match(await html(monday), /Heute viel geschafft/);
  assert.match(await html(monday), /Mails/);
  assert.doesNotMatch(await html(monday), /Bericht schreiben/);
  assert.match(await html(tuesday), /Bericht schreiben/);
  assert.match(await html(tuesday), /data-journal-since="2026-09-01"/);
  assert.doesNotMatch(await html(tuesday), /Mails/);
  // The stored Yjs state matches the html (editors load the state).
  const state = (await one<{ state: Uint8Array }>(
    "SELECT state FROM documents WHERE page_id=?",
    monday,
  ))!.state;
  const ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, state);
  assert.doesNotMatch(JSON.stringify(yDocToProsemirrorJSON(ydoc, "default")), /Bericht/);
  assert.deepEqual(
    (await days()).map((d) => d.journal_date),
    ["2026-09-02", "2026-09-01"],
  );
});

test("a day with only carried tasks goes to the trash; the tasks keep moving", async () => {
  const before = (await days())[0];
  assert.equal(before.journal_date, "2026-09-02");
  // Nobody wrote anything on the 2nd; two days later the journal is opened.
  const thursday = (await roll("2026-09-04")).dayId;
  const trashed = await one<Page>("SELECT * FROM pages WHERE id=?", before.id);
  assert.ok(trashed?.deleted_at);
  // Without the tasks that moved on: restoring it doubles nothing.
  assert.doesNotMatch(await html(before.id), /Bericht schreiben/);
  assert.deepEqual(
    (await days()).map((d) => d.journal_date),
    ["2026-09-04", "2026-09-01"],
  );
  // The task still remembers the day it was first written down.
  assert.match(await html(thursday), /Bericht schreiben/);
  assert.match(await html(thursday), /data-journal-since="2026-09-01"/);
});

test("new tasks, completed carried tasks and text all count as an entry", async () => {
  const schema = documentSchema();
  const docOf = (body: string) => {
    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, htmlState(body));
    return PMNode.fromJSON(schema, yDocToProsemirrorJSON(ydoc, "default"));
  };
  const day = "2026-09-04";
  assert.equal(hasOwnEntry(docOf(tasks(task("Alt", false, "2026-09-01"))), day), false);
  assert.equal(hasOwnEntry(docOf(`${tasks(task("Alt", false, "2026-09-01"))}<p> </p>`), day), false);
  assert.equal(hasOwnEntry(docOf(tasks(task("Alt", true, "2026-09-01"))), day), true);
  assert.equal(hasOwnEntry(docOf(tasks(task("Neu"))), day), true);
  assert.equal(hasOwnEntry(docOf("<p>Notiz</p>"), day), true);
  assert.equal(hasOwnEntry(docOf("<hr>"), day), true);
  // A completed carried task keeps its day; the open ones move on.
  const current = (await days())[0];
  await write(
    current.id,
    tasks(task("Bericht schreiben", true, "2026-09-01"), task("Anrufen", false, "2026-09-01")),
  );
  const friday = (await roll("2026-09-05")).dayId;
  assert.ok(await one("SELECT id FROM pages WHERE id=?", current.id));
  assert.match(await html(current.id), /Bericht schreiben/);
  assert.doesNotMatch(await html(current.id), /Anrufen/);
  assert.match(await html(friday), /Anrufen/);
});

test("the command rolls every journal of the workspace for today", async () => {
  const today = new Date().toISOString().slice(0, 10);
  const result = (await command(user, {
    action: "journal.roll",
    workspaceId: wid,
    date: today,
  })) as { changed: boolean };
  assert.equal(result.changed, true);
  assert.equal((await days())[0].journal_date, today);
  const again = (await command(user, {
    action: "journal.roll",
    workspaceId: wid,
    date: today,
  })) as { changed: boolean };
  assert.equal(again.changed, false);
  await assert.rejects(
    async () => await command(user, { action: "journal.roll", workspaceId: wid, date: "2026-02-30" }),
    /Datum/,
  );
});

test("a deleted day is reported and can be created anew", async () => {
  const day = "2026-11-02";
  const first = (await roll(day)).dayId;
  await run("UPDATE pages SET deleted_at=? WHERE id=?", nowText(), first);
  const again = (await rollJournal(user, await journal(), day, day)) as { dayId: string; changed: boolean; trashed?: boolean };
  assert.equal(again.trashed, true);
  assert.equal(again.dayId, first);
  const fresh = (await rollJournal(user, await journal(), day, day, true)) as { dayId: string; changed: boolean };
  assert.equal(fresh.changed, true);
  assert.notEqual(fresh.dayId, first);
  // The deleted page stays in the trash as an ordinary page.
  assert.equal((await one<{ journal_date: string | null }>("SELECT journal_date FROM pages WHERE id=?", first))!.journal_date, null);
});

test("an invalid journal date is a validation error, not a crash", async () => {
  const { journalDate } = await import("../lib/journal");
  for (const date of ["", "2026-13-45", "kein Datum"]) assert.equal(journalDate.safeParse(date).success, false, date);
  assert.equal(journalDate.safeParse("2028-02-29").success, true);
  await assert.rejects(
    async () => await command(user, { action: "journal.roll", pageId: journalId, date: "2026-13-45" }),
    (e: Error) => e.name === "ZodError",
  );
});

test("Titel des Tages: new days get the ISO date; existing and renamed days keep theirs (#560)", async () => {
  const isoId = (
    (await command(user, { action: "page.create", workspaceId: wid, spaceId: space, title: "ISO-Journal", kind: "journal" })) as { id: string }
  ).id;
  const rollIso = async (day: string) => (await rollJournal(user, (await one<Page>("SELECT * FROM pages WHERE id=?", isoId))!, day, day)).dayId;
  const page = async (pageId: string) => (await one<Page>("SELECT * FROM pages WHERE id=?", pageId))!;
  const setFormat = async (dayTitleFormat: string) =>
    await command(user, { action: "journal.settings", pageId: isoId, options: { dayTitleFormat } });
  // Long by default, as before.
  const long = await rollIso("2026-11-20");
  assert.equal((await page(long)).title, "Freitag, 20. November 2026");
  assert.equal((await bootstrap(user, wid)).journalDayTitle?.[isoId], undefined);
  await assert.rejects(async () => await setFormat("fancy"));
  await setFormat("iso");
  assert.equal((await bootstrap(user, wid)).journalDayTitle?.[isoId], "iso");
  const iso = await rollIso("2026-11-21");
  assert.equal((await page(iso)).title, "2026-11-21");
  // The earlier day kept its long title and still counts as untouched: empty, it went to the trash.
  assert.equal((await page(long)).title, "Freitag, 20. November 2026");
  assert.ok((await page(long)).deleted_at);
  // Back to long: the ISO-titled empty day is untouched, too.
  await setFormat("long");
  const sunday = await rollIso("2026-11-22");
  assert.equal((await page(sunday)).title, "Sonntag, 22. November 2026");
  assert.ok((await page(iso)).deleted_at);
  // A renamed day stays renamed and is kept.
  await setFormat("iso");
  await run("UPDATE pages SET title=? WHERE id=?", "Urlaub", sunday);
  const monday = await rollIso("2026-11-23");
  assert.equal((await page(monday)).title, "2026-11-23");
  assert.equal((await page(sunday)).title, "Urlaub");
  assert.equal((await page(sunday)).deleted_at, null);
});

test("Titel des Tages: the presets in every language, all count as automatic (#571)", async () => {
  const { DAY_TITLE_FORMATS, dayTitle: localTitle, isAutoDayTitle, automaticDayTitle, dayTitleFormatOf } = await import("../lib/journal-title");
  const { LOCALES } = await import("../lib/i18n");
  const date = "2026-11-26";
  const expected = {
    en: ["Thursday, 26 November 2026", "Thu, 26 Nov 2026", "2026-11-26", "2026-11-26 Thu", "Thu 2026-11-26"],
    de: ["Donnerstag, 26. November 2026", "Do., 26. Nov. 2026", "2026-11-26", "2026-11-26 Do.", "Do. 2026-11-26"],
  } as const;
  for (const [locale, titles] of Object.entries(expected))
    assert.deepEqual((["long", "short", "iso", "iso-weekday", "weekday-iso"] as const).map((format) => localTitle(date, locale as "en", format)), titles, locale);
  // Whatever the journal's choice now: every preset in every language is
  // untouched (spaces and capitals aside), and the export writes it in its
  // language in the same form.
  for (const format of DAY_TITLE_FORMATS.filter((f) => f !== "custom"))
    for (const locale of LOCALES) {
      const title = localTitle(date, locale, format);
      assert.ok(isAutoDayTitle(title, date), `${format} ${locale} ${title}`);
      assert.ok(automaticDayTitle(` ${title.toUpperCase()} `, date), `${format} ${locale} ${title}`);
      assert.ok(!isAutoDayTitle(title, "2026-11-27"), `${format} ${locale} for another day`);
      assert.equal(localTitle(date, locale, dayTitleFormatOf(title, date)!), title, `${format} ${locale} form`);
    }
  assert.equal(dayTitleFormatOf("2026-11-26 Thu", date), "iso-weekday");
  assert.equal(localTitle(date, "de", dayTitleFormatOf("Thu 2026-11-26", date)!), "Do. 2026-11-26");
  assert.equal(dayTitleFormatOf("Urlaub", date), null);
  assert.ok(!automaticDayTitle("Thu 2026-11-26 Urlaub", date));
});

test("Titel des Tages: a custom pattern of tokens, recognised as the journal stores it (#571)", async () => {
  const { dayTitle: localTitle, isAutoDayTitle, automaticDayTitle, validDayTitlePattern } = await import("../lib/journal-title");
  const date = "2026-03-05";
  const custom = (pattern: string, locale: "de" | "en" = "en") => localTitle(date, locale, "custom", pattern);
  assert.equal(custom("YYYY YY MMMM MMM MM M DD D dddd ddd"), "2026 26 March Mar 03 3 05 5 Thursday Thu");
  assert.equal(custom("dddd, D. MMMM YYYY", "de"), "Donnerstag, 5. März 2026");
  assert.equal(custom("ddd DD.MM.YYYY", "de"), "Do. 05.03.2026");
  assert.equal(custom("[Day] D [of] MMMM"), "Day 5 of March");
  assert.equal(custom("  YYYY-MM-DD (ddd)  "), "2026-03-05 (Thu)");
  // Literal letters that are tokens ("D" of "Day") are replaced – hence the brackets.
  assert.equal(custom("Day D"), "5ay 5");
  // Empty, without a token or too long: the long title.
  for (const pattern of ["", "   ", "[Journal D]", "Tagebuch", `YYYY${"x".repeat(61)}`]) {
    assert.ok(!validDayTitlePattern(pattern), pattern);
    assert.equal(custom(pattern), "Thursday, 5 March 2026", pattern);
  }
  // Recognised with the journal's pattern (in every language), not without it.
  const title = custom("ddd DD.MM.YYYY", "de");
  assert.ok(isAutoDayTitle(title, date, "ddd DD.MM.YYYY"));
  assert.ok(automaticDayTitle(custom("ddd DD.MM.YYYY", "en"), date, "ddd DD.MM.YYYY"));
  assert.ok(!isAutoDayTitle(title, date));
  assert.ok(!automaticDayTitle(title, date, "YYYY/MM/DD"));
});

test("Titel des Tages: new presets and a custom pattern for new days, offline too (#571)", async () => {
  const { emptyJournalDays } = await import("../lib/journal-days");
  const journalId = (
    (await command(user, { action: "page.create", workspaceId: wid, spaceId: space, title: "Muster-Journal", kind: "journal" })) as { id: string }
  ).id;
  const journal = async () => (await one<Page>("SELECT * FROM pages WHERE id=?", journalId))!;
  const roll = async (day: string) => (await rollJournal(user, await journal(), day, day)).dayId;
  const page = async (pageId: string) => (await one<Page>("SELECT * FROM pages WHERE id=?", pageId))!;
  const settings = async (options: Record<string, string>) => await command(user, { action: "journal.settings", pageId: journalId, options });
  // What the bootstrap sends for days written offline.
  const boot = async () => {
    const b = await bootstrap(user, wid);
    return [b.journalDayTitle?.[journalId], b.journalDayTitleCustom?.[journalId]];
  };
  assert.deepEqual(await boot(), [undefined, undefined]);
  await settings({ dayTitleFormat: "weekday-iso" });
  assert.deepEqual(await boot(), ["weekday-iso", undefined]);
  const friday = await roll("2026-11-20");
  assert.equal((await page(friday)).title, "Fr. 2026-11-20");
  await settings({ dayTitleFormat: "short" });
  assert.deepEqual(await boot(), ["short", undefined]);
  const saturday = await roll("2026-11-21");
  assert.equal((await page(saturday)).title, "Sa., 21. Nov. 2026");
  // The empty day before, titled in another preset, was untouched: trashed.
  assert.ok((await page(friday)).deleted_at);
  // A pattern longer than 64 characters is refused.
  await assert.rejects(async () => await settings({ dayTitleCustom: `YYYY${"x".repeat(61)}` }));
  await settings({ dayTitleFormat: "custom", dayTitleCustom: " ddd DD.MM.YYYY " });
  assert.deepEqual(await boot(), ["custom", "ddd DD.MM.YYYY"]);
  const sunday = await roll("2026-11-22");
  assert.equal((await page(sunday)).title, "So. 22.11.2026");
  assert.ok((await page(saturday)).deleted_at);
  const monday = await roll("2026-11-23");
  assert.equal((await page(monday)).title, "Mo. 23.11.2026");
  // Titled with the current pattern: untouched, trashed when the next day began.
  assert.ok((await page(sunday)).deleted_at);
  // After the pattern changes, a day with the old one counts as renamed.
  await settings({ dayTitleCustom: "YYYY/MM/DD" });
  const tuesday = await roll("2026-11-24");
  assert.equal((await page(tuesday)).title, "2026/11/24");
  assert.equal((await page(monday)).deleted_at, null);
  assert.ok(!(await emptyJournalDays(await journal(), "2026-11-26")).some((day) => day.id === monday));
  // Another form picked: the pattern stays stored, its days still untouched.
  await settings({ dayTitleFormat: "iso" });
  assert.deepEqual(await boot(), ["iso", "YYYY/MM/DD"]);
  const wednesday = await roll("2026-11-25");
  assert.equal((await page(wednesday)).title, "2026-11-25");
  assert.ok((await page(tuesday)).deleted_at);
  // A pattern without a token: new days get the long title.
  await settings({ dayTitleFormat: "custom", dayTitleCustom: "Tagebuch" });
  const thursday = await roll("2026-11-26");
  assert.equal((await page(thursday)).title, "Donnerstag, 26. November 2026");
  // Back to the default: nothing sent for days written offline, as before.
  await settings({ dayTitleFormat: "long", dayTitleCustom: "" });
  assert.deepEqual(await boot(), [undefined, undefined]);
});
