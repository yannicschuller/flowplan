// Journal days that do not flood lists (#49): days created on the first
// write (drafts), the template a day was created from, "Leere Tage
// entfernen", "@heute" links, search ranking, the graph and the counts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import type { Identity, Page } from "../lib/types";
import { mapAsync } from "../lib/each-async";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-journal-days-"));
const { run, id, one, all } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap, pageData } = await import("../lib/api");
const { htmlState, stateHtml } = await import("../lib/document-server");
const { rollJournal, rollJournals } = await import("../lib/journal");
const { journalDraftPage, journalDayLink, emptyJournalDays, removeEmptyJournalDays, pageCounts, dayTemplateHtml } = await import(
  "../lib/journal-days"
);
const { searchWorkspace } = await import("../lib/search-index");
const { pageGraph } = await import("../lib/page-graph");
const { journalDayQuery } = await import("../lib/journal-links");

async function person(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name.toLowerCase()}@example.test`);
  return { id: uid, name, email: `${name.toLowerCase()}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const owner = await person("Lena");
const wid = await createWorkspace(owner.id, "Tagebuch");
const space = (await bootstrap(owner, wid)).spaces[0].id;
const act = async (b: Record<string, unknown>, who = owner) => (await command(who, { workspaceId: wid, ...b })) as Record<string, unknown>;
const cmd = async (b: Record<string, unknown>) => (await command(owner, b)) as { id: string };
const createJournal = async (title: string, spaceId = space) => String((await act({ action: "page.create", spaceId, title, kind: "journal" })).id);
const page = async (pageId: string) => (await one<Page>("SELECT * FROM pages WHERE id=?", pageId))!;
const html = async (pageId: string) => String((await one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", pageId))?.html || "");
const write = async (pageId: string, body: string) => await run("UPDATE documents SET state=?,html=? WHERE page_id=?", htmlState(body), body, pageId);
const task = (text: string, checked = false, since?: string) =>
  `<li data-type="taskItem" data-checked="${checked}"${since ? ` data-journal-since="${since}"` : ""}><p>${text}</p></li>`;
const tasks = (...items: string[]) => `<ul data-type="taskList">${items.join("")}</ul>`;
const dayOf = async (journalId: string, date: string) =>
  await one<Page>("SELECT * FROM pages WHERE parent_id=? AND journal_date=? AND deleted_at IS NULL", journalId, date);
const roll = async (journalId: string, date: string, options: { write?: boolean } = {}) =>
  await rollJournal(owner, await page(journalId), date, date, false, options);
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

test("a journal set to 'beim ersten Schreiben' shows a draft and creates the day only on the first write", async () => {
  const journal = await createJournal("Entwurfsjournal");
  // Automatic is the default: nothing changes for existing journals.
  assert.equal(((await pageData(owner, journal)) as { journal: { settings: { options: { create: string } } } }).journal.settings.options.create, "auto");
  await act({ action: "journal.settings", pageId: journal, template: "<h3>Heute</h3><p></p>" });
  const monday = (await roll(journal, "2026-10-26")).dayId;
  await write(monday, `<h3>Heute</h3>${tasks(task("Steuer"), task("Joggen", true))}`);
  await act({ action: "journal.settings", pageId: journal, options: { create: "write" } });

  // Opening today: a draft id, no page, the open task still on Monday.
  const first = await roll(journal, "2026-10-27");
  assert.equal(first.draft, true);
  assert.equal(first.changed, false);
  assert.equal(await dayOf(journal, "2026-10-27"), undefined);
  assert.equal((await roll(journal, "2026-10-27")).dayId, first.dayId, "the same draft for every device");
  assert.match(await html(monday), /Steuer/);
  // Nothing in tree, search or bootstrap.
  assert.ok(!(await bootstrap(owner, wid)).pages.some((p) => p.id === first.dayId));

  // The draft as a page: template plus carried task, not stored.
  const draft = await journalDraftPage(owner, first.dayId, "2026-10-27");
  assert.ok(draft && "data" in draft);
  const data = draft.data as { page: Page; state: string; generation: string; draft: { journalId: string; date: string } };
  assert.equal(data.page.journal_date, "2026-10-27");
  assert.deepEqual(data.draft, { journalId: journal, date: "2026-10-27" });
  const local = new Y.Doc();
  Y.applyUpdate(local, Buffer.from(data.state, "base64"));
  const shown = stateHtml(local);
  assert.match(shown, /Steuer/);
  assert.match(shown, /Heute/);
  assert.doesNotMatch(shown, /Joggen/, "done tasks stay where they were done");

  // The person types in the draft (a change of their own on top of it).
  const typed = new Y.Doc();
  Y.applyUpdate(typed, Buffer.from(data.state, "base64"));
  const paragraph = new Y.XmlElement("paragraph");
  paragraph.insert(0, [new Y.XmlText("Erster Gedanke")]);
  typed.getXmlFragment("default").push([paragraph]);

  // Two devices start writing at once: exactly one day, under the draft's id.
  const a = await roll(journal, "2026-10-27", { write: true });
  const b = await roll(journal, "2026-10-27", { write: true });
  assert.equal(a.dayId, first.dayId);
  assert.equal(b.dayId, first.dayId);
  assert.equal(a.changed, true);
  assert.equal(b.changed, false);
  assert.equal(a.generation, data.generation, "the stored day is exactly the draft");
  assert.equal(b.generation, data.generation);
  assert.equal((await all("SELECT id FROM pages WHERE parent_id=? AND journal_date='2026-10-27'", journal)).length, 1);
  // The carried task moved now – not before.
  assert.doesNotMatch(await html(monday), /Steuer/);
  // What was typed merges without doubling the template.
  await act({ action: "document.sync", pageId: first.dayId, generation: data.generation, update: b64(Y.encodeStateAsUpdate(typed)) });
  const stored = await html(first.dayId);
  assert.match(stored, /Erster Gedanke/);
  assert.equal(stored.match(/Steuer/g)?.length, 1);
  assert.equal(stored.match(/<h3>Heute<\/h3>/g)?.length, 1);
  // The draft link now opens the day itself.
  assert.deepEqual(await journalDraftPage(owner, first.dayId, "2026-10-27"), null, "the page exists, no draft any more");
});

test("a draft whose start changed meanwhile is not merged into the day", async () => {
  const journal = await createJournal("Zweites Journal");
  await act({ action: "journal.settings", pageId: journal, options: { create: "write" } });
  const yesterday = (await rollJournal(owner, await page(journal), "2026-10-26", "2026-10-26", false, { write: true })).dayId;
  await write(yesterday, tasks(task("Anrufen")));
  const draft = await roll(journal, "2026-10-27");
  const before = ((await journalDraftPage(owner, draft.dayId, "2026-10-27")) as { data: { generation: string } }).data.generation;
  // Another device ticks yesterday's task before today is written.
  await write(yesterday, tasks(task("Anrufen", true)));
  const created = await roll(journal, "2026-10-27", { write: true });
  assert.equal(created.dayId, draft.dayId);
  assert.notEqual(created.generation, before, "the client sees another generation and opens the stored day");
});

test("trackers, entries from widgets and the trash keep working with drafts", async () => {
  const journal = await createJournal("Tracker-Journal");
  await act({ action: "journal.settings", pageId: journal, options: { create: "write" } });
  // The app's roll for all journals (on opening, at midnight) leaves a draft
  // journal alone.
  const today = new Date().toISOString().slice(0, 10);
  await rollJournals(owner, wid, today);
  assert.equal((await all("SELECT id FROM pages WHERE parent_id=?", journal)).length, 0);
  const created = await roll(journal, "2026-10-27", { write: true });
  await act({ action: "journal.entry", pageId: created.dayId, entry: { values: { mood: 4 } } });
  assert.equal((await page(created.dayId)).journal_date, "2026-10-27");
  // Today's page in the trash: reported, and recreated as a draft.
  await act({ action: "page.delete", pageId: created.dayId });
  const trashed = await roll(journal, "2026-10-27");
  assert.equal(trashed.trashed, true);
  const again = await rollJournal(owner, await page(journal), "2026-10-27", "2026-10-27", true);
  assert.equal(again.draft, true);
  assert.equal(await dayOf(journal, "2026-10-27"), undefined);
});

test("each day remembers the template it was created from", async () => {
  const journal = await createJournal("Vorlagenjournal");
  await act({ action: "journal.settings", pageId: journal, template: "<h3>Morgens</h3><p></p>" });
  const first = (await roll(journal, "2026-10-20")).dayId;
  assert.match(String(await dayTemplateHtml(first)), /Morgens/);
  // The template changes; the untouched day still counts as empty …
  await act({ action: "journal.settings", pageId: journal, template: "<h3>Abends</h3><p></p>" });
  const second = (await roll(journal, "2026-10-21")).dayId;
  assert.match(String(await dayTemplateHtml(second)), /Abends/);
  // … so it was removed when the next day came.
  assert.equal(await one("SELECT 1 FROM pages WHERE id=?", first), undefined);
  // A day without a template remembers that too.
  await act({ action: "journal.settings", pageId: journal, template: "" });
  const third = (await roll(journal, "2026-10-22")).dayId;
  assert.equal(await dayTemplateHtml(third), "");
});

test("'Leere Tage entfernen' previews conservatively and moves only those days to the trash", async () => {
  const journal = await createJournal("Aufräumjournal");
  await act({ action: "journal.settings", pageId: journal, template: "<h3>Notizen</h3><p></p>" });
  const at = async (date: string) => {
    const dayId = id();
    await run(
      "INSERT INTO pages(id,workspace_id,space_id,parent_id,title,kind,created_by,position,icon,journal_date) VALUES(?,?,?,?,?,'document',?,?,'day',?)",
      dayId,
      wid,
      space,
      journal,
      new Intl.DateTimeFormat("de-DE", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`)),
      owner.id,
      -Number(date.replaceAll("-", "")),
      date,
    );
    await run("INSERT INTO documents(page_id,html,state) VALUES(?,?,?)", dayId, "<h3>Notizen</h3><p></p>", htmlState("<h3>Notizen</h3><p></p>"));
    return dayId;
  };
  const empty = await at("2026-09-01");
  const blank = await at("2026-09-02");
  await write(blank, "<p></p>");
  const written = await at("2026-09-03");
  await write(written, "<h3>Notizen</h3><p>Am See gewesen.</p>");
  const tracked = await at("2026-09-04");
  await act({ action: "journal.entry", pageId: tracked, entry: { values: { mood: 3 } } });
  const linked = await at("2026-09-05");
  const other = String((await act({ action: "page.create", spaceId: space, title: "Verweis" })).id);
  await write(other, `<p><a href="/#page=${linked}">Tag</a></p>`);
  const renamed = await at("2026-09-06");
  await run("UPDATE pages SET title='Urlaubsbeginn' WHERE id=?", renamed);
  const trivially = await at("2026-09-07");
  await run("UPDATE pages SET title=lower(title) || '  ' WHERE id=?", trivially);
  const commented = await at("2026-09-08");
  await act({ action: "comment.create", pageId: commented, body: "Notiz" });
  const openTask = await at("2026-09-09");
  await write(openTask, `<h3>Notizen</h3>${tasks(task("Offen", false, "2026-09-01"))}`);
  const today = await at("2026-10-27");

  const preview = (await emptyJournalDays(await page(journal), "2026-10-27")).map((d) => d.id);
  assert.deepEqual(new Set(preview), new Set([empty, blank, trivially]));
  assert.ok(!preview.includes(today), "today always stays");
  // Viewers may not, and only chosen days that are still empty go.
  const viewer = await person("Vera");
  await run("INSERT INTO members(workspace_id,user_id,role) VALUES(?,?,'viewer')", wid, viewer.id);
  await assert.rejects(async () => await act({ action: "journal.removeEmpty", pageId: journal, dayIds: preview, today: "2026-10-27" }, viewer), /Berechtigung/);
  await write(blank, "<p>Doch etwas.</p>");
  const result = (await act({ action: "journal.removeEmpty", pageId: journal, dayIds: [...preview, written], today: "2026-10-27" })) as { removed: number };
  assert.equal(result.removed, 2);
  assert.ok((await page(empty)).deleted_at, "in the trash …");
  assert.ok((await page(trivially)).deleted_at);
  assert.equal((await page(blank)).deleted_at, null);
  assert.equal((await page(written)).deleted_at, null);
  // … and back from it.
  await act({ action: "page.restore", pageId: empty });
  assert.equal((await page(empty)).deleted_at, null);
  assert.equal((await page(empty)).journal_date, "2026-09-01");
});

test("@heute, @gestern and @2026-10-27 link to the journal's day", async () => {
  assert.deepEqual(journalDayQuery("heu", "2026-10-27", "2026-10-26"), { label: "today", date: "2026-10-27" });
  assert.deepEqual(journalDayQuery("@today", "2026-10-27", "2026-10-26"), { label: "today", date: "2026-10-27" });
  assert.deepEqual(journalDayQuery("Gestern", "2026-10-27", "2026-10-26"), { label: "yesterday", date: "2026-10-26" });
  assert.deepEqual(journalDayQuery("2026-10-27"), { label: "date", date: "2026-10-27" });
  assert.equal(journalDayQuery("2026-02-30"), null);
  assert.equal(journalDayQuery("h"), null);

  const ws = await createWorkspace(owner.id, "Verlinkt");
  const spaces = (await bootstrap(owner, ws)).spaces;
  const other = String((await cmd({ action: "space.create", workspaceId: ws, name: "Privat" })).id);
  const mainJournal = String((await cmd({ action: "page.create", workspaceId: ws, spaceId: spaces[0].id, title: "Team-Journal", kind: "journal" })).id);
  const privateJournal = String((await cmd({ action: "page.create", workspaceId: ws, spaceId: other, title: "Mein Journal", kind: "journal" })).id);
  const note = String((await cmd({ action: "page.create", workspaceId: ws, spaceId: other, title: "Notiz" })).id);
  await rollJournal(owner, await page(mainJournal), "2026-10-26", "2026-10-26");
  const yesterday = (await rollJournal(owner, await page(privateJournal), "2026-10-26", "2026-10-26")).dayId;
  await write(yesterday, "<p>Gestern.</p>");
  // From a page in the private space: that space's journal.
  const link = await journalDayLink(owner, ws, { date: "2026-10-26", today: "2026-10-27", fromPageId: note }, "2026-10-27");
  assert.equal(link.dayId, yesterday);
  assert.equal(link.journalId, privateJournal);
  assert.equal(link.title, "Montag, 26. Oktober 2026");
  // Today follows "open the day": created (automatic) …
  const today = await journalDayLink(owner, ws, { date: "2026-10-27", today: "2026-10-27", fromPageId: note }, "2026-10-27");
  assert.equal(today.draft, false);
  assert.equal((await dayOf(privateJournal, "2026-10-27"))?.id, today.dayId);
  // … or the draft (beim ersten Schreiben), which opens like a page.
  await command(owner, { action: "journal.settings", pageId: privateJournal, options: { create: "write" } });
  await run("DELETE FROM pages WHERE id=?", today.dayId);
  const draft = await journalDayLink(owner, ws, { date: "2026-10-27", today: "2026-10-27", fromPageId: note }, "2026-10-27");
  assert.equal(draft.draft, true);
  assert.equal(await dayOf(privateJournal, "2026-10-27"), undefined);
  // A day without an entry is no link.
  await assert.rejects(async () => await journalDayLink(owner, ws, { date: "2026-01-01", today: "2026-10-27", fromPageId: note }, "2026-10-27"), /keinen Eintrag/);
  // A journal behind a PIN is never chosen.
  await command(owner, { action: "journal.lock", pageId: privateJournal, pin: "123456" });
  await command(owner, { action: "journal.relock", pageId: privateJournal });
  const fallback = await journalDayLink(owner, ws, { date: "2026-10-26", today: "2026-10-27", fromPageId: note }, "2026-10-27");
  assert.equal(fallback.journalId, mainJournal);
});

test("search ranks journal days after other pages, can leave them out and never shows locked days", async () => {
  const ws = await createWorkspace(owner.id, "Suche");
  const sp = (await bootstrap(owner, ws)).spaces[0].id;
  const journal = String((await cmd({ action: "page.create", workspaceId: ws, spaceId: sp, title: "Logbuch", kind: "journal" })).id);
  for (const date of ["2026-10-20", "2026-10-21", "2026-10-22"]) {
    const day = (await rollJournal(owner, await page(journal), date, date)).dayId;
    await write(day, "<p>Sitzung mit dem Kirschbaumverein und viel Kirschbaum.</p>");
  }
  const plain = String((await cmd({ action: "page.create", workspaceId: ws, spaceId: sp, title: "Protokoll" })).id);
  await write(plain, "<p>Kirschbaumverein</p>");
  const hits = await searchWorkspace(owner, ws, "Kirschbaumverein");
  assert.equal(hits[0].id, plain, "the page before the days");
  assert.equal(hits.filter((h) => h.journalDate).length, 3);
  assert.ok(hits.slice(1).every((h) => h.journalDate));
  const without = await searchWorkspace(owner, ws, "Kirschbaumverein", { excludeDays: true });
  assert.deepEqual(without.map((h) => h.id), [plain]);
  // Empty query (recent pages): days last too.
  const recent = await searchWorkspace(owner, ws, "");
  const firstDay = recent.findIndex((h) => h.journalDate);
  assert.ok(firstDay > 0 && recent.slice(firstDay).every((h) => h.journalDate));
  await command(owner, { action: "journal.lock", pageId: journal, pin: "123456" });
  await command(owner, { action: "journal.relock", pageId: journal });
  assert.equal((await searchWorkspace(owner, ws, "Kirschbaumverein")).filter((h) => h.journalDate).length, 0);
});

test("the graph hides journal days, shows one dot per month or each day", async () => {
  const ws = await createWorkspace(owner.id, "Graph");
  const sp = (await bootstrap(owner, ws)).spaces[0].id;
  const journal = String((await cmd({ action: "page.create", workspaceId: ws, spaceId: sp, title: "Reisetagebuch", kind: "journal" })).id);
  const target = String((await cmd({ action: "page.create", workspaceId: ws, spaceId: sp, title: "Packliste" })).id);
  const dates = ["2026-09-29", "2026-09-30", "2026-10-01"];
  const dayIds = await mapAsync(dates, async (date) => {
    const day = (await rollJournal(owner, await page(journal), date, date)).dayId;
    await write(day, `<p>Siehe <a href="/#page=${target}">Packliste</a></p>`);
    return day;
  });
  const hidden = await pageGraph(owner, ws, { days: "hide" });
  assert.ok(!hidden.nodes.some((n) => dayIds.includes(n.id) || n.kind === "journal-month"));
  assert.ok(hidden.edges.every((e) => !dayIds.includes(e.from)));
  const months = await pageGraph(owner, ws, { days: "month" });
  const monthNodes = months.nodes.filter((n) => n.kind === "journal-month");
  assert.deepEqual(monthNodes.map((n) => n.month).sort(), ["2026-09", "2026-10"]);
  assert.equal(monthNodes.find((n) => n.month === "2026-09")!.days, 2);
  assert.equal(monthNodes[0].journalId, journal);
  assert.match(monthNodes.find((n) => n.month === "2026-10")!.title, /Oktober 2026 · Reisetagebuch/);
  // One link per month, however many days link.
  assert.equal(months.edges.filter((e) => e.kind === "link" && e.to === target).length, 2);
  assert.equal(months.nodes.find((n) => n.id === target)!.links, 2);
  const shown = await pageGraph(owner, ws, { days: "show" });
  assert.equal(shown.nodes.filter((n) => dayIds.includes(n.id)).length, 3);
  assert.equal(shown.edges.filter((e) => e.kind === "link" && e.to === target).length, 3);
  // A journal behind a PIN: nothing of its days, in no mode.
  await command(owner, { action: "journal.lock", pageId: journal, pin: "123456" });
  await command(owner, { action: "journal.relock", pageId: journal });
  for (const days of ["hide", "month", "show"] as const)
    assert.ok(!(await pageGraph(owner, ws, { days })).nodes.some((n) => dayIds.includes(n.id) || n.kind === "journal-month"));
});

test("pages and journal days are counted apart, without days behind a PIN", async () => {
  const ws = await createWorkspace(owner.id, "Zählen");
  const sp = (await bootstrap(owner, ws)).spaces[0].id;
  const before = (await bootstrap(owner, ws)).pageCounts!;
  const journal = String((await cmd({ action: "page.create", workspaceId: ws, spaceId: sp, title: "Zähljournal", kind: "journal" })).id);
  for (const date of ["2026-10-24", "2026-10-25", "2026-10-26"]) {
    const day = (await rollJournal(owner, await page(journal), date, date)).dayId;
    await write(day, "<p>Etwas.</p>");
  }
  const counts = (await bootstrap(owner, ws)).pageCounts!;
  assert.equal(counts.pages, before.pages + 1);
  assert.equal(counts.days, 3);
  assert.deepEqual(counts.spaces[sp], { pages: before.pages + 1, days: 3 });
  await command(owner, { action: "journal.lock", pageId: journal, pin: "123456" });
  await command(owner, { action: "journal.relock", pageId: journal });
  assert.equal((await bootstrap(owner, ws)).pageCounts!.days, 0);
  assert.equal((await pageCounts(owner, ws, await all<Page>("SELECT * FROM pages WHERE workspace_id=?", ws))).pages, before.pages + 1);
});
