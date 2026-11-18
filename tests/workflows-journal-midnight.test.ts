// A nightly workflow around midnight must never make a journal day
// disappear. The reporter's workflow: Zeitplan "täglich · 23:55" →
// Journaltag lesen (heute) → KI: Eigene Anweisung with
// {{Journaltag lesen.completed}} → An Journaltag anhängen (heute). The day
// had no text of its own – only tasks carried over and tasks ticked in
// other pages ("An diesem Tag erledigt"). When the AI answer came after
// midnight, the append step resolved "today" anew to the next day, created
// it the way opening the journal does – and that removed the day before as
// "untouched" (a hard delete, not into the trash), with the summary of the
// 17th on the 18th. Now tasks done that day keep it, and an empty day goes
// to the trash. Against a stub model and a mocked clock (Date only).
import { test, after, mock as nodeMock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import type { Page } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-wf-journal-midnight-"));
process.env.FLOWPLAN_AI_REQUESTS_PER_HOUR = "100000";
delete process.env.FLOWPLAN_AI;
const { run, one, all } = await import("../lib/db");
const { database } = await import("../lib/api");
const { rollJournal, ensureJournalDay } = await import("../lib/journal");
const { htmlState } = await import("../lib/document-server");
const { drainWorkflows } = await import("../lib/workflows/queue");
const { processWorkflowSchedules } = await import("../lib/workflows/schedules");
const { draftGraph } = await import("../lib/workflows/draft");
const { startOllamaMock } = await import("./helpers/ai-mock");
const S = await import("./helpers/workflow-setup");
const { act, owner, node, chain, workflow, runsOf, outputOf, wid, space } = S;

const admin = { ...owner, isAdmin: true };
const ai = await startOllamaMock();
after(() => ai.close());
await act({ action: "admin.ai", settings: { enabled: true, provider: { kind: "ollama", baseUrl: ai.base, model: "chat", embeddingModel: "" } } }, admin);

// Only Date is mocked: timers and the stub model's server keep running.
const clock = (iso: string) => {
  nodeMock.timers.reset();
  nodeMock.timers.enable({ apis: ["Date"], now: Date.parse(iso) });
};
after(() => nodeMock.timers.reset());
const BERLIN = "Europe/Berlin";
const berlinDay = () => new Intl.DateTimeFormat("en-CA", { timeZone: BERLIN, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

const days = async (jid: string) => await all<Page>("SELECT * FROM pages WHERE parent_id=? ORDER BY journal_date", jid);
const html = async (pid: string) => (await one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", pid))?.html || "";
const setHtml = async (pid: string, body: string) => await run("UPDATE documents SET html=?,state=? WHERE page_id=?", body, htmlState(body), pid);
const journalPage = async (jid: string) => (await one<Page>("SELECT * FROM pages WHERE id=?", jid))!;

let n = 0;
async function doneElsewhere(title: string) {
  const pageId = (await act({ action: "page.create", workspaceId: wid, spaceId: space, kind: "database", title: `Aufgaben ${++n}`, databaseKind: "empty" })).id as string;
  await act({ action: "database.update", pageId, version: (await database(pageId)).version, fields: [{ id: "title", name: "Titel", type: "text" }, { id: "status", name: "Status", type: "select", options: ["Offen", "Erledigt"] }], views: (await database(pageId)).views });
  const rowId = (await act({ action: "row.create", pageId, cells: { title, status: "Offen" } })).id as string;
  const version = (await one<{ version: number }>("SELECT version FROM rows WHERE id=?", rowId))!.version;
  await act({ action: "row.update", pageId, rowId, version, cells: { status: "Erledigt" } });
}
// The reporter's prompt, word for word.
const PROMPT = (readId: string) =>
  `Schreibe eine Lange und detailierte Zusammenfassung von alle aufgaben die heute erledigt wurden. jede Aufgabe soll Thematisiert und beachtet werden\n\nhier der inhalt {{${readId}.completed}}\n\nWenn der Tag kein erledigte aufgaben hat soll nur stehen "Heute wurden keine Aufgaben erledigt 🙃"`;

// A journal with Monday 16 (text and two open tasks) and Tuesday 17 made on
// opening: only the carried tasks, no text of its own (or, with
// `create: "write"`, still a draft). A task is ticked in a database at
// 23:27 Berlin.
async function setup(name: string, opts: { create?: "open" | "write"; ticked?: string | null } = {}) {
  clock("2026-11-16T08:00:00Z");
  const jid = (await act({ action: "page.create", workspaceId: wid, spaceId: space, title: `Journal ${name}`, kind: "journal" })).id as string;
  if (opts.create === "write") await act({ action: "journal.settings", pageId: jid, options: { create: "write" } });
  const d16 = (await rollJournal(owner, await journalPage(jid), "2026-11-16", "2026-11-16", false, { write: true })).dayId;
  await setHtml(d16, `<p>Montag ${name}</p><ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>Offen A ${name}</p></li><li data-type="taskItem" data-checked="false"><p>Offen B ${name}</p></li></ul>`);
  clock("2026-11-17T07:00:00Z");
  const rolled = await rollJournal(owner, await journalPage(jid), "2026-11-17", "2026-11-17");
  if (opts.ticked !== null) {
    clock("2026-11-17T22:27:00Z");
    await doneElsewhere(opts.ticked || `Serverschrank ${name}`);
  }
  return { jid, d16, d17: rolled.draft ? null : rolled.dayId };
}
async function nightly(name: string, jid: string, settings?: { timeZone: string }, trigger: Record<string, unknown> = {}) {
  const t = node("trigger.schedule", { freq: "daily", interval: 1, time: "23:55", ...trigger }, "Zeitplan");
  const read = node("action.journal.read", { journal: jid, day: "today" }, "Journaltag lesen");
  const prompt = node("ai.prompt", { prompt: PROMPT(read.id) }, "KI: Eigene Anweisung");
  const append = node("action.journal.append", { journal: jid, day: "today", content: `{{${prompt.id}.text}}` }, "An Journaltag anhängen");
  const graph = { ...chain(t, read, prompt, append), ...(settings ? { settings: { ...settings, triggerOnOwnChanges: false, limits: {} } } : {}) };
  const { pageId } = await workflow(`Nacht ${name}`, graph);
  await run("UPDATE workflows SET activated_at=? WHERE page_id=?", Date.parse("2026-11-17T08:00:00Z"), pageId);
  return { pageId, read, append };
}
// The schedule fires at `at`; the model answers at `answered` (after midnight).
async function fire(pageId: string, at: string, answered?: string, answer = (completed: boolean) => (completed ? "# Tageszusammenfassung – Erledigte Aufgaben" : "Heute wurden keine Aufgaben erledigt 🙃")) {
  ai.answer = (r) => {
    if (answered) clock(answered);
    return answer(/\(Aufgaben \d+\)/.test(r.prompt));
  };
  clock(at);
  assert.equal(await processWorkflowSchedules(Date.now()), 1);
  await drainWorkflows();
  const r = (await runsOf(pageId)).at(-1)!;
  assert.equal(r.status, "succeeded", r.error || "");
  return r;
}
// Nothing in "An diesem Tag erledigt" any more: the other tests' ticks too.
async function forgetCompleted() {
  await run("DELETE FROM row_status_log");
  await run("DELETE FROM task_done_log");
}
const liveDates = async (jid: string) => (await days(jid)).filter((d) => !d.deleted_at).map((d) => d.journal_date);
// Every day is still there under its date, with its automatic title, none in the trash.
async function assertDays(jid: string, expected: string[]) {
  const list = await days(jid);
  assert.deepEqual(list.map((d) => d.journal_date), expected);
  assert.ok(list.every((d) => !d.deleted_at));
  const titles = { "2026-11-16": "Montag, 16. November 2026", "2026-11-17": "Dienstag, 17. November 2026", "2026-11-18": "Mittwoch, 18. November 2026" } as Record<string, string>;
  for (const d of list) assert.equal(d.title, titles[d.journal_date!]);
  return list;
}

test("the AI answer after midnight Berlin: the summary goes into the 17th, no day disappears", async () => {
  const { jid, d16, d17 } = await setup("berlin");
  const { pageId, read, append } = await nightly("berlin", jid, { timeZone: BERLIN });
  // 23:55 Berlin = 22:55 UTC; the answer comes at 00:02 Berlin.
  const r = await fire(pageId, "2026-11-17T22:55:00Z", "2026-11-17T23:02:00Z");
  const readOut = await outputOf(r.id, read.id);
  assert.equal(readOut.date, "2026-11-17");
  assert.deepEqual(readOut.completed, [`Serverschrank berlin (Aufgaben ${n})`]);
  assert.match(ai.chats.at(-1)!.prompt, /hier der inhalt <<<DATA-\w+\nServerschrank berlin \(Aufgaben \d+\)\n/);
  const appendOut = await outputOf(r.id, append.id);
  assert.equal(appendOut.date, "2026-11-17");
  assert.equal(appendOut.created, false);
  assert.equal(appendOut.day.id, d17);
  await assertDays(jid, ["2026-11-16", "2026-11-17"]);
  assert.match(await html(d17!), /Offen A berlin.*Tageszusammenfassung/s);
  assert.match(await html(d16), /Montag berlin/);
  // Opening the journal after midnight: the 18th takes the open tasks, the
  // 17th keeps its page and the summary.
  clock("2026-11-17T23:05:00Z");
  await rollJournal(owner, await journalPage(jid), berlinDay(), new Date().toISOString().slice(0, 10));
  const [, k17, k18] = await assertDays(jid, ["2026-11-16", "2026-11-17", "2026-11-18"]);
  assert.equal(k17.id, d17);
  assert.match(await html(d17!), /Tageszusammenfassung/);
  assert.doesNotMatch(await html(d17!), /Offen A/);
  assert.match(await html(k18.id), /Offen A berlin/);
});

test("the default time zone (UTC): a run started 23:55 UTC and answered after UTC midnight still means the 17th", async () => {
  const { jid, d17 } = await setup("utc");
  const { pageId, append } = await nightly("utc", jid);
  const r = await fire(pageId, "2026-11-17T23:55:00Z", "2026-11-18T00:03:00Z");
  assert.equal((await outputOf(r.id, append.id)).date, "2026-11-17");
  const [, k17] = await assertDays(jid, ["2026-11-16", "2026-11-17"]);
  assert.equal(k17.id, d17);
  assert.match(await html(d17!), /Tageszusammenfassung/);
});

test("no completed tasks: the AI's one line lands on the day, which stays", async () => {
  const { jid, d17 } = await setup("none", { ticked: null });
  const { pageId } = await nightly("none", jid, { timeZone: BERLIN });
  // (Other tests ticked tasks on this day too: the stub answers as the model would for none.)
  await fire(pageId, "2026-11-17T22:55:00Z", "2026-11-17T23:01:00Z", () => "Heute wurden keine Aufgaben erledigt 🙃");
  await assertDays(jid, ["2026-11-16", "2026-11-17"]);
  assert.match(await html(d17!), /Heute wurden keine Aufgaben erledigt 🙃/);
});

test("“create on first write”: the draft day is made by the append, under its draft id, and stays after midnight", async () => {
  const { jid, d16, d17 } = await setup("draft", { create: "write" });
  assert.equal(d17, null);
  const draft = (await one<{ id: string }>("SELECT id FROM journal_drafts WHERE journal_id=? AND date='2026-11-17'", jid))!.id;
  const { pageId, read, append } = await nightly("draft", jid, { timeZone: BERLIN });
  const r = await fire(pageId, "2026-11-17T22:55:00Z", "2026-11-17T23:04:00Z");
  assert.equal((await outputOf(r.id, read.id)).found, false);
  const out = await outputOf(r.id, append.id);
  assert.deepEqual([out.date, out.created, out.day.id], ["2026-11-17", true, draft]);
  await assertDays(jid, ["2026-11-16", "2026-11-17"]);
  // The open tasks moved from the 16th to the 17th, with the summary below.
  assert.match(await html(draft), /Offen A draft.*Tageszusammenfassung/s);
  assert.doesNotMatch(await html(d16), /Offen A/);
  // After midnight the 18th is a draft; the first write on it keeps the 17th.
  clock("2026-11-17T23:30:00Z");
  assert.equal((await rollJournal(owner, await journalPage(jid), berlinDay(), "2026-11-17")).draft, true);
  await rollJournal(owner, await journalPage(jid), berlinDay(), "2026-11-17", false, { write: true });
  await assertDays(jid, ["2026-11-16", "2026-11-17", "2026-11-18"]);
  assert.match(await html(draft), /Tageszusammenfassung/);
});

test("appending to the newest day never removes the day before, even an untouched one", async () => {
  // A run that starts after midnight (or a date placeholder on the 18th):
  // the 18th is made with the carried tasks, the 17th keeps its page.
  const { jid, d17 } = await setup("keep");
  clock("2026-11-17T23:10:00Z");
  const made = await ensureJournalDay(owner, await journalPage(jid), "2026-11-18", "2026-11-18");
  assert.equal(made.created, true);
  const [, k17, k18] = await assertDays(jid, ["2026-11-16", "2026-11-17", "2026-11-18"]);
  assert.equal(k17.id, d17);
  assert.equal(k18.id, made.dayId);
  assert.match(await html(made.dayId), /Offen A keep/);
  assert.doesNotMatch(await html(d17!), /Offen A keep/);
  // Opening the journal as a person still tidies an empty day away – into
  // the trash (journal.md "Leere Tage verschwinden").
  const other = await setup("tidy", { ticked: null });
  await forgetCompleted();
  clock("2026-11-17T23:10:00Z");
  await rollJournal(owner, await journalPage(other.jid), "2026-11-18", "2026-11-17");
  assert.deepEqual(await liveDates(other.jid), ["2026-11-16", "2026-11-18"]);
  assert.ok((await one<Page>("SELECT * FROM pages WHERE id=?", other.d17))?.deleted_at);
});

test("after a wait, “today” is the day the run went on", async () => {
  const { jid } = await setup("wait", { ticked: null });
  clock("2026-11-17T22:50:00Z");
  const t = node("trigger.manual", {});
  const wait = node("logic.wait", { mode: "duration", amount: 20, unit: "minutes" });
  const append = node("action.journal.append", { journal: jid, day: "today", content: "Nach dem Warten" });
  const { pageId } = await workflow("Warten", { ...chain(t, wait, append), settings: { timeZone: BERLIN, triggerOnOwnChanges: false, limits: {} } });
  await act({ action: "workflow.run", pageId, inputs: {} });
  await drainWorkflows();
  assert.equal((await runsOf(pageId)).at(-1)!.status, "waiting");
  clock("2026-11-17T23:15:00Z");
  await run("UPDATE workflow_steps SET due_at=? WHERE due_at>?", Date.now(), Date.now());
  await drainWorkflows();
  const r = (await runsOf(pageId)).at(-1)!;
  assert.equal(r.status, "succeeded", r.error || "");
  assert.equal((await outputOf(r.id, append.id)).date, "2026-11-18");
  // The 17th stays although it had only carried tasks.
  await assertDays(jid, ["2026-11-16", "2026-11-17", "2026-11-18"]);
});

test("a workflow made in Berlin runs “täglich · 23:55” at 23:55 Berlin, before midnight", async () => {
  // The reporter's run came at 00:55 Berlin: the workflow's time zone was
  // UTC, the default of every new workflow.
  const { jid, d17 } = await setup("made");
  const zoneOf = async (pageId: string) => {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, (await one<{ state: Uint8Array }>("SELECT state FROM workflow_drafts WHERE page_id=?", pageId))!.state);
    return draftGraph(doc).settings;
  };
  const pageId = (await act({ action: "page.create", workspaceId: wid, spaceId: space, kind: "workflow", title: "Nacht made", timeZone: BERLIN })).id as string;
  const settings = await zoneOf(pageId);
  assert.equal(settings.timeZone, BERLIN);
  // Not a time zone: the old default.
  const odd = (await act({ action: "page.create", workspaceId: wid, spaceId: space, kind: "workflow", title: "Odd", timeZone: "Mars/Olympus" })).id as string;
  assert.equal((await zoneOf(odd)).timeZone, "UTC");
  const t = node("trigger.schedule", { freq: "daily", interval: 1, time: "23:55" }, "Zeitplan");
  const read = node("action.journal.read", { journal: jid, day: "today" }, "Journaltag lesen");
  const prompt = node("ai.prompt", { prompt: PROMPT(read.id) }, "KI: Eigene Anweisung");
  const append = node("action.journal.append", { journal: jid, day: "today", content: `{{${prompt.id}.text}}` }, "An Journaltag anhängen");
  await S.redraft(pageId, { ...chain(t, read, prompt, append), settings });
  await run("UPDATE workflows SET activated_at=? WHERE page_id=?", Date.parse("2026-11-17T08:00:00Z"), pageId);
  ai.answer = () => "# Tageszusammenfassung – Erledigte Aufgaben";
  // Not at 22:50 UTC (23:50 Berlin) yet, at 22:55 UTC it is.
  clock("2026-11-17T22:50:00Z");
  assert.equal(await processWorkflowSchedules(Date.now()), 0);
  clock("2026-11-17T22:55:30Z");
  assert.equal(await processWorkflowSchedules(Date.now()), 1);
  await drainWorkflows();
  const r = (await runsOf(pageId)).at(-1)!;
  assert.equal(r.status, "succeeded", r.error || "");
  assert.equal((await outputOf(r.id, append.id)).date, "2026-11-17");
  assert.match(await html(d17!), /Tageszusammenfassung/);
  // Opening the journal after midnight keeps the 17th: it has the summary.
  clock("2026-11-17T23:10:00Z");
  await rollJournal(owner, await journalPage(jid), berlinDay(), "2026-11-17");
  await assertDays(jid, ["2026-11-16", "2026-11-17", "2026-11-18"]);
});

test("the reporter's night with the old UTC default: the 17th has tasks done elsewhere, opening the journal keeps it, the late run appends to it", async () => {
  // What happened: the run fires 23:55 UTC = 00:55 Berlin. Opening the
  // journal at 00:10 Berlin starts the 18th; the 17th had nothing of its
  // own, only carried tasks and "An diesem Tag erledigt" – it was removed
  // for good. Now that list keeps the day.
  const { jid, d17 } = await setup("old");
  const { pageId, append } = await nightly("old", jid);
  clock("2026-11-17T23:10:00Z");
  await rollJournal(owner, await journalPage(jid), berlinDay(), "2026-11-17", false, { zone: BERLIN });
  const [, k17, k18] = await assertDays(jid, ["2026-11-16", "2026-11-17", "2026-11-18"]);
  assert.equal(k17.id, d17);
  assert.doesNotMatch(await html(d17!), /Offen A old/);
  assert.match(await html(k18.id), /Offen A old/);
  const r = await fire(pageId, "2026-11-17T23:55:00Z");
  const out = await outputOf(r.id, append.id);
  assert.deepEqual([out.date, out.created, out.day.id], ["2026-11-17", false, d17]);
  await assertDays(jid, ["2026-11-16", "2026-11-17", "2026-11-18"]);
  assert.match(await html(d17!), /Tageszusammenfassung/);
});

test("nothing done on the 17th: opening the journal moves it to the trash, the late run brings it back from there", async () => {
  const { jid, d17 } = await setup("empty", { ticked: null });
  await forgetCompleted();
  const { pageId, append } = await nightly("empty", jid);
  clock("2026-11-17T23:10:00Z");
  await rollJournal(owner, await journalPage(jid), berlinDay(), "2026-11-17", false, { zone: BERLIN });
  assert.deepEqual(await liveDates(jid), ["2026-11-16", "2026-11-18"]);
  const trashed = (await one<Page>("SELECT * FROM pages WHERE id=?", d17))!;
  assert.ok(trashed.deleted_at);
  assert.equal(trashed.journal_date, "2026-11-17");
  // In the trash without the tasks that moved on to the 18th.
  assert.doesNotMatch(await html(d17!), /Offen A empty/);
  const r = await fire(pageId, "2026-11-17T23:55:00Z", undefined, () => "Heute wurden keine Aufgaben erledigt 🙃");
  const out = await outputOf(r.id, append.id);
  assert.deepEqual([out.date, out.created, out.day.id], ["2026-11-17", true, d17]);
  const [, k17, k18] = await assertDays(jid, ["2026-11-16", "2026-11-17", "2026-11-18"]);
  assert.equal(k17.id, d17);
  assert.match(await html(d17!), /Heute wurden keine Aufgaben erledigt/);
  assert.match(await html(k18.id), /Offen A empty/);
  assert.doesNotMatch(await html(d17!), /Offen A empty/);
});
