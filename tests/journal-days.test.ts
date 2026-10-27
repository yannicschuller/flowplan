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

function person(name: string): Identity {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name.toLowerCase()}@example.test`);
  return { id: uid, name, email: `${name.toLowerCase()}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const owner = person("Lena");
const wid = createWorkspace(owner.id, "Tagebuch");
const space = bootstrap(owner, wid).spaces[0].id;
const act = (b: Record<string, unknown>, who = owner) => command(who, { workspaceId: wid, ...b }) as Record<string, unknown>;
const cmd = (b: Record<string, unknown>) => command(owner, b) as { id: string };
const createJournal = (title: string, spaceId = space) => String(act({ action: "page.create", spaceId, title, kind: "journal" }).id);
const page = (pageId: string) => one<Page>("SELECT * FROM pages WHERE id=?", pageId)!;
const html = (pageId: string) => String(one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", pageId)?.html || "");
const write = (pageId: string, body: string) => run("UPDATE documents SET state=?,html=? WHERE page_id=?", htmlState(body), body, pageId);
const task = (text: string, checked = false, since?: string) =>
  `<li data-type="taskItem" data-checked="${checked}"${since ? ` data-journal-since="${since}"` : ""}><p>${text}</p></li>`;
const tasks = (...items: string[]) => `<ul data-type="taskList">${items.join("")}</ul>`;
const dayOf = (journalId: string, date: string) =>
  one<Page>("SELECT * FROM pages WHERE parent_id=? AND journal_date=? AND deleted_at IS NULL", journalId, date);
const roll = (journalId: string, date: string, options: { write?: boolean } = {}) =>
  rollJournal(owner, page(journalId), date, date, false, options);
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

test("a journal set to 'beim ersten Schreiben' shows a draft and creates the day only on the first write", () => {
  const journal = createJournal("Entwurfsjournal");
  // Automatic is the default: nothing changes for existing journals.
  assert.equal((pageData(owner, journal) as { journal: { settings: { options: { create: string } } } }).journal.settings.options.create, "auto");
  act({ action: "journal.settings", pageId: journal, template: "<h3>Heute</h3><p></p>" });
  const monday = roll(journal, "2026-10-26").dayId;
  write(monday, `<h3>Heute</h3>${tasks(task("Steuer"), task("Joggen", true))}`);
  act({ action: "journal.settings", pageId: journal, options: { create: "write" } });

  // Opening today: a draft id, no page, the open task still on Monday.
  const first = roll(journal, "2026-10-27");
  assert.equal(first.draft, true);
  assert.equal(first.changed, false);
  assert.equal(dayOf(journal, "2026-10-27"), undefined);
  assert.equal(roll(journal, "2026-10-27").dayId, first.dayId, "the same draft for every device");
  assert.match(html(monday), /Steuer/);
  // Nothing in tree, search or bootstrap.
  assert.ok(!bootstrap(owner, wid).pages.some((p) => p.id === first.dayId));

  // The draft as a page: template plus carried task, not stored.
  const draft = journalDraftPage(owner, first.dayId, "2026-10-27");
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
  const a = roll(journal, "2026-10-27", { write: true });
  const b = roll(journal, "2026-10-27", { write: true });
  assert.equal(a.dayId, first.dayId);
  assert.equal(b.dayId, first.dayId);
  assert.equal(a.changed, true);
  assert.equal(b.changed, false);
  assert.equal(a.generation, data.generation, "the stored day is exactly the draft");
  assert.equal(b.generation, data.generation);
  assert.equal(all("SELECT id FROM pages WHERE parent_id=? AND journal_date='2026-10-27'", journal).length, 1);
  // The carried task moved now – not before.
  assert.doesNotMatch(html(monday), /Steuer/);
  // What was typed merges without doubling the template.
  act({ action: "document.sync", pageId: first.dayId, generation: data.generation, update: b64(Y.encodeStateAsUpdate(typed)) });
  const stored = html(first.dayId);
  assert.match(stored, /Erster Gedanke/);
  assert.equal(stored.match(/Steuer/g)?.length, 1);
  assert.equal(stored.match(/<h3>Heute<\/h3>/g)?.length, 1);
  // The draft link now opens the day itself.
  assert.deepEqual(journalDraftPage(owner, first.dayId, "2026-10-27"), null, "the page exists, no draft any more");
});

test("a draft whose start changed meanwhile is not merged into the day", () => {
  const journal = createJournal("Zweites Journal");
  act({ action: "journal.settings", pageId: journal, options: { create: "write" } });
  const yesterday = rollJournal(owner, page(journal), "2026-10-26", "2026-10-26", false, { write: true }).dayId;
  write(yesterday, tasks(task("Anrufen")));
  const draft = roll(journal, "2026-10-27");
  const before = (journalDraftPage(owner, draft.dayId, "2026-10-27") as { data: { generation: string } }).data.generation;
  // Another device ticks yesterday's task before today is written.
  write(yesterday, tasks(task("Anrufen", true)));
  const created = roll(journal, "2026-10-27", { write: true });
  assert.equal(created.dayId, draft.dayId);
  assert.notEqual(created.generation, before, "the client sees another generation and opens the stored day");
});

test("trackers, entries from widgets and the trash keep working with drafts", () => {
  const journal = createJournal("Tracker-Journal");
  act({ action: "journal.settings", pageId: journal, options: { create: "write" } });
  // The app's roll for all journals (on opening, at midnight) leaves a draft
  // journal alone.
  const today = new Date().toISOString().slice(0, 10);
  rollJournals(owner, wid, today);
  assert.equal(all("SELECT id FROM pages WHERE parent_id=?", journal).length, 0);
  const created = roll(journal, "2026-10-27", { write: true });
  act({ action: "journal.entry", pageId: created.dayId, entry: { values: { mood: 4 } } });
  assert.equal(page(created.dayId).journal_date, "2026-10-27");
  // Today's page in the trash: reported, and recreated as a draft.
  act({ action: "page.delete", pageId: created.dayId });
  const trashed = roll(journal, "2026-10-27");
  assert.equal(trashed.trashed, true);
  const again = rollJournal(owner, page(journal), "2026-10-27", "2026-10-27", true);
  assert.equal(again.draft, true);
  assert.equal(dayOf(journal, "2026-10-27"), undefined);
});

test("each day remembers the template it was created from", () => {
  const journal = createJournal("Vorlagenjournal");
  act({ action: "journal.settings", pageId: journal, template: "<h3>Morgens</h3><p></p>" });
  const first = roll(journal, "2026-10-20").dayId;
  assert.match(String(dayTemplateHtml(first)), /Morgens/);
  // The template changes; the untouched day still counts as empty …
  act({ action: "journal.settings", pageId: journal, template: "<h3>Abends</h3><p></p>" });
  const second = roll(journal, "2026-10-21").dayId;
  assert.match(String(dayTemplateHtml(second)), /Abends/);
  // … so it was removed when the next day came.
  assert.equal(one("SELECT 1 FROM pages WHERE id=?", first), undefined);
  // A day without a template remembers that too.
  act({ action: "journal.settings", pageId: journal, template: "" });
  const third = roll(journal, "2026-10-22").dayId;
  assert.equal(dayTemplateHtml(third), "");
});

test("'Leere Tage entfernen' previews conservatively and moves only those days to the trash", () => {
  const journal = createJournal("Aufräumjournal");
  act({ action: "journal.settings", pageId: journal, template: "<h3>Notizen</h3><p></p>" });
  const at = (date: string) => {
    const dayId = id();
    run(
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
    run("INSERT INTO documents(page_id,html,state) VALUES(?,?,?)", dayId, "<h3>Notizen</h3><p></p>", htmlState("<h3>Notizen</h3><p></p>"));
    return dayId;
  };
  const empty = at("2026-09-01");
  const blank = at("2026-09-02");
  write(blank, "<p></p>");
  const written = at("2026-09-03");
  write(written, "<h3>Notizen</h3><p>Am See gewesen.</p>");
  const tracked = at("2026-09-04");
  act({ action: "journal.entry", pageId: tracked, entry: { values: { mood: 3 } } });
  const linked = at("2026-09-05");
  const other = String(act({ action: "page.create", spaceId: space, title: "Verweis" }).id);
  write(other, `<p><a href="/#page=${linked}">Tag</a></p>`);
  const renamed = at("2026-09-06");
  run("UPDATE pages SET title='Urlaubsbeginn' WHERE id=?", renamed);
  const trivially = at("2026-09-07");
  run("UPDATE pages SET title=lower(title) || '  ' WHERE id=?", trivially);
  const commented = at("2026-09-08");
  act({ action: "comment.create", pageId: commented, body: "Notiz" });
  const openTask = at("2026-09-09");
  write(openTask, `<h3>Notizen</h3>${tasks(task("Offen", false, "2026-09-01"))}`);
  const today = at("2026-10-27");

  const preview = emptyJournalDays(page(journal), "2026-10-27").map((d) => d.id);
  assert.deepEqual(new Set(preview), new Set([empty, blank, trivially]));
  assert.ok(!preview.includes(today), "today always stays");
  // Viewers may not, and only chosen days that are still empty go.
  const viewer = person("Vera");
  run("INSERT INTO members(workspace_id,user_id,role) VALUES(?,?,'viewer')", wid, viewer.id);
  assert.throws(() => act({ action: "journal.removeEmpty", pageId: journal, dayIds: preview, today: "2026-10-27" }, viewer), /Berechtigung/);
  write(blank, "<p>Doch etwas.</p>");
  const result = act({ action: "journal.removeEmpty", pageId: journal, dayIds: [...preview, written], today: "2026-10-27" }) as { removed: number };
  assert.equal(result.removed, 2);
  assert.ok(page(empty).deleted_at, "in the trash …");
  assert.ok(page(trivially).deleted_at);
  assert.equal(page(blank).deleted_at, null);
  assert.equal(page(written).deleted_at, null);
  // … and back from it.
  act({ action: "page.restore", pageId: empty });
  assert.equal(page(empty).deleted_at, null);
  assert.equal(page(empty).journal_date, "2026-09-01");
});

test("@heute, @gestern and @2026-10-27 link to the journal's day", () => {
  assert.deepEqual(journalDayQuery("heu", "2026-10-27", "2026-10-26"), { label: "today", date: "2026-10-27" });
  assert.deepEqual(journalDayQuery("@today", "2026-10-27", "2026-10-26"), { label: "today", date: "2026-10-27" });
  assert.deepEqual(journalDayQuery("Gestern", "2026-10-27", "2026-10-26"), { label: "yesterday", date: "2026-10-26" });
  assert.deepEqual(journalDayQuery("2026-10-27"), { label: "date", date: "2026-10-27" });
  assert.equal(journalDayQuery("2026-02-30"), null);
  assert.equal(journalDayQuery("h"), null);

  const ws = createWorkspace(owner.id, "Verlinkt");
  const spaces = bootstrap(owner, ws).spaces;
  const other = String(cmd({ action: "space.create", workspaceId: ws, name: "Privat" }).id);
  const mainJournal = String(cmd({ action: "page.create", workspaceId: ws, spaceId: spaces[0].id, title: "Team-Journal", kind: "journal" }).id);
  const privateJournal = String(cmd({ action: "page.create", workspaceId: ws, spaceId: other, title: "Mein Journal", kind: "journal" }).id);
  const note = String(cmd({ action: "page.create", workspaceId: ws, spaceId: other, title: "Notiz" }).id);
  rollJournal(owner, page(mainJournal), "2026-10-26", "2026-10-26");
  const yesterday = rollJournal(owner, page(privateJournal), "2026-10-26", "2026-10-26").dayId;
  write(yesterday, "<p>Gestern.</p>");
  // From a page in the private space: that space's journal.
  const link = journalDayLink(owner, ws, { date: "2026-10-26", today: "2026-10-27", fromPageId: note }, "2026-10-27");
  assert.equal(link.dayId, yesterday);
  assert.equal(link.journalId, privateJournal);
  assert.equal(link.title, "Montag, 26. Oktober 2026");
  // Today follows "open the day": created (automatic) …
  const today = journalDayLink(owner, ws, { date: "2026-10-27", today: "2026-10-27", fromPageId: note }, "2026-10-27");
  assert.equal(today.draft, false);
  assert.equal(dayOf(privateJournal, "2026-10-27")?.id, today.dayId);
  // … or the draft (beim ersten Schreiben), which opens like a page.
  command(owner, { action: "journal.settings", pageId: privateJournal, options: { create: "write" } });
  run("DELETE FROM pages WHERE id=?", today.dayId);
  const draft = journalDayLink(owner, ws, { date: "2026-10-27", today: "2026-10-27", fromPageId: note }, "2026-10-27");
  assert.equal(draft.draft, true);
  assert.equal(dayOf(privateJournal, "2026-10-27"), undefined);
  // A day without an entry is no link.
  assert.throws(() => journalDayLink(owner, ws, { date: "2026-01-01", today: "2026-10-27", fromPageId: note }, "2026-10-27"), /keinen Eintrag/);
  // A journal behind a PIN is never chosen.
  command(owner, { action: "journal.lock", pageId: privateJournal, pin: "123456" });
  command(owner, { action: "journal.relock", pageId: privateJournal });
  const fallback = journalDayLink(owner, ws, { date: "2026-10-26", today: "2026-10-27", fromPageId: note }, "2026-10-27");
  assert.equal(fallback.journalId, mainJournal);
});

test("search ranks journal days after other pages, can leave them out and never shows locked days", () => {
  const ws = createWorkspace(owner.id, "Suche");
  const sp = bootstrap(owner, ws).spaces[0].id;
  const journal = String(cmd({ action: "page.create", workspaceId: ws, spaceId: sp, title: "Logbuch", kind: "journal" }).id);
  for (const date of ["2026-10-20", "2026-10-21", "2026-10-22"]) {
    const day = rollJournal(owner, page(journal), date, date).dayId;
    write(day, "<p>Sitzung mit dem Kirschbaumverein und viel Kirschbaum.</p>");
  }
  const plain = String(cmd({ action: "page.create", workspaceId: ws, spaceId: sp, title: "Protokoll" }).id);
  write(plain, "<p>Kirschbaumverein</p>");
  const hits = searchWorkspace(owner, ws, "Kirschbaumverein");
  assert.equal(hits[0].id, plain, "the page before the days");
  assert.equal(hits.filter((h) => h.journalDate).length, 3);
  assert.ok(hits.slice(1).every((h) => h.journalDate));
  const without = searchWorkspace(owner, ws, "Kirschbaumverein", { excludeDays: true });
  assert.deepEqual(without.map((h) => h.id), [plain]);
  // Empty query (recent pages): days last too.
  const recent = searchWorkspace(owner, ws, "");
  const firstDay = recent.findIndex((h) => h.journalDate);
  assert.ok(firstDay > 0 && recent.slice(firstDay).every((h) => h.journalDate));
  command(owner, { action: "journal.lock", pageId: journal, pin: "123456" });
  command(owner, { action: "journal.relock", pageId: journal });
  assert.equal(searchWorkspace(owner, ws, "Kirschbaumverein").filter((h) => h.journalDate).length, 0);
});

test("the graph hides journal days, shows one dot per month or each day", () => {
  const ws = createWorkspace(owner.id, "Graph");
  const sp = bootstrap(owner, ws).spaces[0].id;
  const journal = String(cmd({ action: "page.create", workspaceId: ws, spaceId: sp, title: "Reisetagebuch", kind: "journal" }).id);
  const target = String(cmd({ action: "page.create", workspaceId: ws, spaceId: sp, title: "Packliste" }).id);
  const dates = ["2026-09-29", "2026-09-30", "2026-10-01"];
  const dayIds = dates.map((date) => {
    const day = rollJournal(owner, page(journal), date, date).dayId;
    write(day, `<p>Siehe <a href="/#page=${target}">Packliste</a></p>`);
    return day;
  });
  const hidden = pageGraph(owner, ws, { days: "hide" });
  assert.ok(!hidden.nodes.some((n) => dayIds.includes(n.id) || n.kind === "journal-month"));
  assert.ok(hidden.edges.every((e) => !dayIds.includes(e.from)));
  const months = pageGraph(owner, ws, { days: "month" });
  const monthNodes = months.nodes.filter((n) => n.kind === "journal-month");
  assert.deepEqual(monthNodes.map((n) => n.month).sort(), ["2026-09", "2026-10"]);
  assert.equal(monthNodes.find((n) => n.month === "2026-09")!.days, 2);
  assert.equal(monthNodes[0].journalId, journal);
  assert.match(monthNodes.find((n) => n.month === "2026-10")!.title, /Oktober 2026 · Reisetagebuch/);
  // One link per month, however many days link.
  assert.equal(months.edges.filter((e) => e.kind === "link" && e.to === target).length, 2);
  assert.equal(months.nodes.find((n) => n.id === target)!.links, 2);
  const shown = pageGraph(owner, ws, { days: "show" });
  assert.equal(shown.nodes.filter((n) => dayIds.includes(n.id)).length, 3);
  assert.equal(shown.edges.filter((e) => e.kind === "link" && e.to === target).length, 3);
  // A journal behind a PIN: nothing of its days, in no mode.
  command(owner, { action: "journal.lock", pageId: journal, pin: "123456" });
  command(owner, { action: "journal.relock", pageId: journal });
  for (const days of ["hide", "month", "show"] as const)
    assert.ok(!pageGraph(owner, ws, { days }).nodes.some((n) => dayIds.includes(n.id) || n.kind === "journal-month"));
});

test("pages and journal days are counted apart, without days behind a PIN", () => {
  const ws = createWorkspace(owner.id, "Zählen");
  const sp = bootstrap(owner, ws).spaces[0].id;
  const before = bootstrap(owner, ws).pageCounts!;
  const journal = String(cmd({ action: "page.create", workspaceId: ws, spaceId: sp, title: "Zähljournal", kind: "journal" }).id);
  for (const date of ["2026-10-24", "2026-10-25", "2026-10-26"]) {
    const day = rollJournal(owner, page(journal), date, date).dayId;
    write(day, "<p>Etwas.</p>");
  }
  const counts = bootstrap(owner, ws).pageCounts!;
  assert.equal(counts.pages, before.pages + 1);
  assert.equal(counts.days, 3);
  assert.deepEqual(counts.spaces[sp], { pages: before.pages + 1, days: 3 });
  command(owner, { action: "journal.lock", pageId: journal, pin: "123456" });
  command(owner, { action: "journal.relock", pageId: journal });
  assert.equal(bootstrap(owner, ws).pageCounts!.days, 0);
  assert.equal(pageCounts(owner, ws, all<Page>("SELECT * FROM pages WHERE workspace_id=?", ws)).pages, before.pages + 1);
});
