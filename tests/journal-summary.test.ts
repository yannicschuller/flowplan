import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity, Page } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-journal-summary-"));
const { run, id, one } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");
const { rollJournal } = await import("../lib/journal");
const { journalSettings } = await import("../lib/journal-extras");
const { existingSummary } = await import("../lib/journal-summary");

// "Tage in der Seitenleiste" and the month summary of a journal (#49).
const person = (name: string) => {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${uid}@example.test`);
  return { id: uid, name, email: `${uid}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
};
const user = person("Jana");
const wid = createWorkspace(user.id, "Journal");
const space = bootstrap(user, wid).spaces[0].id;
const journalId = (
  command(user, { action: "page.create", workspaceId: wid, spaceId: space, title: "Mein Journal", kind: "journal" }) as { id: string }
).id;
const journal = () => one<Page>("SELECT * FROM pages WHERE id=?", journalId)!;
const write = (pageId: string, html: string) => run("UPDATE documents SET state=NULL,html=? WHERE page_id=?", html, pageId);
const html = (pageId: string) => String(one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", pageId)!.html);
const tasks = (...items: [string, boolean][]) =>
  `<ul data-type="taskList">${items.map(([text, done]) => `<li data-type="taskItem" data-checked="${done}"><p>${text}</p></li>`).join("")}</ul>`;

test("the sidebar setting: recent by default, stored with the journal's options, sent with the bootstrap", () => {
  assert.equal(journalSettings(journalId).options.sidebar, "recent");
  assert.deepEqual(bootstrap(user, wid).journalSidebar, {});
  const result = command(user, { action: "journal.settings", pageId: journalId, options: { sidebar: "grouped" } }) as {
    options: { sidebar: string; place: boolean; events: boolean; create: string };
  };
  assert.deepEqual(result.options, { place: true, events: true, create: "auto", sidebar: "grouped" });
  assert.deepEqual(bootstrap(user, wid).journalSidebar, { [journalId]: "grouped" });
  // Other options keep it.
  command(user, { action: "journal.settings", pageId: journalId, options: { place: false } });
  assert.equal(journalSettings(journalId).options.sidebar, "grouped");
  assert.throws(() => command(user, { action: "journal.settings", pageId: journalId, options: { sidebar: "everything" } }));
  assert.equal(journalSettings(journalId).options.sidebar, "grouped");
  command(user, { action: "journal.settings", pageId: journalId, options: { sidebar: "recent", place: true } });
  assert.deepEqual(bootstrap(user, wid).journalSidebar, {});
});

test("a month summary: numbers, highlights, open tasks and links to the days – once", () => {
  const first = rollJournal(user, journal(), "2026-09-29", "2026-09-29").dayId;
  write(first, `<p>Umzug geplant und Kisten gepackt.</p>${tasks(["Kisten besorgen", true], ["Strom ummelden", false])}`);
  command(user, { action: "journal.entry", pageId: first, entry: { values: { mood: 4 }, place: "Leipzig" } });
  const second = rollJournal(user, journal(), "2026-09-30", "2026-09-30").dayId;
  write(second, `<p>Erster Abend in der neuen Wohnung.</p>${tasks(["Strom ummelden", false], ["Lampen aufhängen", true])}`);
  const october = rollJournal(user, journal(), "2026-10-01", "2026-10-01").dayId;
  // The open task moved on to 1 October; something written there too.
  write(october, `${html(october)}<p>Oktober</p>`);

  const created = command(user, { action: "journal.summary", pageId: journalId, month: "2026-09" }) as { id: string; existing: boolean };
  assert.equal(created.existing, false);
  const page = one<Page>("SELECT * FROM pages WHERE id=?", created.id)!;
  // A normal sub page of the journal, not a day.
  assert.equal(page.parent_id, journalId);
  assert.equal(page.journal_date, null);
  assert.equal(page.kind, "document");
  assert.equal(page.title, "Monatszusammenfassung September 2026");
  const body = html(created.id);
  assert.match(body, /2 Tage/);
  assert.match(body, /2 erledigt/);
  assert.match(body, /Höhepunkte/);
  assert.match(body, /Stimmung:<\/strong> Ø 🙂 4/);
  assert.match(body, /Leipzig/);
  assert.match(body, /Kisten besorgen/);
  assert.match(body, /Lampen aufhängen/);
  // Still open: it moved on to 1 October, written down on 30 September; as
  // text (no second task item), linked to the day it is on now.
  assert.match(body, /1 noch offen/);
  assert.match(body, /Noch offen<\/h2><ul><li><p>Strom ummelden · seit Mi\., 30\. September · <a href="\/#page=([^"]+)">/);
  assert.equal(body.match(/Strom ummelden · seit [^<]+<a href="\/#page=([^"]+)"/)![1], october);
  assert.doesNotMatch(body, /data-type="taskItem"/);
  // Every day linked, with the start of its text; October stays out.
  assert.ok(body.includes(`href="/#page=${first}"`));
  assert.ok(body.includes(`href="/#page=${second}"`));
  assert.doesNotMatch(body, new RegExp(`<a href="/#page=${october}">[^<]*</a> – Oktober`));
  assert.match(body, /Erster Abend in der neuen Wohnung/);

  // Asked again: the existing page, nothing new.
  const count = () => Number(one<{ n: number }>("SELECT COUNT(*) n FROM pages WHERE parent_id=? AND journal_date IS NULL", journalId)!.n);
  const before = count();
  assert.deepEqual(command(user, { action: "journal.summary", pageId: journalId, month: "2026-09" }), { id: created.id, existing: true });
  assert.equal(count(), before);
  assert.equal(existingSummary(user, journal(), "2026-09"), created.id);
  assert.equal(existingSummary(user, journal(), "2026-08"), null);
  // On purpose a fresh one; the new one is remembered.
  const again = command(user, { action: "journal.summary", pageId: journalId, month: "2026-09", again: true }) as { id: string; existing: boolean };
  assert.equal(again.existing, false);
  assert.notEqual(again.id, created.id);
  assert.equal(existingSummary(user, journal(), "2026-09"), again.id);
  // In the trash: a new one may be made.
  command(user, { action: "page.delete", pageId: again.id });
  assert.equal(existingSummary(user, journal(), "2026-09"), null);
  assert.equal((command(user, { action: "journal.summary", pageId: journalId, month: "2026-09" }) as { existing: boolean }).existing, false);
});

test("a month without days, wrong input, readers", () => {
  const empty = command(user, { action: "journal.summary", pageId: journalId, month: "2026-07" }) as { id: string };
  assert.match(html(empty.id), /keine Einträge/);
  assert.throws(() => command(user, { action: "journal.summary", pageId: journalId, month: "2026-13" }));
  const day = one<{ id: string }>("SELECT id FROM pages WHERE parent_id=? AND journal_date IS NOT NULL LIMIT 1", journalId)!.id;
  assert.throws(() => command(user, { action: "journal.summary", pageId: day, month: "2026-09" }), /kein Journal/);
  const reader = person("Rita");
  run("INSERT INTO members(workspace_id,user_id,role) VALUES(?,?,'viewer')", wid, reader.id);
  assert.throws(() => command(reader, { action: "journal.summary", pageId: journalId, month: "2026-09" }));
});
