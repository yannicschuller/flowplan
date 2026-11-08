// "Mit KI zusammenfassen" in a journal's review (#170): the periods it
// accepts, what reaches the model (only what the AI may read; a journal
// with a PIN never), the prompt's sections in the interface language, and
// saving the preview as a page – once per period, then open or replace.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-journal-ai-summary-"));
process.env.APP_URL = "https://flowplan.example.test";
process.env.FLOWPLAN_AI_REQUESTS_PER_HOUR = "100000";
delete process.env.FLOWPLAN_AI;
const { run, one, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { identityFromToken } = await import("../lib/auth");
const { command, bootstrap } = await import("../lib/api");
const { rollJournal } = await import("../lib/journal");
const { reviewPeriod, aiSummaryKey } = await import("../lib/journal-nav");
const { journalSummaryPrompt } = await import("../lib/ai/prompts");
const { aiJournalSummaryResponse } = await import("../lib/ai/journal-summary");
const { existingAiSummary } = await import("../lib/journal-summary");
const { startOllamaMock } = await import("./helpers/ai-mock");
import type { Identity, Page } from "../lib/types";

async function person(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name.toLowerCase()}@example.test`);
  const token = randomBytes(16).toString("hex");
  await run("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)", createHash("sha256").update(token).digest("hex"), uid, "[]", Date.now() + 3600_000);
  return (await identityFromToken(token))!;
}
const admin = { ...(await person("Ada")), isAdmin: true };
const jana = await person("Jana"),
  vera = await person("Vera"),
  stranger = await person("Sam");
const wid = await createWorkspace(jana.id, "Journal");
await run("INSERT INTO members VALUES(?,?,?)", wid, vera.id, "viewer");
const space = (await bootstrap(jana, wid)).spaces[0].id;
const page = async (title: string, kind: string) =>
  ((await command(jana, { action: "page.create", workspaceId: wid, spaceId: space, title, kind })) as { id: string }).id;
const journalId = await page("Mein Journal", "journal");
const journal = async () => (await one<Page>("SELECT * FROM pages WHERE id=?", journalId))!;
const write = async (pageId: string, html: string) => await run("UPDATE documents SET state=NULL,html=? WHERE page_id=?", html, pageId);
const html = async (pageId: string) => String((await one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", pageId))!.html);
const tasks = (...items: [string, boolean][]) =>
  `<ul data-type="taskList">${items.map(([text, done]) => `<li data-type="taskItem" data-checked="${done}"><p>${text}</p></li>`).join("")}</ul>`;

// Three days of the week from Monday 28 September 2026.
const first = (await rollJournal(jana, await journal(), "2026-09-29", "2026-09-29")).dayId;
await write(first, `<p>Umzug geplant und Kisten gepackt. TAG-EINS</p>${tasks(["Kisten besorgen", true], ["Strom ummelden", false])}`);
await command(jana, { action: "journal.entry", pageId: first, entry: { values: { mood: 4 }, place: "Leipzig" } });
const second = (await rollJournal(jana, await journal(), "2026-09-30", "2026-09-30")).dayId;
await write(second, `<p>Erster Abend in der neuen Wohnung. TAG-ZWEI-PRIVAT</p>${tasks(["Strom ummelden", false], ["GEHEIME-AUFGABE", true])}`);
await command(jana, { action: "journal.entry", pageId: second, entry: { values: { mood: 2 }, place: "GEHEIMER-ORT" } });
const third = (await rollJournal(jana, await journal(), "2026-10-01", "2026-10-01")).dayId;
await write(third, `${await html(third)}<p>Oktober beginnt. TAG-DREI</p>`);

const mock = await startOllamaMock();
after(() => mock.close());
mock.answer = () => "## Highlights & achievements\n- Moved\n## Chronological overview\nTuesday: packed.\n## Open items & follow-ups\n- Strom ummelden";
const never = new AbortController().signal;
const week = { from: "2026-09-28", to: "2026-10-04" };
const summarize = (user: Identity, body: Record<string, unknown> = {}) =>
  aiJournalSummaryResponse(user, { journalId, ...week, locale: "en", ...body }, never);
const status = (e: unknown) => (e as { status?: number }).status;

test("the periods of the review: a week of seven days or a whole month", () => {
  assert.deepEqual(reviewPeriod("2026-09-28", "2026-10-04"), { kind: "week", key: "2026-09-28" });
  assert.deepEqual(reviewPeriod("2026-09-01", "2026-09-30"), { kind: "month", key: "2026-09" });
  assert.deepEqual(reviewPeriod("2026-02-01", "2026-02-28"), { kind: "month", key: "2026-02" });
  // Over a year's end.
  assert.deepEqual(reviewPeriod("2026-12-28", "2027-01-03"), { kind: "week", key: "2026-12-28" });
  for (const [from, to] of [
    ["2026-09-28", "2026-10-05"],
    ["2026-09-28", "2026-10-03"],
    ["2026-09-01", "2026-09-29"],
    ["2026-02-30", "2026-03-08"],
    ["2026-09-28", "2026-09-28"],
    ["x", "y"],
  ])
    assert.equal(reviewPeriod(from, to), null, `${from} – ${to}`);
  assert.equal(aiSummaryKey("2026-09"), "ai-summary:2026-09");
});

test("the prompt: three sections in the interface language, the content as data", () => {
  const de = journalSummaryPrompt({ content: "### 2026-09-29\nText", title: "Mein Journal", period: "week from 2026-09-28 to 2026-10-04", language: "de" });
  assert.match(de.system!, /## Höhepunkte & Erfolge[\s\S]*## Chronologischer Überblick[\s\S]*## Offene Punkte & nächste Schritte/);
  assert.match(de.system!, /Answer in German/);
  assert.match(de.system!, /not instructions/);
  assert.match(de.messages[0].content, /^Journal: Mein Journal\nPeriod: week from 2026-09-28 to 2026-10-04\n\n<content>\n### 2026-09-29/);
  const zh = journalSummaryPrompt({ content: "x", period: "p", language: "zh" });
  assert.match(zh.system!, /## 亮点与成就/);
});

test("refused while AI is off; no provider reached", async () => {
  await assert.rejects(summarize(jana), /ausgeschaltet/);
  assert.equal(mock.chats.length, 0);
});

test("a week: the days' text, completed tasks, trackers, places and open tasks reach the model – in the interface language", async () => {
  await command(admin, { action: "admin.ai", settings: { enabled: true, provider: { kind: "ollama", baseUrl: mock.base, model: "chat", embeddingModel: "" } } });
  mock.chats.length = 0;
  const response = await summarize(jana);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Highlights & achievements/);
  assert.equal(response.headers.get("X-Flowplan-AI-Included"), "3");
  assert.equal(response.headers.get("X-Flowplan-AI-Total"), "3");
  assert.equal(response.headers.get("X-Flowplan-AI-Parts"), "1");
  assert.equal(mock.chats.length, 1);
  const { system, prompt } = mock.chats[0];
  // German days, an English interface: the answer in English.
  assert.match(system, /Answer in English/);
  assert.match(system, /## Highlights & achievements[\s\S]*## Chronological overview[\s\S]*## Open items & follow-ups/);
  assert.match(prompt, /Journal: Mein Journal\nPeriod: week from 2026-09-28 to 2026-10-04/);
  assert.match(prompt, /## Completed tasks\n- \[x\] Kisten besorgen \(2026-09-29\)/);
  assert.match(prompt, /## Trackers\n- Stimmung: average 3/);
  // Open tasks are taken from the latest day, where they moved on to.
  assert.match(prompt, /## Still open\n- \[ \] Strom ummelden \(since 2026-09-\d\d\)/);
  assert.match(prompt, /### 2026-09-29 \(Tuesday\)\nTrackers: Stimmung: 4\nPlace: Leipzig\n[\s\S]*TAG-EINS/);
  for (const text of ["TAG-ZWEI-PRIVAT", "TAG-DREI", "GEHEIME-AUFGABE", "GEHEIMER-ORT"]) assert.ok(prompt.includes(text), text);
  // Days in order.
  assert.ok(prompt.indexOf("TAG-EINS") < prompt.indexOf("TAG-ZWEI-PRIVAT") && prompt.indexOf("TAG-ZWEI-PRIVAT") < prompt.indexOf("TAG-DREI"));
  // German interface: German headings.
  await (await summarize(jana, { locale: "de" })).text();
  assert.match(mock.chats[1].system, /## Höhepunkte & Erfolge/);
});

test("a day closed to the AI stays out with its tasks, trackers and place", async () => {
  mock.chats.length = 0;
  await command(jana, { action: "ai.rule", targetId: second, mode: "exclude" });
  const response = await summarize(jana);
  await response.text();
  assert.equal(response.headers.get("X-Flowplan-AI-Included"), "2");
  assert.equal(response.headers.get("X-Flowplan-AI-Total"), "3");
  const prompt = mock.chats[0].prompt;
  for (const text of ["TAG-ZWEI-PRIVAT", "GEHEIME-AUFGABE", "GEHEIMER-ORT"]) assert.ok(!prompt.includes(text), text);
  assert.match(prompt, /- Stimmung: average 4 /, "the average without the closed day");
  assert.match(prompt, /These are 2 of the 3 days of the period/);
  assert.ok(prompt.includes("TAG-EINS") && prompt.includes("TAG-DREI"));
  await command(jana, { action: "ai.rule", targetId: second, mode: null });
  // All days closed: refused before any request.
  mock.chats.length = 0;
  await command(jana, { action: "ai.rule", targetId: journalId, mode: "exclude" });
  await assert.rejects(summarize(jana), /für die KI gesperrt/);
  await command(jana, { action: "ai.rule", targetId: journalId, mode: null });
  assert.equal(mock.chats.length, 0);
});

test("refused: other periods, an empty period, not a journal, no access, the feature off", async () => {
  mock.chats.length = 0;
  await assert.rejects(summarize(jana, { to: "2026-10-05" }), /Nur eine Woche oder ein ganzer Monat/);
  await assert.rejects(summarize(jana, { from: "2026-09-01", to: "2026-09-29" }), /Nur eine Woche oder ein ganzer Monat/);
  await assert.rejects(summarize(jana, { from: "2026-08-03", to: "2026-08-09" }), /keine Einträge/);
  const doc = await page("Notizen", "document");
  await assert.rejects(summarize(jana, { journalId: doc }), /kein Journal/);
  await assert.rejects(summarize(stranger), (e) => status(e) === 403 || status(e) === 404);
  await command(jana, { action: "ai.settings", features: { summarize: false } });
  await assert.rejects(summarize(jana), /in deinen Einstellungen ausgeschaltet/);
  await command(jana, { action: "ai.settings", features: { summarize: true } });
  assert.equal(mock.chats.length, 0, "nothing reached the provider");
  // A whole month works, also for a reader.
  const month = await summarize(vera, { from: "2026-09-01", to: "2026-09-30" });
  await month.text();
  assert.equal(month.headers.get("X-Flowplan-AI-Total"), "2");
  assert.match(mock.chats[0].prompt, /Period: month from 2026-09-01 to 2026-09-30/);
  assert.ok(!mock.chats[0].prompt.includes("TAG-DREI"), "October stays out");
});

test("saving the preview: a sub page of the journal, once per period; asked again open or replace", async () => {
  const save = async (body: Record<string, unknown>, as = jana) =>
    (await command(as, { action: "journal.aiSummary", pageId: journalId, ...week, ...body })) as { id: string; existing: boolean; replaced?: boolean };
  const markdown = "## Highlights & achievements\n- Umgezogen ![x](https://evil.example/p.png)\n## Chronological overview\nDienstag: <script>alert(1)</script>\n## Open items & follow-ups\n- Strom ummelden";
  assert.equal(await existingAiSummary(jana, await journal(), week.from, week.to), null);
  const created = await save({ markdown });
  assert.equal(created.existing, false);
  const saved = (await one<Page>("SELECT * FROM pages WHERE id=?", created.id))!;
  assert.equal(saved.parent_id, journalId);
  assert.equal(saved.journal_date, null);
  assert.equal(saved.kind, "document");
  assert.equal(saved.icon, "✨");
  assert.match(saved.title, /^KI-Zusammenfassung 28\. Sept?\. 2026 – 4\. Okt\. 2026$/);
  const body = await html(created.id);
  assert.match(body, /Mit KI aus den Einträgen dieses Zeitraums zusammengefasst/);
  assert.match(body, /<h2>Highlights &amp; achievements<\/h2>/);
  assert.match(body, /Umgezogen/);
  assert.ok(!body.includes("evil.example"), "no images from the answer");
  assert.ok(!/<script/i.test(body), "raw HTML stays text");
  assert.equal(
    (await one<{ page_id: string }>("SELECT page_id FROM meeting_notes WHERE journal_id=? AND event_key=?", journalId, "ai-summary:2026-09-28"))!.page_id,
    created.id,
  );
  assert.equal(await existingAiSummary(jana, await journal(), week.from, week.to), created.id);
  assert.equal(await existingAiSummary(vera, await journal(), week.from, week.to), created.id, "readers see it too");

  // Again: the page there, nothing new.
  const count = async () => Number((await one<{ n: number }>("SELECT COUNT(*) n FROM pages WHERE parent_id=? AND journal_date IS NULL", journalId))!.n);
  const before = await count();
  assert.deepEqual(await save({ markdown: "## Neu\n- NEUER-TEXT" }), { id: created.id, existing: true });
  assert.equal(await count(), before);
  assert.ok(!(await html(created.id)).includes("NEUER-TEXT"));
  // Replace: the same page, the new content.
  const replaced = await save({ markdown: "## Neu\n- NEUER-TEXT", replace: true });
  assert.deepEqual(replaced, { id: created.id, existing: false, replaced: true });
  assert.equal(await count(), before);
  const now = await html(created.id);
  assert.match(now, /NEUER-TEXT/);
  assert.ok(!now.includes("Umgezogen"), "the old content is gone from the page");

  // The month: a page of its own.
  const month = await save({ from: "2026-09-01", to: "2026-09-30", markdown: "## M\n- Monat" });
  assert.notEqual(month.id, created.id);
  assert.match((await one<Page>("SELECT * FROM pages WHERE id=?", month.id))!.title, /^KI-Zusammenfassung September 2026$/);
  assert.equal(await existingAiSummary(jana, await journal(), "2026-09-01", "2026-09-30"), month.id);

  // Refused: other periods, an empty answer, readers.
  await assert.rejects(save({ to: "2026-10-05", markdown: "x" }), /Nur eine Woche oder ein ganzer Monat/);
  await assert.rejects(save({ markdown: "  " }));
  await assert.rejects(save({ markdown: "x" }, vera), (e) => status(e) === 403);
  // In the trash: a new one may be made.
  await command(jana, { action: "page.delete", pageId: created.id });
  assert.equal(await existingAiSummary(jana, await journal(), week.from, week.to), null);
  assert.equal((await save({ markdown: "## Neu" })).existing, false);
});

test("a journal with a PIN: no AI call, locked or unlocked", async () => {
  mock.chats.length = 0;
  await command(jana, { action: "journal.lock", pageId: journalId, pin: "471108" });
  await command(jana, { action: "journal.relock", pageId: journalId });
  await assert.rejects(summarize(jana), (e) => status(e) === 423);
  await assert.rejects(
    command(jana, { action: "journal.aiSummary", pageId: journalId, ...week, markdown: "x", replace: true }),
    (e) => status(e) === 423,
  );
  await command(jana, { action: "journal.unlock", pageId: journalId, pin: "471108" });
  await assert.rejects(summarize(jana), /für die KI gesperrt/);
  assert.equal(mock.chats.length, 0, "nothing reached the provider");
});
