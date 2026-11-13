// #273: the list "An diesem Tag erledigt" below a journal day is not in the
// day's document – it reaches the AI (Ask "Diese Seite", the writing
// assistant, summaries) and the journal workflow nodes all the same, as the
// reader sees it and only what the AI may read (lib/ai/journal-completed.ts).
// Against a stub model (tests/helpers/ai-mock.ts), no real AI calls.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity, Page } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-ai-journal-completed-"));
process.env.FLOWPLAN_AI_REQUESTS_PER_HOUR = "100000";
delete process.env.FLOWPLAN_AI;
delete process.env.FLOWPLAN_AI_FEATURES;
delete process.env.FLOWPLAN_ENCRYPTION_KEY;
const { id, run, one } = await import("../lib/db");
const { command, database, bootstrap } = await import("../lib/api");
const { createWorkspace, createPage } = await import("../lib/seed");
const { identityFromToken } = await import("../lib/auth");
const { rollJournal } = await import("../lib/journal");
const { withContentLocale } = await import("../lib/content-locale");
const { htmlState } = await import("../lib/document-server");
const { aiPageMarkdown, aiPageParts } = await import("../lib/ai/content");
const { aiCompletedSection, completedSection } = await import("../lib/ai/journal-completed");
const { prepareAsk } = await import("../lib/ai/ask");
const { triggerOutput } = await import("../lib/workflows/nodes/triggers");
const { completedValue } = await import("../lib/workflows/nodes/journal-completed");
const { nodeSpec } = await import("../lib/workflows/catalog");
const { startOllamaMock } = await import("./helpers/ai-mock");

