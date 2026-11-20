// The AI model per person, group and role (lib/ai/model-policy.ts): the
// precedence (person → the most capable of their groups and roles → the
// instance's default), the enforcement where every feature gets its
// provider (lib/ai/resolve.ts), own providers unaffected, a rule for
// another provider kind inactive, and the administration's editor
// (admin.aiRule, lib/ai/admin-rule.ts) writing the quota rules of the
// limits table – no second store. Stub provider (tests/helpers/ai-mock.ts).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-ai-model-"));
process.env.APP_URL = "https://flowplan.example.test";
process.env.FLOWPLAN_AI_REQUESTS_PER_HOUR = "100000";
delete process.env.FLOWPLAN_AI;
const { run, one, id } = await import("../lib/db");
const { createWorkspace, createPage } = await import("../lib/seed");
const { identityFromToken } = await import("../lib/auth");
const { command } = await import("../lib/api");
const quota = await import("../lib/ai/quota");
const policy = await import("../lib/ai/model-policy");
const { aiRuleView } = await import("../lib/ai/admin-rule");
const { aiComplete } = await import("../lib/ai/run");
const { resolveAi, aiStatus } = await import("../lib/ai/resolve");
const { proposeActions } = await import("../lib/ai/actions");
const { proposeFlashcards } = await import("../lib/ai/flashcards");
const { proposeDatabase } = await import("../lib/ai/database");
const { recognizeHandwriting } = await import("../lib/ai/handwriting");
const { aiWriteResponse } = await import("../lib/ai/write");
const { aiSummaryResponse } = await import("../lib/ai/summarize");
const { forgetAiPerson } = await import("../lib/metrics");
const { startOllamaMock } = await import("./helpers/ai-mock");
import type { Identity } from "../lib/types";
import type { ModelRule } from "../lib/ai/quota-shared";

