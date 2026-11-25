// Choosing the AI model among those a person's plan or groups allow (#538,
// lib/ai/model-policy.ts): the allowed set ("Bis Opus – frei wählbar" =
// the rule's model and the instance's smaller family models; several rules
// = the union; the person's own rule = exactly one), the personal choice
// stored on the server (ai.settings { instanceModel }) and refused outside
// the set, its enforcement in lib/ai/resolve.ts (a stale or forged choice
// falls back to the default), workflows keeping the default, the picker's
// data in the AI status, schema 138 with its data step, and the limits
// file's aiModels "all". Stub provider (tests/helpers/ai-mock.ts).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-ai-model-choice-"));
process.env.APP_URL = "https://flowplan.example.test";
process.env.FLOWPLAN_AI_REQUESTS_PER_HOUR = "100000";
delete process.env.FLOWPLAN_AI;
const { run, one, id, tableColumns, SCHEMA_VERSION } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { identityFromToken } = await import("../lib/auth");
const { command } = await import("../lib/api");
const policy = await import("../lib/ai/model-policy");
const { aiComplete } = await import("../lib/ai/run");
const { resolveAi, aiStatus } = await import("../lib/ai/resolve");
const { userAiSettings } = await import("../lib/ai/settings");
const { runnerIdentity } = await import("../lib/workflows/runner");
const { runDataSteps, MODEL_CHOICE_STEP } = await import("../lib/data-steps");
const { aiRuleView } = await import("../lib/ai/admin-rule");
const { startOllamaMock } = await import("./helpers/ai-mock");
import type { Identity } from "../lib/types";
import type { ModelRule } from "../lib/ai/quota-shared";
import type { LimitsImportResult } from "../lib/limits-file";

