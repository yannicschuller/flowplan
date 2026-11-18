// Flashcards phase 2 and 3a, the domain (docs/specs/flashcards.md §5, §6,
// §8.3, §10.1, §11): cloze, typed and multiple choice cards as the queue
// sends them, distractors only from cards the person may see (§17.9), the
// aggregated due counts of #study and the widget, statistics, the journal's
// line per deck, the CSV export and "Früher zeigen". Runs on SQLite and
// PostgreSQL (test:db): the SQL is portable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-study2-"));
const { id, run, one } = await import("../lib/db");
const { command, database, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { studyDue, studyStats } = await import("../lib/study-stats");
const { studyExport } = await import("../lib/study");
const { completedOn } = await import("../lib/journal-completed");
const { completedLine } = await import("../lib/ai/journal-completed");
const { homeData } = await import("../lib/home-widgets");
const { htmlState } = await import("../lib/document-server");
const { studyDay } = await import("../lib/study-day");

async function user(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@test.invalid`);
  return { id: uid, name, email: `${name}@test.invalid`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const owner = await user("owner");
const reader = await user("reader");
const wid = await createWorkspace(owner.id, "Lernen 2"),
  boot = await bootstrap(owner, wid);
await run("INSERT INTO members(workspace_id,user_id,role) VALUES(?,?,?)", wid, reader.id, "viewer");
const act = async (body: Record<string, unknown>): Promise<any> => await command(owner, body);
const zone = "Europe/Berlin";

async function deck(title: string, settings: Record<string, unknown> = {}, extraFields: Record<string, unknown>[] = []) {
  const pageId = (await act({ action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, kind: "database", title })).id as string;
  const db = await database(pageId);
  await act({
    action: "database.update",
    pageId,
    version: db.version,
    fields: [
      { id: "title", name: "Vorderseite", type: "text" },
      { id: "back", name: "Rückseite", type: "text" },
      { id: "tags", name: "Tags", type: "multiselect", options: ["A", "B"] },
      ...extraFields,
    ],
    views: [
      { id: "study", name: "Lernen", type: "study", filters: [], sorts: [] },
      { id: "onlyA", name: "Nur A", type: "study", filters: [{ field: "tags", op: "contains", value: "A" }], sorts: [] },
    ],
  });
  await act({ action: "study.settings", pageId, settings: { version: 1, front: { field: "title" }, back: { field: "back" }, ...settings } });
  return pageId;
}
const card = async (pageId: string, front: string, back: string, extra: Record<string, unknown> = {}) =>
  (await act({ action: "row.create", pageId, cells: { title: front, back, ...extra } })).id as string;
const queue = async (who: Identity, pageId: string, more: Record<string, unknown> = {}) => (await command(who, { action: "study.queue", pageId, zone, ...more })) as any;
const rate = async (who: Identity, pageId: string, c: { rowId: string; sub: string }, rating: number, more: Record<string, unknown> = {}) =>
  (await command(who, { action: "study.review", pageId, rowId: c.rowId, sub: c.sub, rating, id: randomUUID(), zone, ...more })) as any;
const setDocument = async (rowId: string, html: string) => {
  const doc = await one("SELECT 1 FROM row_documents WHERE row_id=?", rowId);
  if (doc) await run("UPDATE row_documents SET html=?,state=? WHERE row_id=?", html, htmlState(html), rowId);
  else await run("INSERT INTO row_documents(row_id,state,html,generation) VALUES(?,?,?,?)", rowId, htmlState(html), html, id());
};

test("cloze cards: one per number, gaps hidden on the front and marked on the back", async () => {
  const pageId = await deck("Lücken", { back: { document: "all" } });
  const text = await card(pageId, "{{c1::Paris}} liegt an der {{c2::Seine::Fluss}}", "");
  const doc = await card(pageId, "Zelle", "");
  await setDocument(doc, '<p>Die <span data-cloze="1">Mitochondrien</span> liefern Energie.</p>');
  const q = await queue(owner, pageId, { limit: 50 });
  assert.equal(q.total, 3);
  const subs = q.cards.map((c: any) => `${c.rowId === text ? "text" : "doc"}:${c.sub}:${c.kind}`).sort();
  // Siblings wait for the next day: one card of the text record today.
  assert.deepEqual(subs, ["doc:c1:cloze", "text:c1:cloze"]);
  const fromText = q.cards.find((c: any) => c.rowId === text);
  assert.deepEqual(fromText.front, { text: "{{c1::Paris}} liegt an der {{c2::Seine::Fluss}}", cloze: { n: 1, reveal: false } });
  assert.deepEqual(fromText.back.cloze, { n: 1, reveal: true });
  const fromDoc = q.cards.find((c: any) => c.rowId === doc);
  assert.match(fromDoc.front.html, /cloze-gap/);
  assert.doesNotMatch(fromDoc.front.html, /Mitochondrien/);
  assert.match(fromDoc.back.html, /<span class="cloze-answer">Mitochondrien<\/span>/);
  // The title of a record whose gaps are in its document comes as context.
  assert.deepEqual(fromDoc.context, { text: "Zelle" });
  // Both numbers are cards of their own in the index.
  assert.deepEqual(
    ((await (await import("../lib/db")).all<{ sub: string }>("SELECT sub FROM study_cards WHERE page_id=? AND row_id=? ORDER BY sub", pageId, text)) as { sub: string }[]).map((r) => r.sub),
    ["c1", "c2"],
  );
  const rated = await rate(owner, pageId, fromText, 4);
  assert.equal(rated.review.memory.state, 2);
});

test("typed cards carry the expected answer, the deck's tolerance comes along", async () => {
  const pageId = await deck("Tippen", { type: { fixed: "typed" }, typedCompare: { ignoreCase: true, ignoreAccents: true, ignorePunctuation: true }, reverse: true });
  await card(pageId, "rojo", "rot | Rot");
  const q = await queue(owner, pageId);
  assert.equal(q.cards[0].kind, "typed");
  assert.deepEqual(q.cards[0].typed, { answer: "rot | Rot" });
  assert.equal(q.settings.typedCompare.ignoreAccents, true);
  // Switching basic ↔ typed keeps the key "" and so the learning state.
  await rate(owner, pageId, q.cards[0], 4);
  await act({ action: "study.settings", pageId, settings: { version: 1, front: { field: "title" }, back: { field: "back" } } });
  assert.equal((await queue(owner, pageId)).states.review, 1);
});

test("multiple choice: own options, or distractors only from cards the person may see", async () => {
  const pageId = await deck("Auswahl", { type: { fixed: "choice" }, tags: { field: "tags" } }, [{ id: "wrong", name: "Falsche Antworten", type: "text" }]);
  const first = await card(pageId, "Hauptstadt von Spanien?", "Madrid", { tags: ["A"] });
  await card(pageId, "Hauptstadt von Italien?", "Rom", { tags: ["A"] });
  await card(pageId, "Hauptstadt von Frankreich?", "Paris", { tags: ["A"] });
  await card(pageId, "Hauptstadt von Polen?", "Warschau", { tags: ["B"] });
  const secret = await card(pageId, "Geheim?", "Geheimwort", { tags: ["A"] });
  await run("UPDATE rows SET access='private' WHERE id=?", secret);
  for (let i = 0; i < 3; i++) {
    const q = await queue(reader, pageId, { limit: 50 });
    const c = q.cards.find((x: any) => x.rowId === first);
    assert.equal(c.kind, "choice");
    assert.equal(c.choice.options[c.choice.correct], "Madrid");
    assert.equal(c.choice.options.length, 4);
    // A private record of someone else never leaks as an option.
    for (const x of q.cards) assert.ok(!x.choice.options.includes("Geheimwort"), "private record leaked");
  }
  // The owner may see it: among the candidates.
  const own = await queue(owner, pageId, { limit: 50 });
  assert.ok(own.cards.some((x: any) => x.choice.options.includes("Geheimwort")));
  // A view's filter narrows the candidates too: only cards tagged A.
  const onlyA = await queue(reader, pageId, { viewId: "onlyA", limit: 50 });
  for (const x of onlyA.cards) assert.ok(!x.choice.options.includes("Warschau"), "option from outside the view");
  // The record's own options come first, the right one is never doubled.
  await act({ action: "study.settings", pageId, settings: { version: 1, type: { fixed: "choice" }, front: { field: "title" }, back: { field: "back" }, choices: { field: "wrong" } } });
  const rowVersion = (await one<{ version: number }>("SELECT version FROM rows WHERE id=?", first))!.version;
  await act({ action: "row.update", pageId, rowId: first, version: rowVersion, cells: { wrong: "Barcelona\nSevilla\nmadrid" } });
  const mine = (await queue(owner, pageId, { limit: 50 })).cards.find((x: any) => x.rowId === first);
  assert.deepEqual(mine.choice.options.slice(0, 3), ["Madrid", "Barcelona", "Sevilla"]);
  assert.equal(mine.choice.options.length, 4);
  // A hidden options property: no cards at all for whoever may not see it.
  const db = await database(pageId);
  await act({ action: "database.update", pageId, version: db.version, fields: db.fields.map((f: any) => (f.id === "wrong" ? { ...f, access: { read: "editors" } } : f)), views: db.views });
  assert.equal((await queue(reader, pageId)).blocked, "hidden");
});

test("“Früher zeigen”: learning cards due later today come with ahead", async () => {
  const pageId = await deck("Später", { learningSteps: [40] });
  await card(pageId, "tarde", "spät");
  const [c] = (await queue(owner, pageId)).cards;
  // Again: the first step, 40 minutes – later than the 20 minutes ahead.
  await rate(owner, pageId, c, 1);
  const waiting = await queue(owner, pageId);
  // Close to the end of the study day the step falls on the next one.
  if (waiting.dayEnd - Date.now() < 45 * 60_000) return;
  assert.equal(waiting.counts.learning, 1);
  assert.equal(waiting.cards.length, 0);
  assert.ok(waiting.nextDue > Date.now() + 30 * 60_000);
  const ahead = await queue(owner, pageId, { ahead: true });
  assert.equal(ahead.cards.length, 1);
  assert.equal(ahead.cards[0].rowId, c.rowId);
});

test("due counts of all decks come from one aggregated query and match the queue", async () => {
  const workspace = await createWorkspace(owner.id, "Zählen");
  const space = (await bootstrap(owner, workspace)).spaces[0].id;
  await run("INSERT INTO members(workspace_id,user_id,role) VALUES(?,?,?)", workspace, reader.id, "viewer");
  const make = async (title: string, settings: Record<string, unknown> = {}) => {
    const pageId = (await act({ action: "page.create", workspaceId: workspace, spaceId: space, kind: "database", databaseKind: "flashcards", title })).id as string;
    if (Object.keys(settings).length) await act({ action: "study.settings", pageId, settings: { version: 1, front: { field: "title" }, back: { field: "back" }, ...settings } });
    return pageId;
  };
  const a = await make("Alpha", { newPerDay: 2 });
  const b = await make("Beta");
  for (const w of ["uno", "dos", "tres"]) await card(a, w, w.toUpperCase());
  const hiddenRow = await card(b, "privado", "privat");
  await run("UPDATE rows SET access='private' WHERE id=?", hiddenRow);
  await card(b, "público", "öffentlich");
  await rate(owner, a, (await queue(owner, a)).cards[0], 1);
  const due = await studyDue(owner, { workspaceId: workspace, zone });
  const alpha = due.decks.find((d) => d.pageId === a)!;
  const q = await queue(owner, a);
  assert.deepEqual({ new: alpha.new, learning: alpha.learning, review: alpha.review }, q.counts);
  assert.equal(alpha.total, 3);
  // The reader: their own state, no private record of the owner.
  const theirs = await studyDue(reader, { workspaceId: workspace, zone });
  assert.deepEqual(
    theirs.decks.map((d) => [d.title, d.new, d.learning, d.total]),
    [
      ["Alpha", 2, 0, 3],
      ["Beta", 1, 0, 1],
    ],
  );
  // A deck behind a hidden side is left out; so is one in the trash.
  await act({ action: "page.delete", pageId: b }).catch(async () => await run("UPDATE pages SET deleted_at=? WHERE id=?", new Date().toISOString(), b));
  assert.deepEqual((await studyDue(reader, { workspaceId: workspace, zone })).decks.map((d) => d.title), ["Alpha"]);
  // The start page's widget shows the same counts.
  const home = await homeData(owner, { workspaceId: workspace, zone, widgets: [{ id: "cards", kind: "study", config: {} }] });
  const widget = home.widgets[0] as any;
  assert.equal(widget.ok, true);
  assert.equal(widget.data.due, alpha.new + alpha.learning + alpha.review);
  assert.equal(widget.data.decks[0].title, "Alpha");
  // MCP's deck list follows the same path.
  const { studyDecks } = await import("../lib/study-stats");
  assert.equal((await studyDecks(owner, workspace, zone))[0].pageId, a);
});

test("statistics: streak, ratings per day, forecast, true retention, states – the person's own", async () => {
  const pageId = await deck("Statistik");
  const rows = [await card(pageId, "a", "1"), await card(pageId, "b", "2"), await card(pageId, "c", "3")];
  const day = 86_400_000;
  const now = Date.now();
  // Three days in a row: two days ago, yesterday, today.
  await rate(owner, pageId, { rowId: rows[0], sub: "" }, 4, { reviewedAt: now - 2 * day });
  await rate(owner, pageId, { rowId: rows[0], sub: "" }, 1, { reviewedAt: now - day });
  await rate(owner, pageId, { rowId: rows[1], sub: "" }, 4, { reviewedAt: now - day + 1000 });
  await rate(owner, pageId, { rowId: rows[1], sub: "" }, 3);
  const stats = await studyStats(owner, { pageId, zone });
  assert.equal(stats.streak, 3);
  assert.equal(stats.heatmap.length, 3);
  assert.equal(stats.heatmap.reduce((n, d) => n + d.reviews, 0), 4);
  assert.equal(stats.today.reviews, 1);
  // Reviews (state before = review): one Again, one Good.
  const month = stats.retention.find((r) => r.days === 30)!;
  assert.deepEqual([month.reviews, month.rate], [2, 0.5]);
  assert.equal(stats.target, 0.9);
  assert.equal(stats.states.new, 1);
  assert.equal(stats.states.new + stats.states.learning + stats.states.young + stats.states.mature, 3);
  assert.equal(stats.forecast.length, 30);
  assert.equal(stats.forecast[0].day, studyDay(now, zone));
  assert.ok(stats.forecast.reduce((n, f) => n + f.due, 0) >= 1);
  // Someone else has none of it.
  const theirs = await studyStats(reader, { pageId, zone });
  assert.deepEqual([theirs.streak, theirs.heatmap.length, theirs.today.reviews, theirs.states.new], [0, 0, 0, 3]);
  // All decks of the workspace together.
  const all = await studyStats(owner, { workspaceId: wid, zone });
  assert.equal(all.scope, "all");
  assert.ok(all.decks >= 1);
  assert.ok(all.streak >= 3);
});

test("journal: the cards studied per deck on the calendar day, the reader's own only", async () => {
  const pageId = await deck("Journal-Stapel");
  const rows = [await card(pageId, "x", "1"), await card(pageId, "y", "2")];
  // 01:30 in Berlin on 2026-03-10: the study day is still 03-09, the
  // calendar day (the journal's) 03-10.
  const at = Date.UTC(2026, 2, 10, 0, 30);
  for (const rowId of rows)
    await run(
      "INSERT INTO review_log(id,user_id,workspace_id,page_id,row_id,sub,rating,state_before,reviewed_at,day,zone,elapsed_days,scheduled_days,stability,difficulty,due,source,received_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      randomUUID(), owner.id, wid, pageId, rowId, "", 3, 0, at, studyDay(at, zone), zone, 0, 0, 1, 5, at + 600_000, "web", at,
    );
  assert.equal(studyDay(at, zone), "2026-03-09");
  for (const mine of [true, false]) {
    const list = await completedOn(owner, wid, "2026-03-10", zone, { mine });
    const study = list.items.filter((i) => i.kind === "study");
    assert.deepEqual(study.map((i) => [i.pageId, i.count, i.database]), [[pageId, 2, "Journal-Stapel"]]);
    assert.ok(list.all >= 1);
  }
  assert.equal((await completedOn(owner, wid, "2026-03-09", zone, { mine: true })).items.filter((i) => i.kind === "study").length, 0);
  // Never another person's studying, under "Alle" neither.
  assert.equal((await completedOn(reader, wid, "2026-03-10", zone, { mine: false })).items.filter((i) => i.kind === "study").length, 0);
  // The AI's line for the day.
  const [item] = (await completedOn(owner, wid, "2026-03-10", zone, { mine: true })).items.filter((i) => i.kind === "study");
  assert.equal(completedLine(item, "de"), "2 Karten gelernt in Journal-Stapel");
  assert.equal(completedLine(item, "en"), "Studied 2 cards in Journal-Stapel");
  // A deck the reader may no longer open is left out.
  await run("UPDATE pages SET deleted_at=? WHERE id=?", new Date().toISOString(), pageId);
  assert.equal((await completedOn(owner, wid, "2026-03-10", zone, { mine: true })).items.filter((i) => i.kind === "study").length, 0);
});

test("a journal day with nothing but studying is no empty day", async () => {
  const { journalSettings } = await import("../lib/journal-extras");
  const journalId = (await act({ action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, kind: "journal", title: "Tagebuch" })).id as string;
  assert.equal((await journalSettings(journalId)).options.completed, true);
  const pageId = await deck("Tagesstapel");
  const rowId = await card(pageId, "z", "1");
  await rate(owner, pageId, { rowId, sub: "" }, 3);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(new Date());
  const list = await completedOn(owner, wid, today, zone, { mine: true, limit: 1 });
  assert.equal(list.items.length, 1);
});

test("CSV export: one line per card, the person's own state on request", async () => {
  const pageId = await deck("Export", { reverse: true, hint: { field: "tags" } });
  const rowId = await card(pageId, "=1+1", "zwei, \"2\"", { tags: ["A"] });
  await card(pageId, "{{c1::Bern}} ist eine Stadt", "");
  await rate(reader, pageId, { rowId, sub: "" }, 4);
  const plain = await studyExport(owner, { pageId, zone });
  const lines = plain.csv.replace(/^﻿/, "").trim().split("\r\n");
  assert.equal(lines[0], "Vorderseite,Rückseite,Hinweis,Zusatz,Tags,Kartentyp,Karte");
  assert.equal(plain.cards, 3);
  // Formulas are defused, quotes doubled; the reverse card names the record's sides.
  assert.ok(lines.includes(`'=1+1,"zwei, ""2""",A,,,Vorder-/Rückseite,`), lines.join("\n"));
  assert.ok(lines.some((l) => l.startsWith("'=1+1,") && l.endsWith(",r")));
  assert.ok(lines.some((l) => l.startsWith("{{c1::Bern}} ist eine Stadt,") && l.endsWith(",Lückentext,c1")));
  const withState = await studyExport(reader, { pageId, zone, state: true });
  const header = withState.csv.replace(/^﻿/, "").split("\r\n")[0];
  assert.match(header, /Zustand,Fällig,Stabilität \(Tage\),Schwierigkeit,Wiederholungen,Vergessen,Ausgesetzt$/);
  const reviewed = withState.csv.split("\r\n").find((l) => l.includes(",Wiederholung,"));
  assert.ok(reviewed, "the reader's own review is in their export");
  // The owner never sees the reader's state.
  assert.ok(!(await studyExport(owner, { pageId, zone, state: true })).csv.includes(",Wiederholung,"));
});
