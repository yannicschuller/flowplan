// "Journaltag lesen" (#273, action.journal.read in lib/workflows/nodes/
// journal.ts): a workflow started by hand has no journal day of its own –
// this node reads a day's text and its list "An diesem Tag erledigt" for the
// steps after it, as the person the workflow runs as. The reporter's
// workflow: Manuell starten → Journaltag lesen → KI: Eigene Anweisung →
// An Journaltag anhängen. Against a stub model, no real AI calls.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity, Page } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-wf-journal-read-"));
process.env.FLOWPLAN_AI_REQUESTS_PER_HOUR = "100000";
delete process.env.FLOWPLAN_AI;
const { run, one } = await import("../lib/db");
const { database } = await import("../lib/api");
const { rollJournal } = await import("../lib/journal");
const { htmlState } = await import("../lib/document-server");
const { drainWorkflows } = await import("../lib/workflows/queue");
const { nodeSpec } = await import("../lib/workflows/catalog");
const { compactCatalog } = await import("../lib/workflows/ai-builder");
const { startOllamaMock } = await import("./helpers/ai-mock");
const S = await import("./helpers/workflow-setup");
const { act, owner, editor, node, chain, workflow, runsOf, outputOf, manual, wid, space } = S;

const admin = { ...owner, isAdmin: true };
const mock = await startOllamaMock();
after(() => mock.close());
await act({ action: "admin.ai", settings: { enabled: true, provider: { kind: "ollama", baseUrl: mock.base, model: "chat", embeddingModel: "" } } }, admin);

const today = new Date().toISOString().slice(0, 10);
const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const page = async (pageId: string) => (await one<Page>("SELECT * FROM pages WHERE id=?", pageId))!;
const lastRun = async (pageId: string) => (await runsOf(pageId)).at(-1)!;
const runIt = async (pageId: string) => {
  await manual(pageId);
  await drainWorkflows();
  return await lastRun(pageId);
};

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
async function done(pageId: string, title: string, as: Identity = owner) {
  const rowId = (await act({ action: "row.create", pageId, cells: { title, status: "Offen" } }, as)).id as string;
  const version = (await one<{ version: number }>("SELECT version FROM rows WHERE id=?", rowId))!.version;
  await act({ action: "row.update", pageId, rowId, version, cells: { status: "Erledigt" } }, as);
  return rowId;
}

const tasks = await tasksDatabase("Aufgaben");
await done(tasks, "Bericht schreiben");
await done(tasks, "Emils Aufgabe", editor);
// A private record of the owner: Emil does not see it, so his runs do not either.
const hidden = await done(tasks, "Olgas Geheimnis");
await act({ action: "row.access", pageId: tasks, rowId: hidden, access: "private", grants: [] });
const journalId = (await act({ action: "page.create", workspaceId: wid, spaceId: space, title: "Journal", kind: "journal" })).id as string;
const { dayId } = await rollJournal(owner, await page(journalId), today, today);
await run("UPDATE documents SET html=?,state=? WHERE page_id=?", "<p>Langer Arbeitstag.</p>", htmlState("<p>Langer Arbeitstag.</p>"), dayId);
// The owner's choice below the day: "Alle".
await act({ action: "journal.completedMine", pageId: journalId, mine: false });

test("the catalogue lists the node; the check finds what is missing", async () => {
  const spec = nodeSpec("action.journal.read")!;
  assert.equal(spec.category, "pages");
  assert.deepEqual(spec.name, ["Journaltag lesen", "Read journal day"]);
  assert.deepEqual(spec.outputs.map((o) => o.key), ["content", "completed", "day", "date", "journal", "found"]);
  assert.match(compactCatalog(), /action\.journal\.read \[out\]/);
  const doc = (await act({ action: "page.create", workspaceId: wid, spaceId: space, title: "Kein Journal" })).id as string;
  const t = node("trigger.manual", {});
  const empty = await workflow("Leer", chain(t, node("action.journal.read", { journal: "", day: "date", date: "" })), owner, false);
  assert.deepEqual(empty.issues.filter((i) => i.level === "error").map((i) => i.code).sort(), ["no_journal", "no_journal_date"]);
  const wrong = await workflow("Falsch", chain(node("trigger.manual", {}), node("action.journal.read", { journal: doc })), owner, false);
  assert.ok(wrong.issues.some((i) => i.code === "unknown_journal" && i.level === "error"));
});