async function person(name: string, groups: string[] = []): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name.toLowerCase()}@example.test`);
  const token = randomBytes(16).toString("hex");
  await run("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)", createHash("sha256").update(token).digest("hex"), uid, JSON.stringify(groups), Date.now() + 3600_000);
  return (await identityFromToken(token))!;
}
const admin = await person("Ada", ["flowplan-admins"]);
const ben = await person("Ben"),
  cleo = await person("Cleo"),
  dora = await person("Dora");
const wid = await createWorkspace(admin.id, "Team");
for (const p of [ben, cleo, dora]) await run("INSERT INTO members VALUES(?,?,?)", wid, p.id, "editor");
const space = (await one<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=?", wid))!.id;
const doc = await createPage(wid, space, admin.id, "Notizen");
const notebook = await createPage(wid, space, admin.id, "Heft", "notebook");
const redaktion = id(),
  labor = id();
await run("INSERT INTO groups(id,workspace_id,name) VALUES(?,?,?)", redaktion, wid, "Redaktion");
await run("INSERT INTO groups(id,workspace_id,name) VALUES(?,?,?)", labor, wid, "Labor");
await run("INSERT INTO group_members(group_id,user_id) VALUES(?,?)", redaktion, cleo.id);
await run("INSERT INTO group_members(group_id,user_id) VALUES(?,?)", redaktion, dora.id);
await run("INSERT INTO group_members(group_id,user_id) VALUES(?,?)", labor, dora.id);

const mock = await startOllamaMock();
after(() => mock.close());
const PRICES = [
  { model: "haiku", input: 1, output: 5 },
  { model: "sonnet", input: 3, output: 15 },
  { model: "opus", input: 15, output: 75 },
];
await command(admin, { action: "admin.ai", settings: { enabled: true, guests: true, semanticSearch: false, prices: PRICES, provider: { kind: "ollama", baseUrl: mock.base, model: "haiku", embeddingModel: "embed" } } });
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const rule = (scope: "user" | "group" | "role", target: string, patch: Record<string, unknown>) => command(admin, { action: "admin.aiRule", scope, target, ...patch });
const clear = async () => {
  await run("DELETE FROM ai_model_rules");
  await run("DELETE FROM ai_quota_rules");
  await run("DELETE FROM ai_quota_usage");
};
const lastModel = () => mock.chats.at(-1)?.model;
const ask = (who: Identity) => aiComplete(who, "write", { messages: [{ role: "user", content: "Hallo" }], maxTokens: 10 }, { workspaceId: wid });

test("precedence: the person's own model, else the most capable of their groups and roles, else the instance's default", () => {
  const instance = { kind: "anthropic", model: "claude-haiku" };
  const prices = [
    { model: "claude-haiku", input: 1, output: 5 },
    { model: "claude-sonnet", input: 3, output: 15 },
    { model: "claude-opus", input: 15, output: 75 },
  ];
  const rules: ModelRule[] = [
    { scope: "group", target: "g-sonnet", model: "claude-sonnet", kind: "anthropic" },
    { scope: "group", target: "g-opus", model: "claude-opus", kind: "anthropic" },
    { scope: "group", target: "g-free", model: "zz-unpriced", kind: "anthropic" },
    { scope: "group", target: "g-free2", model: "aa-unpriced", kind: "anthropic" },
    { scope: "group", target: "g-openai", model: "gpt-5", kind: "openai" },
    { scope: "role", target: "admin", model: "claude-sonnet", kind: "anthropic" },
    { scope: "user", target: "u-own", model: "claude-sonnet", kind: "anthropic" },
    { scope: "user", target: "u-default", model: "", kind: "anthropic" },
    { scope: "user", target: "u-stale", model: "gpt-5", kind: "openai" },
  ];
  const who = (userId: string, groups: string[] = [], roles: ("admin" | "guest")[] = []) => policy.chooseModel(rules, { userId, groups, roles }, instance, prices);
  assert.deepEqual(who("u-none"), { model: "claude-haiku", source: "instance", target: null, default: "claude-haiku" });
  assert.deepEqual(who("u-x", ["g-sonnet"]), { model: "claude-sonnet", source: "group", target: "g-sonnet", default: "claude-haiku" });
  // Several groups: the most expensive model by the price list wins, whatever the order.
  assert.equal(who("u-x", ["g-sonnet", "g-opus"]).model, "claude-opus");
  assert.equal(who("u-x", ["g-opus", "g-sonnet"]).model, "claude-opus");
  // A role counts like a group.
  assert.deepEqual(who("u-x", [], ["admin"]), { model: "claude-sonnet", source: "role", target: "admin", default: "claude-haiku" });
  assert.equal(who("u-x", ["g-opus"], ["admin"]).source, "group");
  // Unpriced models rank below priced ones; among them the name decides.
  assert.equal(who("u-x", ["g-free", "g-sonnet"]).model, "claude-sonnet");
  assert.equal(who("u-x", ["g-free", "g-free2"]).model, "aa-unpriced");
  // The own rule beats every group – also "the instance's default".
  assert.equal(who("u-own", ["g-opus"]).model, "claude-sonnet");
  assert.deepEqual(who("u-default", ["g-opus"]), { model: "claude-haiku", source: "user", target: "u-default", default: "claude-haiku" });
  // A rule for another provider kind does not apply.
  assert.equal(who("u-stale").model, "claude-haiku");
  assert.equal(who("u-x", ["g-openai"]).source, "instance");
});

test("enforced for every feature: the person with Opus gets Opus, the others the instance's Haiku", async () => {
  await clear();
  await rule("user", ben.id, { model: "opus" });
  const signal = new AbortController().signal;
  const calls: [string, () => Promise<unknown>][] = [
    ["write (run)", () => ask(ben)],
    ["write assistant", async () => await (await aiWriteResponse(ben, { pageId: doc, action: "prompt", instruction: "Schreib etwas" }, signal)).text()],
    ["summarize", async () => await (await aiSummaryResponse(ben, { pageId: doc, text: "Ein langer Text über die Erde." }, signal)).text()],
    ["actions", () => proposeActions(ben, { workspaceId: wid, instruction: "Lege Aufgaben an" })],
    ["flashcards", () => proposeFlashcards(ben, { workspaceId: wid, source: { kind: "text", text: "Die Erde ist rund." } })],
    ["handwriting", () => recognizeHandwriting(ben, { pageId: notebook, image: PNG })],
    ["database", () => proposeDatabase(ben, wid, "Eine Bücherliste")],
  ];
  for (const [name, call] of calls) {
    const before = mock.chats.length;
    await call().catch(() => {});
    assert.ok(mock.chats.length > before, `${name} reached the model`);
    assert.ok(
      mock.chats.slice(before).every((c) => c.model === "opus"),
      `${name}: ${mock.chats
        .slice(before)
        .map((c) => c.model)
        .join(",")}`,
    );
  }
  await ask(cleo);
  assert.equal(lastModel(), "haiku");
  // The usage is counted under the model that answered.
  assert.ok(await one("SELECT 1 FROM ai_quota_usage WHERE user_id=? AND model='opus'", ben.id));
  // The person sees it (bootstrap/settings), marked as set by the administration.
  const status = await aiStatus(ben, wid);
  assert.equal(status.provider?.model, "opus");
  assert.equal(status.provider?.assigned, true);
  assert.equal((await aiStatus(cleo, wid)).provider?.assigned, undefined);
});

test("groups: the group's model for its members, the most capable when in several; the person's own rule wins", async () => {
  await clear();
  await rule("group", redaktion, { model: "sonnet" });
  await rule("group", labor, { model: "opus" });
  await ask(cleo);
  assert.equal(lastModel(), "sonnet");
  await ask(dora);
  assert.equal(lastModel(), "opus", "Dora is in both groups: the most capable");
  await ask(ben);
  assert.equal(lastModel(), "haiku");
  await rule("user", dora.id, { model: "" });
  await ask(dora);
  assert.equal(lastModel(), "haiku", "the own rule: the instance's default, whatever the groups say");
  await rule("user", dora.id, { model: null });
  await ask(dora);
  assert.equal(lastModel(), "opus");
  // A role: administrators.
  await rule("role", "admin", { model: "sonnet" });
  await ask(admin);
  assert.equal(lastModel(), "sonnet");
  // "Standard der Instanz" is no rule of its own for a group.
  await assert.rejects(() => rule("group", labor, { model: "" }), /Gruppen und Rollen/);
});

test("own providers and another provider kind are not affected", async () => {
  await clear();
  await rule("user", ben.id, { model: "opus" });
  await command(admin, { action: "admin.ai", settings: { userProviders: true } });
  try {
    await command(ben, { action: "ai.provider", provider: { kind: "openai", baseUrl: "https://api.example.com/v1", model: "own-model", embeddingModel: "" }, apiKey: "sk-ben-0123456789" });
    await command(ben, { action: "ai.settings", source: "user" });
    const own = await resolveAi(ben, "write", { workspaceId: wid });
    assert.ok(own.ok && own.source === "user" && own.config.model === "own-model" && !own.assigned);
    await command(ben, { action: "ai.settings", source: "instance" });
    const instance = await resolveAi(ben, "write", { workspaceId: wid });
    assert.ok(instance.ok && instance.source === "instance" && instance.config.model === "opus" && instance.assigned);
  } finally {
    await command(admin, { action: "admin.ai", settings: { userProviders: false } });
  }
  // The rule remembers the kind it was chosen for: after a switch to another
  // kind it does not apply (an Ollama model never goes to OpenAI).
  await run("UPDATE ai_model_rules SET kind='openai' WHERE target=?", ben.id);
  assert.equal((await policy.modelPolicyFor(ben)).model, "haiku");
  const view = await aiRuleView(admin, { scope: "user", target: ben.id });
  assert.equal(view.model.active, false);
  assert.equal(view.model.effective?.model, "haiku");
  await rule("user", ben.id, { model: "opus" });
  assert.equal((await one<{ kind: string }>("SELECT kind FROM ai_model_rules WHERE target=?", ben.id))!.kind, "ollama");
});

test("the quota in a person's details writes the rules of the limits table – no second store", async () => {
  await clear();
  await command(admin, { action: "admin.aiQuotas", settings: { unit: "tokens", timeZone: "UTC" }, rules: [{ scope: "default", target: "", exempt: false, limits: { day: 1000 } }] });
  let view = await aiRuleView(admin, { scope: "user", target: ben.id });
  assert.equal(view.quota.own, null);
  assert.deepEqual(view.quota.effective, { limits: { day: 1000 }, exempt: false, source: "default" });
  assert.equal(view.usage.find((u) => u.period === "day")?.limit, 1000);
  // Own limits: the same row the quota table shows and the check uses.
  view = (await rule("user", ben.id, { quota: { exempt: false, limits: { day: 50, month: 9000 } } })) as typeof view;
  assert.deepEqual(view.quota.own, { scope: "user", target: ben.id, exempt: false, limits: { day: 50, month: 9000 } });
  const table = await quota.adminQuotaView("day");
  assert.deepEqual(
    table.rules.find((r) => r.scope === "user" && r.target === ben.id),
    { scope: "user", target: ben.id, exempt: false, limits: { day: 50, month: 9000 } },
  );
  assert.equal(table.people.find((p) => p.id === ben.id)?.limit, 50);
  // The check refuses with the person's own limit.
  await assert.rejects(() => aiComplete(ben, "write", { messages: [{ role: "user", content: "Hallo" }], maxTokens: 100 }, { workspaceId: wid }), (e: { status?: number }) => e.status === 429);
  // The usage shows in the details.
  await quota.recordQuotaUsage({ userId: ben.id, kind: "person", model: "haiku", tokensIn: 30, tokensOut: 0 });
  view = await aiRuleView(admin, { scope: "user", target: ben.id });
  assert.deepEqual(
    view.usage.map((u) => [u.period, u.used, u.limit]),
    [
      ["day", 30, 50],
      ["week", 30, null],
      ["month", 30, 9000],
      ["year", 30, null],
    ],
  );
  // Exempt, then inherited again.
  await rule("user", ben.id, { quota: { exempt: true, limits: { day: 5 } } });
  assert.deepEqual((await quota.quotaRules()).find((r) => r.target === ben.id), { scope: "user", target: ben.id, exempt: true, limits: {} });
  await rule("user", ben.id, { quota: null });
  assert.equal((await quota.quotaRules()).find((r) => r.target === ben.id), undefined);
  // A group's limits and the usage of its members together.
  await rule("group", redaktion, { quota: { exempt: false, limits: { day: 700 } } });
  assert.deepEqual(quota.personalLimits(await quota.quotaRules(), await quota.quotaPerson(cleo)), { limits: { day: 700 }, exempt: false, source: "group" });
  await quota.recordQuotaUsage({ userId: cleo.id, kind: "person", model: "haiku", tokensIn: 10, tokensOut: 0 });
  await quota.recordQuotaUsage({ userId: dora.id, kind: "person", model: "haiku", tokensIn: 5, tokensOut: 0 });
  const group = await aiRuleView(admin, { scope: "group", target: redaktion });
  assert.equal(group.members, 2);
  assert.equal(group.usage.find((u) => u.period === "day")?.used, 15);
  // Audited like every admin change.
  assert.ok(await one("SELECT 1 FROM audit WHERE action='admin.aiRule' AND resource_id=?", ben.id));
  // The limits table keeps model-only rows apart: saving the table leaves the models alone.
  await rule("user", cleo.id, { model: "sonnet" });
  await command(admin, { action: "admin.aiQuotas", rules: [] });
  assert.equal((await policy.modelPolicyFor(cleo)).model, "sonnet");
  assert.ok((await quota.adminQuotaView()).model.rules.some((r) => r.target === cleo.id && r.model === "sonnet" && r.active));
});

test("administrators only; checked input; a deleted account's rules go", async () => {
  await clear();
  await assert.rejects(() => command(ben, { action: "admin.aiRule", scope: "user", target: ben.id, model: "opus" }), /Administrator/);
  await assert.rejects(() => aiRuleView(ben, { scope: "user", target: ben.id }), /Administrator/);
  await assert.rejects(() => rule("user", ben.id, { model: "opus; rm -rf" }), /Modellname|Ungültig/);
  await assert.rejects(() => rule("user", id(), { model: "opus" }), /nicht gefunden/);
  await assert.rejects(() => rule("group", id(), { model: "opus" }), /nicht gefunden/);
  await assert.rejects(() => rule("role", "boss", { model: "opus" }), /Unbekannte Rolle/);
  await rule("user", ben.id, { model: "opus", quota: { exempt: false, limits: { day: 10 } } });
  await forgetAiPerson(ben.id);
  assert.equal(await one("SELECT 1 FROM ai_model_rules WHERE target=?", ben.id), undefined);
  assert.equal(await one("SELECT 1 FROM ai_quota_rules WHERE target=?", ben.id), undefined);
});
