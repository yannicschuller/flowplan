// A past day chosen in the journal's day picker (#288, journal.roll with
// `day`): opens the stored page, or creates it with the template and
// without carried tasks; days after today, days in the trash, readers and a
// journal behind its PIN are refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity, Page } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-journal-past-day-"));
const { run, id, one } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");
const { htmlState } = await import("../lib/document-server");
const { rollJournal } = await import("../lib/journal");

async function account(name: string) {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const owner = await account("Lena"),
  reader = await account("Rita");
const wid = await createWorkspace(owner.id, "Tagebuch");
await run("INSERT INTO members VALUES(?,?,?)", wid, reader.id, "viewer");
const space = (await bootstrap(owner, wid)).spaces[0].id;
const act = async (b: Record<string, unknown>, as = owner) => (await command(as, { workspaceId: wid, ...b })) as Record<string, unknown>;
const page = async (pageId: string) => (await one<Page>("SELECT * FROM pages WHERE id=?", pageId))!;
const html = async (pageId: string) => String((await one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", pageId))?.html || "");
const write = async (pageId: string, body: string) => await run("UPDATE documents SET state=?,html=? WHERE page_id=?", htmlState(body), body, pageId);
const shift = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
// The server's day, as the client sends it.
const today = new Date().toISOString().slice(0, 10);
const task = (text: string) => `<li data-type="taskItem" data-checked="false"><p>${text}</p></li>`;
const pick = async (journal: string, day: string, as = owner) => await act({ action: "journal.roll", pageId: journal, date: today, day }, as);

const journal = String((await act({ action: "page.create", spaceId: space, title: "Journal", kind: "journal" })).id);
await act({ action: "journal.settings", pageId: journal, template: "<h3>Fokus</h3><p></p>" });
// The newest day so far, five days ago, with an open task.
const older = (await rollJournal(owner, await page(journal), shift(today, -5), shift(today, -5))).dayId;
await write(older, `<p>Notiz</p><ul data-type="taskList">${task("Offen von früher")}</ul>`);

test("a past day without a page is created with the template and no carried tasks", async () => {
  const day = shift(today, -2);
  const result = await pick(journal, day);
  assert.equal(result.changed, true);
  const created = await page(String(result.dayId));
  assert.equal(created.parent_id, journal);
  assert.equal(created.journal_date, day);
  assert.equal(created.icon, "day");
  const body = await html(created.id);
  assert.match(body, /Fokus/, "the template");
  assert.doesNotMatch(body, /Offen von früher/, "no carried tasks");
  assert.match(await html(older), /Offen von früher/, "the open task stays where it was");
  // A day before every other one as well.
  const first = await pick(journal, shift(today, -30));
  assert.equal(first.changed, true);
  assert.doesNotMatch(await html(String(first.dayId)), /Offen von früher/);
});

test("an existing day is opened, not created again", async () => {
  const result = await pick(journal, shift(today, -5));
  assert.deepEqual(result, { dayId: older, changed: false });
  const again = await pick(journal, shift(today, -2));
  assert.equal(again.changed, false);
});

test("days after today and invalid dates are refused", async () => {
  await assert.rejects(pick(journal, shift(today, 1)), /künftiger Tag/);
  await assert.rejects(pick(journal, shift(today, 40)), /künftiger Tag/);
  await assert.rejects(pick(journal, "2026-02-30"));
  await assert.rejects(pick(journal, "gestern"));
  // A client day far from the server clock: refused like journal.roll.
  await assert.rejects(act({ action: "journal.roll", pageId: journal, date: shift(today, 10), day: shift(today, 9) }), /Serverzeit/);
  assert.equal(await one("SELECT 1 FROM pages WHERE parent_id=? AND journal_date>?", journal, today), undefined);
});

test("today goes the usual way, with carried tasks", async () => {
  const other = String((await act({ action: "page.create", spaceId: space, title: "Zweites", kind: "journal" })).id);
  const yesterday = (await rollJournal(owner, await page(other), shift(today, -1), shift(today, -1))).dayId;
  await write(yesterday, `<p>Gestern</p><ul data-type="taskList">${task("Weiter")}</ul>`);
  const result = await pick(other, today);
  assert.equal(result.changed, true);
  assert.match(await html(String(result.dayId)), /Weiter/);
});

test("a day in the trash stays there", async () => {
  const day = shift(today, -3);
  const result = await pick(journal, day);
  await act({ action: "page.delete", pageId: result.dayId });
  await assert.rejects(pick(journal, day), /Papierkorb/);
});

test("readers and a journal behind its PIN are refused", async () => {
  await assert.rejects(pick(journal, shift(today, -4), reader));
  const locked = String((await act({ action: "page.create", spaceId: space, title: "Privat", kind: "journal" })).id);
  await act({ action: "journal.lock", pageId: locked, pin: "246813" });
  await act({ action: "journal.relock", pageId: locked });
  await assert.rejects(pick(locked, shift(today, -4)), (e: { status?: number }) => e.status === 423);
  await act({ action: "journal.unlock", pageId: locked, pin: "246813" });
  assert.equal((await pick(locked, shift(today, -4))).changed, true);
});