async function person(name: string, groups: string[] = []): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name.toLowerCase()}@example.test`);
  const token = randomBytes(16).toString("hex");
  await run("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)", createHash("sha256").update(token).digest("hex"), uid, JSON.stringify(groups), Date.now() + 3600_000);
  return (await identityFromToken(token))!;
}
const admin = await person("Ada", ["flowplan-admins"]);
const pia = await person("Pia"),
  ben = await person("Ben");
const wid = await createWorkspace(admin.id, "Team");
for (const p of [pia, ben]) await run("INSERT INTO members VALUES(?,?,?)", wid, p.id, "editor");
const pro = id(),
  plus = id();
await run("INSERT INTO groups(id,workspace_id,name) VALUES(?,?,?)", pro, wid, "Pro");
await run("INSERT INTO groups(id,workspace_id,name) VALUES(?,?,?)", plus, wid, "Plus");
await run("INSERT INTO group_members(group_id,user_id) VALUES(?,?)", pro, pia.id);

const mock = await startOllamaMock();
after(() => mock.close());
const PRICES = [
  { model: "haiku", input: 1, output: 5 },
  { model: "sonnet", input: 3, output: 15 },
  { model: "opus", input: 15, output: 75 },
];
await command(admin, { action: "admin.ai", settings: { enabled: true, guests: true, semanticSearch: false, prices: PRICES, provider: { kind: "ollama", baseUrl: mock.base, model: "haiku", embeddingModel: "embed" } } });
const rule = (scope: "user" | "group" | "role", target: string, patch: Record<string, unknown>) => command(admin, { action: "admin.aiRule", scope, target, ...patch });
const clear = async () => {
  await run("DELETE FROM ai_model_rules");
  await run("DELETE FROM ai_quota_rules");
  await run("DELETE FROM ai_user_settings");
};
const ask = (who: Identity) => aiComplete(who, "write", { messages: [{ role: "user", content: "Hallo" }], maxTokens: 10 }, { workspaceId: wid });
const lastModel = () => mock.chats.at(-1)?.model;
const choose = (who: Identity, instanceModel: string | null) => command(who, { action: "ai.settings", instanceModel });

test("the allowed set: 'up to' a model with the instance's smaller family models, the union of rules, the own rule alone", () => {
  const instance = { kind: "anthropic", model: "claude-haiku-4-5" };
  const prices = [
    { model: "claude-haiku-4-5", input: 1, output: 5 },
    { model: "claude-sonnet-4-6", input: 3, output: 15 },
    { model: "claude-opus-4-5", input: 15, output: 75 },
    { model: "claude-3-haiku", input: 0.25, output: 1.25 },
  ];
  const options = ["claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-5", "claude-3-haiku"];
  // "Bis Opus": the instance's model of each family, not every old model of the price list.
  assert.deepEqual(policy.allowedByRule({ model: "claude-opus-4-5", choice: true }, options, prices), ["claude-opus-4-5", "claude-sonnet-4-6", "claude-haiku-4-5"]);
  assert.deepEqual(policy.allowedByRule({ model: "claude-sonnet-4-6", choice: true }, options, prices), ["claude-sonnet-4-6", "claude-haiku-4-5"]);
  // A family rule without the choice: exactly that model.
  assert.deepEqual(policy.allowedByRule({ model: "claude-sonnet-4-6" }, options, prices), ["claude-sonnet-4-6"]);
  // A provider without these families: the priced models that cost no more.
  assert.deepEqual(policy.allowedByRule({ model: "gpt-5", choice: true }, ["gpt-5", "gpt-5-mini", "gpt-6"], [
    { model: "gpt-5", input: 1.25, output: 10 },
    { model: "gpt-5-mini", input: 0.25, output: 2 },
    { model: "gpt-6", input: 5, output: 40 },
  ]), ["gpt-5", "gpt-5-mini"]);
  assert.deepEqual(policy.choiceRanges(options, prices)["claude-haiku-4-5"], undefined, "nothing below Haiku but an older model of another family? none – Haiku alone is no choice");

  const rules: ModelRule[] = [
    { scope: "group", target: "g-pro", model: "claude-opus-4-5", kind: "anthropic", choice: true },
    { scope: "group", target: "g-plus", model: "claude-sonnet-4-6", kind: "anthropic" },
    { scope: "group", target: "g-lite", model: "claude-haiku-4-5", kind: "anthropic" },
    { scope: "user", target: "u-own", model: "claude-sonnet-4-6", kind: "anthropic" },
  ];
  const who = (userId: string, groups: string[]) => policy.chooseModel(rules, { userId, groups, roles: [] }, instance, prices, options);
  const proPolicy = who("u-x", ["g-pro"]);
  assert.equal(proPolicy.model, "claude-opus-4-5", "the default stays the most capable");
  assert.deepEqual(proPolicy.allowed, ["claude-opus-4-5", "claude-sonnet-4-6", "claude-haiku-4-5"]);
  // One fixed rule: nothing to choose.
  assert.equal(who("u-x", ["g-plus"]).allowed, undefined);
  // Two fixed rules: their union.
  assert.deepEqual(who("u-x", ["g-plus", "g-lite"]).allowed, ["claude-sonnet-4-6", "claude-haiku-4-5"]);
  // The own rule: exactly that one, no picker – whatever the groups say.
  const own = who("u-own", ["g-pro"]);
  assert.equal(own.model, "claude-sonnet-4-6");
  assert.equal(own.allowed, undefined);
  // The choice applies only inside the set.
  assert.equal(policy.applyModelChoice(proPolicy, "claude-haiku-4-5").model, "claude-haiku-4-5");
  assert.equal(policy.applyModelChoice(proPolicy, "claude-haiku-4-5").chosen, true);
  assert.equal(policy.applyModelChoice(proPolicy, "claude-3-haiku").model, "claude-opus-4-5");
  assert.equal(policy.applyModelChoice(proPolicy, "gpt-5").model, "claude-opus-4-5");
  assert.deepEqual(policy.modelTiers(proPolicy.allowed!).map((m) => m.tier), ["strong", "balanced", "fast"]);
});

test("the personal choice: stored on the server, used by every feature, refused outside the set", async () => {
  await clear();
  await rule("group", pro, { model: "opus", choice: true });
  await ask(pia);
  assert.equal(lastModel(), "opus", "the default: the most capable");
  // The AI status offers the choice.
  let status = await aiStatus(pia, wid);
  assert.deepEqual(status.provider?.choice?.models, [
    { model: "opus", tier: "strong" },
    { model: "sonnet", tier: "balanced" },
    { model: "haiku", tier: "fast" },
  ]);
  assert.equal(status.provider?.choice?.default, "opus");
  assert.equal(status.provider?.choice?.chosen, false);
  assert.equal(status.provider?.choice?.costQuota, false);
  // Ben has no rule: no choice.
  assert.equal((await aiStatus(ben, wid)).provider?.choice, undefined);

  await choose(pia, "haiku");
  assert.equal((await userAiSettings(pia.id)).instanceModel, "haiku");
  await ask(pia);
  assert.equal(lastModel(), "haiku");
  status = await aiStatus(pia, wid);
  assert.equal(status.provider?.model, "haiku");
  assert.equal(status.provider?.choice?.chosen, true);
  // The default is stored as '' (follows a later plan change).
  await choose(pia, "opus");
  assert.equal((await userAiSettings(pia.id)).instanceModel, "");
  await choose(pia, "sonnet");
  // Outside the set: refused, the choice stays.
  await assert.rejects(() => choose(pia, "gpt-5"), /nicht freigegeben/);
  await assert.rejects(() => choose(ben, "haiku"), /nicht freigegeben/, "without a choice nothing can be picked");
  assert.equal((await userAiSettings(pia.id)).instanceModel, "sonnet");
  // null: back to the default.
  await choose(pia, null);
  assert.equal((await userAiSettings(pia.id)).instanceModel, "");
  // An API token may not change it.
  await assert.rejects(() => command({ ...pia, apiScope: "write" }, { action: "ai.settings", instanceModel: "haiku" }));
});

test("enforced in resolve: a forged or stale choice is ignored, the default applies", async () => {
  await clear();
  await rule("group", pro, { model: "opus", choice: true });
  // Written past the command (forged): a model outside the set.
  await run("INSERT INTO ai_user_settings(user_id,config,key_cipher,key_hint,updated_at) VALUES(?,?,NULL,'',?)", pia.id, JSON.stringify({ enabled: true, features: {}, source: "instance", scope: "all", provider: null, device: "prefer", instanceModel: "gpt-6-ultra" }), Date.now());
  const forged = await resolveAi(pia, "write", { workspaceId: wid });
  assert.ok(forged.ok && forged.config.model === "opus" && !forged.chosen);
  // A valid choice, then the plan changes to a fixed Sonnet: stale, ignored.
  await choose(pia, "haiku");
  assert.equal(((await resolveAi(pia, "write", { workspaceId: wid })) as { config: { model: string } }).config.model, "haiku");
  await rule("group", pro, { model: "sonnet", choice: false });
  await ask(pia);
  assert.equal(lastModel(), "sonnet");
  assert.equal((await aiStatus(pia, wid)).provider?.choice, undefined);
  // Back on the plan with the choice: it applies again.
  await rule("group", pro, { model: "opus", choice: true });
  await ask(pia);
  assert.equal(lastModel(), "haiku");
  // A person's own rule: exactly that model, the choice is ignored.
  await rule("user", pia.id, { model: "sonnet" });
  await ask(pia);
  assert.equal(lastModel(), "sonnet");
  assert.equal((await aiStatus(pia, wid)).provider?.choice, undefined);
  // The choice is never stored on a person's rule.
  await rule("user", pia.id, { model: "opus", choice: true });
  assert.equal((await one<{ choice: number }>("SELECT choice FROM ai_model_rules WHERE scope='user' AND target=?", pia.id))?.choice, 0);
});

test("workflows keep the default, not the personal choice", async () => {
  await clear();
  await rule("group", pro, { model: "opus", choice: true });
  await choose(pia, "haiku");
  const runner = (await runnerIdentity(pia.id))!;
  assert.equal(runner.workflowRun, true);
  const flow = await resolveAi(runner, "workflows", { workspaceId: wid });
  assert.ok(flow.ok && flow.config.model === "opus");
  // Even through another feature, as the workflow's runner.
  const other = await resolveAi(runner, "write", { workspaceId: wid });
  assert.ok(other.ok && other.config.model === "opus");
  // The feature "workflows" for the person (validation of a workflow) as well.
  const asPerson = await resolveAi(pia, "workflows", { workspaceId: wid });
  assert.ok(asPerson.ok && asPerson.config.model === "opus");
  // The person themselves: their choice.
  const own = await resolveAi(pia, "write", { workspaceId: wid });
  assert.ok(own.ok && own.config.model === "haiku");
});

test("the quota counts cost: the picker says a smaller model stretches it", async () => {
  await clear();
  await rule("group", pro, { model: "opus", choice: true });
  await command(admin, { action: "admin.aiQuotas", settings: { unit: "cost" }, rules: [{ scope: "default", target: "", limits: { month: 10 } }] });
  try {
    assert.equal((await aiStatus(pia, wid)).provider?.choice?.costQuota, true);
    await choose(pia, "haiku");
    await ask(pia);
    assert.ok(await one("SELECT 1 FROM ai_quota_usage WHERE user_id=? AND model='haiku'", pia.id), "counted under the chosen model");
  } finally {
    await command(admin, { action: "admin.aiQuotas", settings: { unit: "tokens" }, rules: [] });
  }
  assert.equal((await aiStatus(pia, wid)).provider?.choice?.costQuota, false);
});

test("the administration: 'Bis … – frei wählbar' per group and role, with what it allows", async () => {
  await clear();
  await rule("role", "admin", { model: "sonnet", choice: true });
  const view = await aiRuleView(admin, { scope: "role", target: "admin" });
  assert.equal(view.model.own?.choice, true);
  assert.deepEqual(view.model.effective?.allowed, ["sonnet", "haiku"]);
  assert.deepEqual(view.model.ranges.opus, ["opus", "sonnet", "haiku"]);
  assert.equal(view.model.ranges.haiku, undefined);
  // Without the mark: exactly the model.
  await rule("role", "admin", { model: "sonnet" });
  assert.equal((await aiRuleView(admin, { scope: "role", target: "admin" })).model.effective?.allowed, undefined);
});

test("schema 138: ai_model_rules.choice; the data step marks plans' 'all' rules", async () => {
  assert.ok(SCHEMA_VERSION >= 138);
  assert.ok((await tableColumns("ai_model_rules")).includes("choice"));
  await clear();
  const now = Date.now();
  // A plan (directory group) on the most capable model, as aiModels "all" wrote it before #538.
  await run("INSERT INTO ai_model_rules(scope,target,model,kind,updated_at) VALUES('group','dir:Flowplan Pro','opus','ollama',?)", now);
  await run("INSERT INTO ai_model_rules(scope,target,model,kind,updated_at) VALUES('group','dir:Flowplan Plus','sonnet','ollama',?)", now);
  await run("INSERT INTO ai_model_rules(scope,target,model,kind,updated_at) VALUES('group',?,'opus','ollama',?)", plus, now);
  await run("DELETE FROM data_migrations WHERE name=?", MODEL_CHOICE_STEP);
  await runDataSteps([MODEL_CHOICE_STEP]);
  const choice = async (target: string) => (await one<{ choice: number }>("SELECT choice FROM ai_model_rules WHERE target=?", target))?.choice;
  assert.equal(await choice("dir:Flowplan Pro"), 1);
  assert.equal(await choice("dir:Flowplan Plus"), 0, "a family rule stays exactly that model");
  assert.equal(await choice(plus), 0, "a workspace group set by hand stays as it is");
});

test("limits file: aiModels 'all' is 'up to the most capable, your choice'; the export writes it back", async () => {
  await clear();
  const file = {
    version: 1,
    plans: [
      { group: "Flowplan Pro", kind: "plan", aiModels: "all" },
      { group: "Flowplan Plus", kind: "plan", aiModels: "sonnet" },
    ],
  };
  const applied = (await command(admin, { action: "admin.limitsImport", file, dryRun: false })) as LimitsImportResult;
  assert.deepEqual(applied.errors, []);
  assert.ok(applied.changes.some((c) => c.area === "model" && c.target === "dir:Flowplan Pro" && c.after === "opus" && c.afterChoice));
  assert.equal((await one<{ choice: number }>("SELECT choice FROM ai_model_rules WHERE target='dir:Flowplan Pro'"))?.choice, 1);
  assert.equal((await one<{ choice: number }>("SELECT choice FROM ai_model_rules WHERE target='dir:Flowplan Plus'"))?.choice, 0);
  // Idempotent.
  const again = (await command(admin, { action: "admin.limitsImport", file, dryRun: true })) as LimitsImportResult;
  assert.equal(again.changes.filter((c) => c.area === "model").length, 0);
  // A fixed Opus rule differs from "all": the import marks it.
  await run("UPDATE ai_model_rules SET choice=0 WHERE target='dir:Flowplan Pro'");
  const fix = (await command(admin, { action: "admin.limitsImport", file, dryRun: true })) as LimitsImportResult;
  assert.ok(fix.changes.some((c) => c.area === "model" && c.target === "dir:Flowplan Pro" && !c.beforeChoice && c.afterChoice));
  await run("UPDATE ai_model_rules SET choice=1 WHERE target='dir:Flowplan Pro'");
  const exported = (await command(admin, { action: "admin.limitsExport" })) as { plans: Record<string, unknown>[] };
  const plans = Object.fromEntries(exported.plans.map((p) => [p.group, p]));
  assert.equal(plans["Flowplan Pro"].aiModels, "all");
  assert.equal(plans["Flowplan Plus"].aiModels, "sonnet");
});
