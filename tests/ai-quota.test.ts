// AI quotas (#382, lib/ai/quota.ts): calendar periods in the quota's time
// zone, which limits apply (person → groups and roles → default, the
// instance ceiling on top, exemptions), tokens or cost, the refusal before
// any provider call at every entry point, what people see, the
// administration and the notifications. Stub provider
// (tests/helpers/ai-mock.ts) – no real model is called.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-ai-quota-"));
process.env.APP_URL = "https://flowplan.example.test";
process.env.FLOWPLAN_AI_REQUESTS_PER_HOUR = "100000";
delete process.env.FLOWPLAN_AI;
const { run, one, all, id } = await import("../lib/db");
const { createWorkspace, createPage } = await import("../lib/seed");
const { identityFromToken } = await import("../lib/auth");
const { command } = await import("../lib/api");
const quota = await import("../lib/ai/quota");
const { aiComplete } = await import("../lib/ai/run");
const { embed } = await import("../lib/ai/providers");
const { recognizeHandwriting } = await import("../lib/ai/handwriting");
const { proposeActions } = await import("../lib/ai/actions");
const { proposeFlashcards } = await import("../lib/ai/flashcards");
const { proposeDatabase } = await import("../lib/ai/database");
const { aiWriteResponse } = await import("../lib/ai/write");
const { withContentLocale } = await import("../lib/content-locale");
const { forgetAiPerson } = await import("../lib/metrics");
const { startOllamaMock } = await import("./helpers/ai-mock");
import type { Identity } from "../lib/types";
import type { QuotaRule } from "../lib/ai/quota-shared";