test("the reporter's workflow: manual start → read today → own AI instruction → append to the day", async () => {
  mock.answer = () => "Heute: Bericht geschrieben, Emil hat seine Aufgabe erledigt.";
  const t = node("trigger.manual", {});
  const read = node("action.journal.read", { journal: journalId, day: "today" }, "Heute lesen");
  const ai = node("ai.prompt", { prompt: `Schreibe eine lange und detaillierte Zusammenfassung des Tages:\n{{${read.id}.content}}` }, "KI: Eigene Anweisung");
  const append = node("action.journal.append", { journal: journalId, day: "today", content: `{{${ai.id}.text}}` }, "Anhängen");
  const { pageId } = await workflow("Tagesrückblick", chain(t, read, ai, append));
  const r = await runIt(pageId);
  assert.equal(r.status, "succeeded", r.error || "");
  const out = await outputOf(r.id, read.id);
  assert.equal(out.found, true);
  assert.equal(out.day.id, dayId);
  assert.equal(out.date, today);
  assert.deepEqual(out.completed, ["Bericht schreiben (Aufgaben)", "Emils Aufgabe (Aufgaben)", "Olgas Geheimnis (Aufgaben)"]);
  assert.match(out.content, /^Langer Arbeitstag\.\n\n## .+\n- \[x\] Bericht schreiben \(Aufgaben\)\n- \[x\] Emils Aufgabe \(Aufgaben\)\n- \[x\] Olgas Geheimnis \(Aufgaben\)$/);
  // What reached the model: the day's text and the completed tasks.
  const prompt = mock.chats.at(-1)!.prompt;
  assert.match(prompt, /Langer Arbeitstag\./);
  assert.match(prompt, /Bericht schreiben \(Aufgaben\)/);
  assert.match(prompt, /Emils Aufgabe/);
  assert.match((await one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", dayId))!.html, /Bericht geschrieben/);
});

test("a day not made yet reads as empty text; as another person, their own view", async () => {
  const t = node("trigger.manual", {});
  const read = node("action.journal.read", { journal: journalId, day: "yesterday" });
  const { pageId } = await workflow("Gestern", chain(t, read));
  const r = await runIt(pageId);
  assert.equal(r.status, "succeeded", r.error || "");
  const out = await outputOf(r.id, read.id);
  assert.deepEqual({ found: out.found, day: out.day, date: out.date, completed: out.completed, content: out.content }, { found: false, day: null, date: yesterday, completed: [], content: "" });
  // Emil runs it on today: "Nur meine" (his default) gives his own; "Alle"
  // all he may see – the owner's private record stays out.
  const t2 = node("trigger.manual", {});
  const read2 = node("action.journal.read", { journal: journalId, day: "today" });
  const mine = await workflow("Emils Tag", chain(t2, read2), editor);
  const r2 = await runIt(mine.pageId);
  assert.equal(r2.status, "succeeded", r2.error || "");
  assert.deepEqual((await outputOf(r2.id, read2.id)).completed, ["Emils Aufgabe (Aufgaben)"]);
  await act({ action: "journal.completedMine", pageId: journalId, mine: false }, editor);
  const r3 = await runIt(mine.pageId);
  assert.deepEqual((await outputOf(r3.id, read2.id)).completed, ["Bericht schreiben (Aufgaben)", "Emils Aufgabe (Aufgaben)"]);
});

test("closed to the AI: the AI step refuses the day; a journal with a PIN is refused", async () => {
  const t = node("trigger.manual", {});
  const read = node("action.journal.read", { journal: journalId });
  const ai = node("ai.summarize", { text: `{{${read.id}.content}}` });
  const { pageId } = await workflow("Gesperrt", chain(t, read, ai));
  await run("INSERT INTO ai_access_rules(user_id,target_id,kind,workspace_id,mode) VALUES(?,?,?,?,?)", owner.id, journalId, "page", wid, "exclude");
  const asked = mock.chats.length;
  const r = await runIt(pageId);
  assert.equal(r.status, "failed");
  assert.match(r.error || "", /für die KI gesperrt/);
  assert.equal(mock.chats.length, asked, "nothing reached the model");
  await run("DELETE FROM ai_access_rules WHERE user_id=?", owner.id);
  // A PIN set after activation: the run stops, even while unlocked.
  await act({ action: "journal.lock", pageId: journalId, pin: "471108" });
  await act({ action: "journal.unlock", pageId: journalId, pin: "471108" });
  const locked = await runIt(pageId);
  assert.equal(locked.status, "failed");
  assert.match(locked.error || "", /PIN/);
  const again = await workflow("PIN", chain(node("trigger.manual", {}), node("action.journal.read", { journal: journalId })), owner, false);
  assert.ok(again.issues.some((i) => i.code === "unknown_journal" && i.level === "error"));
});