async function person(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name.toLowerCase()}@example.test`);
  const token = randomBytes(16).toString("hex");
  await run("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)", createHash("sha256").update(token).digest("hex"), uid, "[]", Date.now() + 3600_000);
  return (await identityFromToken(token))!;
}
const admin = { ...(await person("Ada")), isAdmin: true };
const ben = await person("Ben");
const wid = await createWorkspace(admin.id, "Journal");
await run("INSERT INTO members VALUES(?,?,?)", wid, ben.id, "editor");
const space = (await bootstrap(admin, wid)).spaces[0].id;
const act = async (body: Record<string, unknown>, as: Identity = admin): Promise<any> => await command(as, body);

const mock = await startOllamaMock();
after(() => mock.close());
await act({ action: "admin.ai", settings: { enabled: true, provider: { kind: "ollama", baseUrl: mock.base, model: "chat", embeddingModel: "" } } });

async function tasksDatabase(title: string, parentId?: string) {
  const pageId = (await act({ action: "page.create", workspaceId: wid, spaceId: space, kind: "database", title, databaseKind: "empty", ...(parentId ? { parentId } : {}) })).id as string;
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
// A record made done by `as` at a given moment (the log takes the time of the change).
async function doneRecord(pageId: string, title: string, at: string, as: Identity = admin) {
  const rowId = (await act({ action: "row.create", pageId, cells: { title, status: "Offen" } }, as)).id as string;
  await act({ action: "row.update", pageId, rowId, version: await version(rowId), cells: { status: "Erledigt" } }, as);
  const last = (await one<{ id: string }>("SELECT id FROM row_status_log WHERE row_id=? AND done=1 ORDER BY at DESC LIMIT 1", rowId))!;
  await run("UPDATE row_status_log SET at=? WHERE id=?", Date.parse(at), last.id);
  return rowId;
}
const page = async (pageId: string) => (await one<Page>("SELECT * FROM pages WHERE id=?", pageId))!;

const DATE = "2026-11-12";
const tasks = await tasksDatabase("Aufgaben");
const journalId = (await act({ action: "page.create", workspaceId: wid, spaceId: space, title: "Tagebuch", kind: "journal" })).id as string;
const { dayId } = await rollJournal(admin, await page(journalId), DATE, DATE);
await run("UPDATE documents SET html=?,state=? WHERE page_id=?", "<p>Ein ruhiger Tag.</p>", htmlState("<p>Ein ruhiger Tag.</p>"), dayId);
const report = await doneRecord(tasks, "Bericht schreiben", `${DATE}T09:00:00Z`);
const privateRow = await doneRecord(tasks, "Geheimes Projekt", `${DATE}T10:00:00Z`);
await act({ action: "row.access", pageId: tasks, rowId: privateRow, access: "private", grants: [] });
await doneRecord(tasks, "Bens Aufgabe", `${DATE}T11:00:00Z`, ben);
// Another day: not listed.
await doneRecord(tasks, "Gestern erledigt", "2026-11-11T09:00:00Z");

test("the context of a journal day ends with what was completed that day", async () => {
  const markdown = await withContentLocale("en", async () => await aiPageMarkdown(admin, await page(dayId), null, { zone: "UTC" }));
  assert.match(markdown, /Ein ruhiger Tag\./);
  // "Only mine" (the default): done by Ada; her private record is hers.
  assert.match(markdown, /## Completed this day \(Only mine\)\n- \[x\] Bericht schreiben \(Aufgaben\)\n- \[x\] Geheimes Projekt \(Aufgaben\)$/);
  assert.doesNotMatch(markdown, /Bens Aufgabe|Gestern erledigt/);
  // The reader's choice "Alle" counts here as below the day.
  await act({ action: "journal.completedMine", pageId: journalId, mine: false });
  const all = await withContentLocale("de", async () => await aiPageMarkdown(admin, await page(dayId), null, { zone: "UTC" }));
  assert.match(all, /## An diesem Tag erledigt\n- \[x\] Bericht schreiben \(Aufgaben\)\n- \[x\] Geheimes Projekt \(Aufgaben\)\n- \[x\] Bens Aufgabe \(Aufgaben\)$/);
  // The time zone decides the day: 09:00–11:00 UTC is still the 11th at UTC−12.
  assert.equal(await aiCompletedSection(admin, await page(dayId), { zone: "Etc/GMT+12" }), "");
  // Nothing went into the document.
  assert.doesNotMatch(String((await one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", dayId))!.html), /Bericht/);
});

test("another person's private record stays out; records closed to the AI too", async () => {
  await act({ action: "journal.completedMine", pageId: journalId, mine: false }, ben);
  const forBen = await aiPageMarkdown(ben, await page(dayId), null, { zone: "UTC" });
  assert.match(forBen, /Bericht schreiben/);
  assert.match(forBen, /Bens Aufgabe/);
  assert.doesNotMatch(forBen, /Geheimes Projekt/);
  // Ben closes the database to the AI: the list he sees below the day still
  // has it, the AI does not get it.
  await run("INSERT INTO ai_access_rules(user_id,target_id,kind,workspace_id,mode) VALUES(?,?,?,?,?)", ben.id, tasks, "page", wid, "exclude");
  assert.equal(await aiCompletedSection(ben, await page(dayId), { zone: "UTC" }), "");
  assert.deepEqual(await completedValue(ben, dayId, "UTC"), []);
  await run("DELETE FROM ai_access_rules WHERE user_id=?", ben.id);
});

test("journals with a PIN stay closed to the AI, even while unlocked", async () => {
  const pinJournal = (await act({ action: "page.create", workspaceId: wid, spaceId: space, title: "Privat", kind: "journal" })).id as string;
  const pinTasks = await tasksDatabase("PIN-Aufgaben", pinJournal);
  await doneRecord(pinTasks, "Hinter der PIN", `${DATE}T12:00:00Z`);
  const { dayId: pinDay } = await rollJournal(admin, await page(pinJournal), DATE, DATE);
  await act({ action: "journal.lock", pageId: pinJournal, pin: "471108" });
  await act({ action: "journal.unlock", pageId: pinJournal, pin: "471108" });
  // A database below the locked journal, done on the day of the open journal: not for the AI.
  const open = await aiPageMarkdown(admin, await page(dayId), null, { zone: "UTC" });
  assert.match(open, /Bericht schreiben/);
  assert.doesNotMatch(open, /Hinter der PIN/);
  // The locked journal's own day: closed as a whole.
  await assert.rejects(aiPageMarkdown(admin, await page(pinDay), null, { zone: "UTC" }), /für die KI gesperrt/);
  assert.equal(await aiCompletedSection(admin, await page(pinDay), { zone: "UTC" }), "");
  assert.deepEqual(await completedValue(admin, pinDay, "UTC"), []);
});

test("pages that are no journal day are unchanged; a switched-off list stays out", async () => {
  const doc = await createPage(wid, space, admin.id, "Notizen");
  await run("UPDATE documents SET html=?,state=? WHERE page_id=?", "<p>Nur Text.</p>", htmlState("<p>Nur Text.</p>"), doc);
  const parts = await aiPageParts(admin, await page(doc), null, { zone: "UTC" });
  assert.equal(parts.completed, "");
  assert.equal(await aiPageMarkdown(admin, await page(doc), null, { zone: "UTC" }), parts.body);
  assert.doesNotMatch(parts.body, /erledigt|Completed/i);
  // A record's document: no list either.
  assert.equal((await aiPageParts(admin, await page(tasks), report, { zone: "UTC" })).completed, "");
  // The journal's own page and a day of a journal with the list switched off.
  assert.equal(await aiCompletedSection(admin, await page(journalId), { zone: "UTC" }), "");
  const quiet = (await act({ action: "page.create", workspaceId: wid, spaceId: space, title: "Ohne Liste", kind: "journal" })).id as string;
  const { dayId: quietDay } = await rollJournal(admin, await page(quiet), DATE, DATE);
  assert.notEqual(await aiCompletedSection(admin, await page(quietDay), { zone: "UTC" }), "");
  await act({ action: "journal.settings", pageId: quiet, options: { completed: false } });
  assert.equal(await aiCompletedSection(admin, await page(quietDay), { zone: "UTC" }), "");
});

test("long lists are cut with a note", () => {
  const items = Array.from({ length: 200 }, (_, i) => ({ pageId: "p", rowId: `r${i}`, title: `Aufgabe ${i}`, database: "Liste", icon: "", at: i }));
  const section = withContentLocale("en", () => completedSection({ items, more: 37, mine: false }));
  assert.equal(section.split("\n").filter((l) => l.startsWith("- [x]")).length, 200);
  assert.match(section, /- … and 37 more$/);
  // The character budget cuts as well, the note counts the rest.
  const small = withContentLocale("en", () => completedSection({ items, more: 0, mine: false }, "en", 200));
  const shown = small.split("\n").filter((l) => l.startsWith("- [x]")).length;
  assert.ok(shown > 0 && shown < 20);
  assert.match(small, new RegExp(`- … and ${200 - shown} more$`));
  // A title without text, line breaks in a title.
  assert.equal(completedSection({ items: [{ ...items[0], title: "", database: "Liste" }, { ...items[1], title: "Zwei\nZeilen" }], more: 0, mine: false }, "en"), "## Completed this day\n- [x] Untitled (Liste)\n- [x] Zwei Zeilen (Liste)");
});

test("Ask with “Diese Seite” on a journal day hands the list to the model", async () => {
  await act({ action: "journal.completedMine", pageId: journalId, mine: false });
  const prepared = await withContentLocale("en", async () => await prepareAsk(admin, { workspaceId: wid, question: "Summarize all tasks completed today", page: { pageId: dayId }, zone: "UTC" }));
  assert.deepEqual(prepared.page, { pageId: dayId, truncated: false });
  const prompt = prepared.messages[prepared.messages.length - 1].content;
  assert.match(prompt, /## Completed this day\n- \[x\] Bericht schreiben \(Aufgaben\)/);
  assert.match(prompt, /Bens Aufgabe/);
});

test("the journal workflow nodes give the day's completed tasks as `completed`", async () => {
  for (const type of ["trigger.journal.day", "action.journal.append"])
    assert.deepEqual(nodeSpec(type)!.outputs.find((o) => o.key === "completed"), { key: "completed", label: ["An diesem Tag erledigt", "Completed this day"], type: "list", item: "text" });
  await act({ action: "journal.completedMine", pageId: journalId, mine: false }, ben);
  const output = await triggerOutput("trigger.journal.day", { workspace_id: wid, page_id: dayId, row_id: null, actor_id: ben.id }, { date: DATE, journal: journalId }, ben, { timeZone: "UTC" });
  assert.deepEqual(output.completed, ["Bericht schreiben (Aufgaben)", "Bens Aufgabe (Aufgaben)"]);
  // Somebody who may not open the day gets nothing.
  const stranger = await person("Sam");
  assert.deepEqual(await completedValue(stranger, dayId, "UTC"), []);
  assert.deepEqual(await completedValue(null, dayId, "UTC"), []);
});