const ZONE = "Europe/Berlin";
async function person(name: string, groups: string[] = []): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name.toLowerCase()}@example.test`);
  const token = randomBytes(16).toString("hex");
  await run("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)", createHash("sha256").update(token).digest("hex"), uid, JSON.stringify(groups), Date.now() + 3600_000);
  return (await identityFromToken(token))!;
}
const admin = await person("Ada", ["flowplan-admins"]);
assert.equal(admin.isAdmin, true);
const ben = await person("Ben"),
  cleo = await person("Cleo"),
  gus = await person("Gus");
const wid = await createWorkspace(admin.id, "Team");
await run("INSERT INTO members VALUES(?,?,?)", wid, ben.id, "editor");
await run("INSERT INTO members VALUES(?,?,?)", wid, cleo.id, "editor");
// Gus is a guest only: role "guest".
await run("INSERT INTO members VALUES(?,?,?)", wid, gus.id, "viewer");
await run("INSERT INTO workspace_guests(workspace_id,user_id) VALUES(?,?)", wid, gus.id);
const space = (await one<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=?", wid))!.id;
const notebook = await createPage(wid, space, admin.id, "Heft", "notebook");
const doc = await createPage(wid, space, admin.id, "Notizen");
const groupId = id();
await run("INSERT INTO groups(id,workspace_id,name) VALUES(?,?,?)", groupId, wid, "Redaktion");
await run("INSERT INTO group_members(group_id,user_id) VALUES(?,?)", groupId, cleo.id);

const mock = await startOllamaMock();
after(() => mock.close());
await command(admin, { action: "admin.ai", settings: { enabled: true, guests: true, semanticSearch: false, provider: { kind: "ollama", baseUrl: mock.base, model: "chat", embeddingModel: "embed" } } });
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const setQuota = async (rules: QuotaRule[], settings: Record<string, unknown> = {}) =>
  await command(admin, { action: "admin.aiQuotas", settings: { timeZone: ZONE, workflowsCountInstance: true, warnAt: 80, ...settings }, rules });
const clearUsage = async () => {
  await run("DELETE FROM ai_quota_usage");
  await run("DELETE FROM ai_quota_alerts");
};
const use = async (who: Identity | null, tokens: number, kind: "person" | "workflow" | "system" = "person", model = "chat") =>
  await quota.recordQuotaUsage({ userId: who?.id ?? "", kind, model, tokensIn: tokens, tokensOut: 0 });
const status = async (p: Promise<unknown>) => {
  try {
    await p;
    return 200;
  } catch (error) {
    return (error as { status?: number }).status ?? 500;
  }
};
const ask = (who: Identity, feature: "write" | "workflows" = "write") => aiComplete(who, feature, { messages: [{ role: "user", content: "Hallo" }], maxTokens: 10 }, { workspaceId: wid });

/* ---------- Periods ---------- */

test("calendar periods in the zone: day, week (Monday or Sunday), month, year – reset at local midnight", () => {
  // Wednesday 2026-11-18, 23:30 in Berlin = 22:30 UTC.
  const at = Date.UTC(2026, 10, 18, 22, 30);
  assert.equal(quota.quotaDay(at, ZONE), "2026-11-18");
  assert.equal(quota.quotaDay(at, "UTC"), "2026-11-18");
  assert.equal(quota.quotaDay(at, "Asia/Tokyo"), "2026-11-19");
  assert.deepEqual(quota.periodBounds("day", at, ZONE), { start: "2026-11-18", end: "2026-11-19", resetAt: Date.UTC(2026, 10, 18, 23, 0) });
  assert.equal(quota.periodBounds("week", at, ZONE, "monday").start, "2026-11-16");
  assert.equal(quota.periodBounds("week", at, ZONE, "monday").end, "2026-11-23");
  assert.equal(quota.periodBounds("week", at, ZONE, "sunday").start, "2026-11-15");
  // A Sunday starts its own week when weeks start on Sunday.
  assert.equal(quota.periodBounds("week", Date.UTC(2026, 10, 22, 12), ZONE, "sunday").start, "2026-11-22");
  assert.equal(quota.periodBounds("week", Date.UTC(2026, 10, 22, 12), ZONE, "monday").start, "2026-11-16");
  assert.deepEqual(quota.periodBounds("month", at, ZONE), { start: "2026-11-01", end: "2026-12-01", resetAt: Date.UTC(2026, 10, 30, 23, 0) });
  assert.deepEqual(quota.periodBounds("year", at, ZONE), { start: "2026-01-01", end: "2027-01-01", resetAt: Date.UTC(2026, 11, 31, 23, 0) });
  // The month that ends in summer time resets at 00:00 CEST (22:00 UTC).
  assert.equal(quota.periodBounds("month", Date.UTC(2026, 2, 15), ZONE).resetAt, Date.UTC(2026, 2, 31, 22, 0));
});

/* ---------- Which limits apply ---------- */

test("precedence: the own rule, else the highest group or role limit per period, else the default", () => {
  const rules: QuotaRule[] = [
    { scope: "instance", target: "", exempt: false, limits: { month: 1_000_000 } },
    { scope: "default", target: "", exempt: false, limits: { day: 100, month: 1000 } },
    { scope: "group", target: "g1", exempt: false, limits: { day: 300, month: 2000 } },
    { scope: "group", target: "g2", exempt: false, limits: { day: 500 } },
    { scope: "role", target: "guest", exempt: false, limits: { day: 10, month: 50 } },
    { scope: "user", target: "u-own", exempt: false, limits: { week: 7 } },
    { scope: "user", target: "u-free", exempt: true, limits: {} },
    { scope: "group", target: "g-free", exempt: true, limits: {} },
  ];
  const who = (userId: string, groups: string[] = [], roles: ("admin" | "guest")[] = []) => quota.personalLimits(rules, { userId, groups, roles });
  assert.deepEqual(who("u-none"), { limits: { day: 100, month: 1000 }, exempt: false, source: "default", after: null });
  assert.deepEqual(who("u-g1", ["g1"]), { limits: { day: 300, month: 2000 }, exempt: false, source: "group", after: null });
  // Several groups: the highest per period; a period one group leaves open is open.
  assert.deepEqual(who("u-both", ["g1", "g2"]), { limits: { day: 500 }, exempt: false, source: "group", after: null });
  assert.deepEqual(who("u-guest", [], ["guest"]), { limits: { day: 10, month: 50 }, exempt: false, source: "group", after: null });
  assert.deepEqual(who("u-guest-g1", ["g1"], ["guest"]), { limits: { day: 300, month: 2000 }, exempt: false, source: "group", after: null });
  // The own rule wins over groups, even a smaller one.
  assert.deepEqual(who("u-own", ["g1"]), { limits: { week: 7 }, exempt: false, source: "user", after: null });
  // Exemptions: a person or a group.
  assert.deepEqual(who("u-free", ["g1"]), { limits: null, exempt: true, source: "user", after: null });
  assert.deepEqual(who("u-x", ["g1", "g-free"]), { limits: null, exempt: true, source: "group", after: null });
  assert.deepEqual(quota.instanceLimits(rules), { month: 1_000_000 });
  assert.deepEqual(quota.personalLimits([], { userId: "a", groups: [], roles: [] }), { limits: null, exempt: false, source: "none", after: null });
});

test("tokens or cost: the current prices per model, unpriced models count nothing towards cost", () => {
  const prices = [{ model: "chat", input: 2, output: 10 }];
  const rows = [
    { model: "chat", tokens_in: 500_000, tokens_out: 100_000 },
    { model: "models/Chat", tokens_in: 500_000, tokens_out: 0 },
    { model: "other", tokens_in: 1_000_000, tokens_out: 1_000_000 },
  ];
  assert.equal(quota.amountOf(rows, "tokens", prices), 3_100_000);
  assert.equal(quota.amountOf(rows, "cost", prices), 1 + 1 + 1);
});

/* ---------- Enforcement ---------- */

test("a request that would cross the limit is refused before it is sent; usage is counted afterwards", async () => {
  await clearUsage();
  await setQuota([{ scope: "default", target: "", exempt: false, limits: { day: 60 } }]);
  const before = mock.chats.length;
  assert.equal(await ask(ben), "OK");
  assert.equal(mock.chats.length, before + 1);
  const row = await one<{ tokens_in: number; tokens_out: number; kind: string; model: string }>("SELECT * FROM ai_quota_usage WHERE user_id=?", ben.id);
  assert.equal(row?.kind, "person");
  assert.equal(row?.model, "chat");
  assert.ok(row!.tokens_in > 0 && row!.tokens_out > 0);
  // 50 more: estimate (prompt + 10 output tokens) no longer fits 60.
  await use(ben, 50);
  const error = await ask(ben).then(
    () => null,
    (e) => e as InstanceType<typeof quota.AiQuotaError>,
  );
  assert.ok(error instanceof quota.AiQuotaError);
  assert.equal(error.status, 429);
  assert.equal(error.quota.period, "day");
  assert.equal(error.quota.level, "person");
  assert.match(error.message, /^Für diese Anfrage reicht dein KI-Kontingent für heute nicht mehr\. Es gilt wieder ab .+\. Bis dahin kannst du die KI auf dem Gerät nutzen\.$/);
  assert.equal(mock.chats.length, before + 1, "the refused request reached no model");
  // Others are not affected.
  assert.equal(await ask(cleo), "OK");
});

test("the message is in the reader's language and names the reset and the alternatives", async () => {
  await clearUsage();
  await setQuota([{ scope: "default", target: "", exempt: false, limits: { month: 10 } }]);
  await use(ben, 10);
  const message = await withContentLocale("en", async () => await ask(ben).catch((e: Error) => e.message));
  assert.match(String(message), /^Your AI quota for this month is used up\. It is available again from 1 Dec 2026, 00:00\. Until then you can use on-device AI\.$/);
  await command(admin, { action: "admin.ai", settings: { userProviders: true, device: false } });
  try {
    const own = await ask(ben).catch((e: Error) => e.message);
    assert.match(String(own), /aufgebraucht\. Es gilt wieder ab 01\.12\.2026, 00:00\. Bis dahin kannst du einen eigenen KI-Anbieter nutzen \(Einstellungen → KI\)\.$/);
  } finally {
    await command(admin, { action: "admin.ai", settings: { userProviders: false, device: true } });
  }
});

test("every AI entry point refuses with the same message and calls no model", async () => {
  await clearUsage();
  await setQuota([{ scope: "default", target: "", exempt: false, limits: { day: 1000 } }]);
  await use(ben, 1000);
  const before = mock.chats.length;
  const signal = new AbortController().signal;
  const refusals = [
    await status(ask(ben)),
    await status(aiWriteResponse(ben, { pageId: doc, action: "prompt", instruction: "Schreib etwas" }, signal)),
    await status(proposeActions(ben, { workspaceId: wid, instruction: "Lege Aufgaben an" })),
    await status(proposeFlashcards(ben, { workspaceId: wid, source: { kind: "text", text: "Die Erde ist rund." } })),
    await status(recognizeHandwriting(ben, { pageId: notebook, image: PNG })),
    await status(proposeDatabase(ben, wid, "Eine Bücherliste")),
  ];
  assert.deepEqual(refusals, [429, 429, 429, 429, 429, 429]);
  const message = await ask(ben).catch((e: Error) => e.message);
  assert.equal(await aiWriteResponse(ben, { pageId: doc, action: "prompt", instruction: "Schreib etwas" }, signal).catch((e: Error) => e.message), message);
  assert.equal(await proposeActions(ben, { workspaceId: wid, instruction: "Lege Aufgaben an" }).catch((e: Error) => e.message), message);
  assert.equal(mock.chats.length, before, "no request reached the model");
});

test("workflows: not the person's limit, but the instance ceiling (switchable); embeddings count towards the ceiling", async () => {
  await clearUsage();
  await setQuota([
    { scope: "default", target: "", exempt: false, limits: { day: 100 } },
    { scope: "instance", target: "", exempt: false, limits: { day: 5000 } },
  ]);
  await use(ben, 100);
  assert.equal(await status(ask(ben)), 429);
  assert.equal(await ask(ben, "workflows"), "OK", "a workflow running as Ben ignores his personal limit");
  assert.equal((await one<{ kind: string }>("SELECT kind FROM ai_quota_usage WHERE user_id=? AND kind='workflow'", ben.id))?.kind, "workflow");
  await use(cleo, 4990);
  const before = mock.chats.length;
  assert.equal(await status(ask(ben, "workflows")), 429, "the ceiling stops workflows too");
  assert.equal(await status(ask(cleo)), 429, "and everyone else");
  const embeds = mock.embeds.length;
  const config = { kind: "ollama" as const, baseUrl: mock.base, model: "chat", embeddingModel: "embed", trusted: true };
  await assert.rejects(embed(config, ["Ein Text"]), (e: unknown) => e instanceof quota.AiQuotaError && e.quota.level === "instance");
  assert.equal(mock.embeds.length, embeds);
  assert.equal(mock.chats.length, before);
  // Workflow usage outside the ceiling: they run again.
  await setQuota(
    [
      { scope: "default", target: "", exempt: false, limits: { day: 100 } },
      { scope: "instance", target: "", exempt: false, limits: { day: 5000 } },
    ],
    { workflowsCountInstance: false },
  );
  await run("DELETE FROM ai_quota_usage WHERE user_id=?", cleo.id);
  await use(ben, 6000, "workflow");
  assert.equal(await ask(ben, "workflows"), "OK");
  // Embeddings are counted for nobody.
  await embed(config, ["Noch ein Text"]);
  assert.ok(await one("SELECT 1 FROM ai_quota_usage WHERE user_id='' AND kind='system'"));
});

test("exempt people and groups keep AI; the guest role gets less; the instance ceiling applies to everyone", async () => {
  await clearUsage();
  await setQuota([
    { scope: "default", target: "", exempt: false, limits: { day: 100 } },
    { scope: "role", target: "guest", exempt: false, limits: { day: 20 } },
    { scope: "group", target: groupId, exempt: true, limits: {} },
    { scope: "user", target: ben.id, exempt: true, limits: {} },
  ]);
  await use(ben, 10_000);
  await use(cleo, 10_000);
  assert.equal(await ask(ben), "OK");
  assert.equal(await ask(cleo), "OK");
  assert.equal(await status(ask(gus)), 200);
  await use(gus, 20);
  assert.equal(await status(ask(gus)), 429);
  await setQuota([
    { scope: "instance", target: "", exempt: false, limits: { day: 10_000 } },
    { scope: "user", target: ben.id, exempt: true, limits: {} },
  ]);
  assert.equal(await status(ask(ben)), 429, "exempt from personal limits, not from the ceiling");
});

test("cost limits use the prices of the AI settings and need them", async () => {
  await clearUsage();
  await assert.rejects(setQuota([], { unit: "cost" }), /Preise/);
  await command(admin, { action: "admin.ai", settings: { prices: [{ model: "chat", input: 1000, output: 1000 }], currency: "EUR" } });
  try {
    await setQuota([{ scope: "default", target: "", exempt: false, limits: { day: 0.5 } }], { unit: "cost" });
    // 1000 € per million tokens: 400 tokens are 0.40 €.
    await use(ben, 400);
    let s = await quota.quotaStatus(ben, "instance");
    assert.equal(s.unit, "cost");
    assert.equal(s.currency, "EUR");
    assert.deepEqual(s.periods.map((p) => [p.period, p.limit, p.used, p.left]), [["day", 0.5, 0.4, 0.1]]);
    assert.equal(s.low, true);
    assert.equal(await ask(ben), "OK");
    // A model without a price counts nothing towards cost – the view warns.
    await use(ben, 1_000_000, "person", "unpriced");
    const view = (await quota.adminQuotaView("day")) as Awaited<ReturnType<typeof quota.adminQuotaView>>;
    assert.deepEqual(view.missingPrices, ["unpriced"]);
    await use(ben, 200);
    s = await quota.quotaStatus(ben, "instance");
    assert.equal(s.blocked, true);
    assert.equal(await status(ask(ben)), 429);
    // Back to tokens: the cost numbers are dropped, exemptions stay.
    await setQuota([
      { scope: "default", target: "", exempt: false, limits: { day: 0.5 } },
      { scope: "user", target: cleo.id, exempt: true, limits: {} },
    ], { unit: "cost" });
    await command(admin, { action: "admin.aiQuotas", settings: { unit: "tokens" } });
    assert.deepEqual(await quota.quotaRules(), [{ scope: "user", target: cleo.id, exempt: true, limits: {} }]);
  } finally {
    await command(admin, { action: "admin.ai", settings: { prices: [] } });
    await setQuota([], { unit: "tokens" });
  }
});

/* ---------- What people see ---------- */

test("what is left (GET /api/ai/quota): what is left per period, the warning and the block; nothing for an own provider", async () => {
  await clearUsage();
  await setQuota(
    [
      { scope: "default", target: "", exempt: false, limits: { day: 1000, month: 10_000 } },
      { scope: "instance", target: "", exempt: false, limits: { year: 1_000_000 } },
    ],
    { warnAt: 75 },
  );
  await use(ben, 800);
  const { aiProviderSource } = await import("../lib/ai/resolve");
  assert.equal(await aiProviderSource(ben), "instance");
  const s = await quota.quotaStatus(ben, await aiProviderSource(ben));
  assert.equal(s.applies, true);
  assert.equal(s.warnAt, 75);
  assert.deepEqual(
    s.periods.map((p) => [p.level, p.period, p.limit, p.used, p.left]),
    [
      ["person", "day", 1000, 800, 200],
      ["person", "month", 10_000, 800, 9200],
      ["instance", "year", 1_000_000, 800, 999_200],
    ],
  );
  assert.equal(s.low, true);
  assert.equal(s.blocked, false);
  assert.equal(s.periods[0].resetAt, quota.periodBounds("day", Date.now(), ZONE).resetAt);
  await use(ben, 200);
  assert.equal((await quota.quotaStatus(ben, "instance")).blocked, true);
  assert.equal((await quota.quotaStatus(ben, "user")).applies, false, "an own provider is not limited");
  const free = await quota.quotaStatus(cleo, "instance");
  assert.equal(free.low, false);
});

/* ---------- Administration ---------- */

test("only administrators set limits; targets must exist; the view lists usage per person, group and model", async () => {
  await clearUsage();
  assert.equal(await status(command(ben, { action: "admin.aiQuotas", rules: [] })), 403);
  assert.equal(await status(setQuota([{ scope: "group", target: id(), exempt: false, limits: { day: 1 } }])), 404);
  assert.equal(await status(setQuota([{ scope: "user", target: id(), exempt: false, limits: { day: 1 } }])), 404);
  assert.equal(await status(setQuota([{ scope: "role", target: "owner", exempt: false, limits: { day: 1 } }])), 400);
  assert.equal(await status(setQuota([{ scope: "default", target: "", exempt: false, limits: { day: 1 } }, { scope: "default", target: "", exempt: false, limits: { day: 2 } }])), 400);
  await assert.rejects(setQuota([], { timeZone: "Mars/Olympus" }), /Unbekannte Zeitzone/);
  await setQuota([
    { scope: "default", target: "", exempt: false, limits: { month: 5000.7 } },
    { scope: "group", target: groupId, exempt: false, limits: { month: 9000 } },
    { scope: "instance", target: "", exempt: false, limits: { month: 100_000 } },
  ]);
  await use(ben, 1200);
  await use(cleo, 300, "person", "other");
  await use(ben, 50, "workflow");
  const view = await quota.adminQuotaView("month");
  assert.equal(view.settings.timeZone, ZONE);
  assert.equal(view.instance.limit, 100_000);
  assert.equal(view.instance.used, 1550);
  const b = view.people.find((p) => p.id === ben.id)!;
  assert.deepEqual([b.used, b.limit, b.source], [1200, 5001, "default"]);
  const c = view.people.find((p) => p.id === cleo.id)!;
  assert.deepEqual([c.used, c.limit, c.source, c.groups], [300, 9000, "group", [groupId]]);
  assert.deepEqual(view.people.find((p) => p.id === gus.id)!.roles, ["guest"]);
  assert.deepEqual(view.people.find((p) => p.id === admin.id)!.roles, ["admin"]);
  assert.equal(view.groups.find((g) => g.id === groupId)!.used, 300);
  assert.deepEqual(view.models.map((m) => [m.model, m.tokens]).sort(), [["chat", 1250], ["other", 300]]);
  // GET /api/ai/admin/quotas answers administrators only.
  assert.equal(await status(quota.adminQuotas(ben, "day")), 403);
  assert.equal((await quota.adminQuotas(admin, "day")).period, "day");
});

test("administrators get one notification at the warning and one at the ceiling per period", async () => {
  await clearUsage();
  await run("DELETE FROM notifications WHERE kind='ai_quota'");
  await setQuota([{ scope: "instance", target: "", exempt: false, limits: { week: 1000 } }], { warnAt: 80 });
  await use(ben, 500);
  await use(ben, 300);
  await use(ben, 50);
  let notes = await all<{ body: string; link: string }>("SELECT body,link FROM notifications WHERE kind='ai_quota' AND user_id=?", admin.id);
  assert.deepEqual(notes.map((n) => n.body), ["Das KI-Kontingent der Instanz für diese Woche ist zu 80 % verbraucht."]);
  assert.equal(notes[0].link, "#admin/ai/quotas");
  await use(ben, 200);
  await use(ben, 200);
  notes = await all<{ body: string; link: string }>("SELECT body,link FROM notifications WHERE kind='ai_quota' AND user_id=? ORDER BY seq", admin.id);
  assert.equal(notes.length, 2);
  assert.match(notes[1].body, /^Das KI-Kontingent der Instanz für diese Woche ist aufgebraucht – bis \d{4}-\d{2}-\d{2} ist KI über den Anbieter der Instanz gesperrt\.$/);
  const { englishMessage } = await import("../lib/i18n-errors");
  assert.equal(englishMessage(notes[0].body), "80 % of the instance's AI quota for this week is used.");
  assert.equal((await one("SELECT 1 FROM notifications WHERE kind='ai_quota' AND user_id=?", ben.id)) ?? null, null, "not for others");
});

test("a deleted or merged account's usage stays in the instance's total without a person", async () => {
  await clearUsage();
  const dora = await person("Dora");
  await setQuota([{ scope: "user", target: dora.id, exempt: false, limits: { day: 5 } }]);
  await use(dora, 700);
  await use(null, 30, "system");
  await forgetAiPerson(dora.id);
  assert.equal(await one("SELECT 1 FROM ai_quota_usage WHERE user_id=?", dora.id), undefined);
  assert.equal(Number((await one<{ n: number }>("SELECT SUM(tokens_in) n FROM ai_quota_usage WHERE user_id=''"))?.n), 730);
  assert.deepEqual(await quota.quotaRules(), []);
});

/* ---------- After the quota: another model ---------- */

test("precedence of the model after the quota: own rule, else the most capable of the groups, else the default", () => {
  const prices = [
    { model: "small", input: 1, output: 1 },
    { model: "medium", input: 3, output: 15 },
  ];
  const rules: QuotaRule[] = [
    { scope: "default", target: "", exempt: false, limits: { month: 100 } },
    { scope: "group", target: "dir:Plus", exempt: false, limits: { month: 1000 }, after: "small", afterKind: "ollama" },
    { scope: "group", target: "dir:Pro", exempt: false, limits: { month: 5000 }, after: "medium", afterKind: "ollama" },
    { scope: "user", target: "u-own", exempt: false, limits: { month: 10 } },
  ];
  const who = (userId: string, groups: string[] = []) => quota.personalLimits(rules, { userId, groups, roles: [] }, prices);
  assert.equal(who("u-free").after, null, "the default stops");
  assert.deepEqual(who("u-plus", ["dir:Plus"]).after, { model: "small", kind: "ollama" });
  assert.deepEqual(who("u-both", ["dir:Plus", "dir:Pro"]), { limits: { month: 5000 }, exempt: false, source: "group", after: { model: "medium", kind: "ollama" } });
  // The own rule without a model: AI stops for this person.
  assert.equal(who("u-own", ["dir:Plus"]).after, null);
  // Only for the provider kind it was chosen for.
  assert.equal(quota.activeAfter(who("u-plus", ["dir:Plus"]), { kind: "ollama", model: "chat" }), "small");
  assert.equal(quota.activeAfter(who("u-plus", ["dir:Plus"]), { kind: "openai", model: "gpt" }), null);
});

test("a group goes on with a cheaper model once its quota is used up – counted, not limited; others stop; the instance ceiling still applies", async () => {
  await clearUsage();
  await command(admin, { action: "admin.ai", settings: { prices: [{ model: "small", input: 0, output: 0 }] } });
  // Directory group "Plus" over SCIM: Cleo is a member (no workspace group, no mapping needed).
  const scimGroup = id();
  await run("INSERT INTO scim_groups(id,display_name,version,created_at,updated_at) VALUES(?,?,1,?,?)", scimGroup, "Plus", Date.now(), Date.now());
  await run("INSERT INTO scim_group_members(group_id,user_id) VALUES(?,?)", scimGroup, cleo.id);
  try {
    // A model that is not one of the instance's: refused.
    await assert.rejects(setQuota([{ scope: "group", target: "dir:Plus", exempt: false, limits: { month: 60 }, after: "unknown-model" }]), /nicht vorgesehen/);
    await setQuota([
      { scope: "instance", target: "", exempt: false, limits: { month: 10_000 } },
      { scope: "default", target: "", exempt: false, limits: { month: 60 } },
      { scope: "group", target: "dir:Plus", exempt: false, limits: { month: 60 }, after: "small" },
    ]);
    assert.deepEqual((await quota.quotaRules()).find((r) => r.target === "dir:Plus"), { scope: "group", target: "dir:Plus", exempt: false, limits: { month: 60 }, after: "small", afterKind: "ollama" });
    await use(ben, 100);
    await use(cleo, 100);
    // Ben (default) stops.
    assert.equal(await status(ask(ben)), 429);
    // Cleo goes on with "small"; the request is counted towards her.
    const before = mock.chats.length;
    assert.equal(await ask(cleo), "OK");
    assert.equal(mock.chats.length, before + 1);
    assert.equal(mock.chats[mock.chats.length - 1].model, "small");
    const small = await one<{ tokens_in: number }>("SELECT SUM(tokens_in) tokens_in FROM ai_quota_usage WHERE user_id=? AND model='small'", cleo.id);
    assert.ok(Number(small?.tokens_in) > 0);
    // What she sees: not blocked, the model named.
    const s = await quota.quotaStatus(cleo, "instance");
    assert.equal(s.blocked, false);
    assert.equal(s.after, "small");
    assert.equal((await quota.quotaStatus(ben, "instance")).blocked, true);
    // The instance ceiling still refuses.
    await use(ben, 10_000);
    const error = await ask(cleo).then(
      () => null,
      (e) => e as InstanceType<typeof quota.AiQuotaError>,
    );
    assert.ok(error instanceof quota.AiQuotaError);
    assert.equal(error.quota.level, "instance");
    // The administration shows the model per person.
    await clearUsage();
    const view = await quota.adminQuotaView("month");
    assert.equal(view.people.find((p) => p.id === cleo.id)?.after, "small");
    assert.ok(view.groups.some((g) => g.id === "dir:Plus" && g.directory && g.members === 1));
    // The same through the person's panel (admin.aiRule).
    const { saveAiRule } = await import("../lib/ai/admin-rule");
    const panel = await saveAiRule(admin, { scope: "user", target: ben.id, quota: { exempt: false, limits: { month: 5 }, after: "small" } });
    assert.equal(panel.quota.after, "small");
    assert.equal((await quota.quotaRules()).find((r) => r.target === ben.id)?.after, "small");
  } finally {
    await run("DELETE FROM scim_groups WHERE id=?", scimGroup);
    await command(admin, { action: "admin.ai", settings: { prices: [] } });
    await setQuota([], { unit: "tokens" });
  }
});
