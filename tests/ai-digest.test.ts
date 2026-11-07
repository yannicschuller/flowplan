import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-ai-digest-"));
process.env.APP_URL = "https://flowplan.example.test";
process.env.FLOWPLAN_AI_REQUESTS_PER_HOUR = "100000";
delete process.env.FLOWPLAN_AI;
const { run, one, all, id } = await import("../lib/db");
const { createWorkspace, createPage } = await import("../lib/seed");
const { identityFromToken } = await import("../lib/auth");
const { command } = await import("../lib/api");
const { prepareAsk, askWorkspaces } = await import("../lib/ai/ask");
const { setMailSender } = await import("../lib/mail");
const { setWeeklyDigest, weeklyDigestPrefs, digestDue, localTime, buildWeeklyDigest, queueWeeklyDigests, weeklyDigestMail } = await import("../lib/weekly-digest");
const { startOllamaMock } = await import("./helpers/ai-mock");
import type { Identity } from "../lib/types";

async function person(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name.toLowerCase()}@example.test`);
  const token = randomBytes(16).toString("hex");
  await run("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)", createHash("sha256").update(token).digest("hex"), uid, "[]", Date.now() + 3600_000);
  return (await identityFromToken(token))!;
}
const admin = { ...(await person("Ada")), isAdmin: true };
const ben = await person("Ben");
const html = async (page: string, body: string) => await run("UPDATE documents SET html=? WHERE page_id=?", body, page);
const firstSpace = async (w: string) => (await one<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=?", w))!.id;

// Ben belongs to three workspaces; in "Kunden" he is a guest.
const w1 = await createWorkspace(admin.id, "Team");
const w2 = await createWorkspace(admin.id, "Vertrieb");
const w3 = await createWorkspace(admin.id, "Kunden");
for (const w of [w1, w2]) await run("INSERT INTO members VALUES(?,?,?)", w, ben.id, "editor");
await run("INSERT INTO members VALUES(?,?,?)", w3, ben.id, "viewer");
await run("INSERT INTO workspace_guests VALUES(?,?)", w3, ben.id);
const p1 = await createPage(w1, await firstSpace(w1), admin.id, "Quartalsbericht Team");
await html(p1, "<p>Der Quartalsbericht zeigt ein Plus von zehn Prozent.</p>");
const p2 = await createPage(w2, await firstSpace(w2), admin.id, "Quartalsbericht Vertrieb");
await html(p2, "<p>Im Quartalsbericht des Vertriebs stehen drei neue Kunden.</p>");
const p2x = await createPage(w2, await firstSpace(w2), admin.id, "Quartalsbericht Gehälter");
await html(p2x, "<p>Quartalsbericht GEHALTSGEHEIMNIS.</p>");
const p3 = await createPage(w3, await firstSpace(w3), admin.id, "Quartalsbericht Kunden");
await html(p3, "<p>Quartalsbericht GASTINHALT.</p>");
// Followed by Ben, closed to the AI.
const blocked = await createPage(w1, await firstSpace(w1), admin.id, "Personal");
await html(blocked, "<p>Abmahnung SPERRINHALT wegen Verspätung.</p>");

const mock = await startOllamaMock();
after(() => mock.close());
const setAi = async (settings: Record<string, unknown>) => await command(admin, { action: "admin.ai", settings });

test("Ask across workspaces: every workspace with AI for the person, sources labelled", async () => {
  await setAi({ enabled: true, provider: { kind: "ollama", baseUrl: mock.base, model: "chat", embeddingModel: "" } });
  await command(ben, { action: "ai.rule", targetId: p2x, mode: "exclude" });
  assert.deepEqual(
    (await askWorkspaces(ben, w2)).map((w) => w.id),
    [w2, w1],
    "the current workspace first; guests without AI are left out",
  );
  const single = await prepareAsk(ben, { workspaceId: w1, question: "Was steht im Quartalsbericht?" });
  assert.deepEqual([...new Set(single.sources.map((s) => s.pageId))], [p1]);
  assert.ok(single.sources.every((s) => !s.workspaceName));
  const across = await prepareAsk(ben, { workspaceId: w1, question: "Was steht im Quartalsbericht?", scope: { kind: "all" } });
  const ids = across.sources.map((s) => s.pageId);
  assert.ok(ids.includes(p1) && ids.includes(p2));
  assert.ok(!ids.includes(p2x), "personal rules per workspace apply");
  assert.ok(!ids.includes(p3), "a workspace where AI is off for the person is not searched");
  assert.equal(across.sources.find((s) => s.pageId === p2)!.workspaceName, "Vertrieb");
  assert.equal(across.sources.find((s) => s.pageId === p2)!.workspaceId, w2);
  const prompt = across.messages.map((m) => m.content).join("\n");
  assert.match(prompt, /Arbeitsbereich „Vertrieb“/);
  for (const word of ["GEHALTSGEHEIMNIS", "GASTINHALT"]) assert.ok(!prompt.includes(word), word);
});

// ---- Weekly digest ----

// Monday 26 October 2026, 07:30 in Berlin (CET, UTC+1).
const MONDAY = Date.UTC(2026, 9, 26, 6, 30);
const sent: { to: string; subject: string; text: string }[] = [];

test("the digest is due on Monday from 07:00 in the person's time zone, once", async () => {
  assert.deepEqual(localTime(MONDAY, "Europe/Berlin"), { weekday: "Mon", hour: 7, date: "2026-10-26" });
  assert.equal(digestDue(MONDAY, "Europe/Berlin", null), "2026-10-26");
  assert.equal(digestDue(MONDAY, "Europe/Berlin", "2026-10-26"), null);
  assert.equal(digestDue(MONDAY - 3600_000, "Europe/Berlin", null), null, "06:30 is too early");
  assert.equal(digestDue(MONDAY, "America/New_York", null), null, "still Monday night… early morning there");
  assert.equal(digestDue(MONDAY - 86_400_000, "Europe/Berlin", null), null, "Sunday");
  await assert.rejects(async () => await setWeeklyDigest(ben, { enabled: true, timeZone: "Mars/Olympus" }));
});

test("weekly digest: followed pages, overdue tasks, AI summary only when opted in and AI is on", async () => {
  process.env.SMTP_HOST = "smtp.example.test";
  setMailSender(async (m) => void sent.push(m));
  after(() => setMailSender(undefined));
  assert.deepEqual(await weeklyDigestPrefs(ben), { enabled: false, aiSummary: false, timeZone: "UTC" });
  // Off: nothing.
  assert.equal(await queueWeeklyDigests(MONDAY), 0);
  await setWeeklyDigest(ben, { enabled: true, aiSummary: true, timeZone: "Europe/Berlin" });
  for (const page of [p1, blocked]) {
    await run("INSERT INTO page_follows(user_id,page_id,created_at) VALUES(?,?,?)", ben.id, page, MONDAY - 20 * 86_400_000);
    await run("INSERT INTO page_edits(page_id,user_id,at) VALUES(?,?,?) ON CONFLICT(page_id,user_id) DO UPDATE SET at=excluded.at", page, admin.id, MONDAY - 86_400_000);
  }
  await command(admin, { action: "ai.block", targetId: blocked, kind: "page", blocked: true });
  await run(
    "INSERT INTO doc_tasks(id,page_id,row_id,idx,text,checked,assignee,due,workspace_id,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    id(),
    p1,
    "",
    0,
    "Zahlen prüfen",
    0,
    ben.id,
    "2026-10-20",
    w1,
    Date.now(),
  );
  const digest = await buildWeeklyDigest(ben, MONDAY, "2026-10-26");
  assert.deepEqual(digest.changed.map((c) => c.pageId).sort(), [p1, blocked].sort());
  assert.deepEqual(digest.overdue.map((t) => t.text), ["Zahlen prüfen"]);

  mock.answer = () => "- Der Bericht zeigt ein Plus.";
  const before = mock.chats.length;
  assert.equal(await queueWeeklyDigests(MONDAY), 1);
  assert.equal(await queueWeeklyDigests(MONDAY + 60_000), 0, "once per Monday");
  const chat = mock.chats[before];
  assert.match(chat.prompt, /Plus von zehn Prozent/);
  assert.ok(!chat.prompt.includes("SPERRINHALT"), "pages closed to the AI are not summarised");
  const mail = (await one<{ recipient: string; subject: string; text: string; html: string }>("SELECT recipient,subject,text,html FROM mail_queue ORDER BY next_at DESC LIMIT 1"))!;
  assert.equal(mail.recipient, "ben@example.test");
  assert.equal(mail.subject, "Deine Woche in Flowplan");
  assert.match(mail.text, /Zusammenfassung \(KI\)\n- Der Bericht zeigt ein Plus\./);
  assert.match(mail.text, /Quartalsbericht Team/);
  assert.match(mail.text, /Überfällige Aufgaben\n• Zahlen prüfen/);
  assert.match(mail.html, /#page=/);

  // Next Monday with AI switched off: the plain list, no provider call.
  await setAi({ enabled: false });
  await run("INSERT INTO page_edits(page_id,user_id,at) VALUES(?,?,?) ON CONFLICT(page_id,user_id) DO UPDATE SET at=excluded.at", p1, admin.id, MONDAY + 6 * 86_400_000);
  const calls = mock.chats.length;
  assert.equal(await queueWeeklyDigests(MONDAY + 7 * 86_400_000), 1);
  assert.equal(mock.chats.length, calls);
  const plain = (await one<{ text: string }>("SELECT text FROM mail_queue ORDER BY next_at DESC, seq DESC LIMIT 1"))!.text;
  assert.ok(!plain.includes("(KI)"));
  assert.match(plain, /Quartalsbericht Team/);
  assert.equal((await all("SELECT 1 FROM mail_queue")).length, 2);
});

test("the digest mail in English", () => {
  const mail = weeklyDigestMail("Ben", { changed: [], open: [{ text: "Call", due: null, pageId: p1, title: "T" }], overdue: [] }, null, "en");
  assert.equal(mail.subject, "Your week in Flowplan");
  assert.match(mail.text, /Open tasks\n• Call/);
});
