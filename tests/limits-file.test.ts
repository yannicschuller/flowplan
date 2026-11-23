// Export / import of the limits and AI settings as one file
// (lib/limits-file.ts, Administration → Grenzen & Aufbewahrung → Export /
// Import): the mapping of plans onto group limits, AI quota rules and model
// rules, validation errors with their JSON paths, the dry run that writes
// nothing, one transaction for all, idempotency, removeMissing, the export
// round trip, and who may use it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-limits-file-"));
process.env.APP_URL = "https://flowplan.example.test";
delete process.env.FLOWPLAN_AI;
const { run, one, all, id } = await import("../lib/db");
const { identityFromToken } = await import("../lib/auth");
const { command } = await import("../lib/api");
const { instanceSettings } = await import("../lib/instance-settings");
const { userLimitDetails } = await import("../lib/user-limits");
const { quotaRules, quotaSettings } = await import("../lib/ai/quota");
const { modelRules } = await import("../lib/ai/model-policy");
const { familyModel, allModel } = await import("../lib/limits-file");
import type { Identity } from "../lib/types";
import type { LimitsImportResult } from "../lib/limits-file";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
async function person(name: string, groups: string[] = []): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${uid}@example.test`);
  const token = randomBytes(16).toString("hex");
  await run("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)", createHash("sha256").update(token).digest("hex"), uid, JSON.stringify(groups), Date.now() + 3600_000);
  return (await identityFromToken(token))!;
}
const admin = await person("Ada", ["flowplan-admins"]);
assert.equal(admin.isAdmin, true);
const member = await person("Mara");
// Mara is in the directory group "Flowplan Plus" (pushed over SCIM).
const scim = id();
await run("INSERT INTO scim_groups(id,display_name,version,created_at,updated_at) VALUES(?,?,1,?,?)", scim, "Flowplan Plus", Date.now(), Date.now());
await run("INSERT INTO scim_group_members(group_id,user_id) VALUES(?,?)", scim, member.id);

const MODELS = { haiku: "claude-haiku-4-5", sonnet: "claude-sonnet-4-6", opus: "claude-opus-4-1" };
await command(admin, {
  action: "admin.ai",
  settings: {
    enabled: true,
    provider: { kind: "anthropic", baseUrl: "http://127.0.0.1:9", model: MODELS.haiku, embeddingModel: "" },
    prices: [
      { model: MODELS.haiku, input: 1, output: 5 },
      { model: MODELS.sonnet, input: 3, output: 15 },
      { model: MODELS.opus, input: 15, output: 75 },
    ],
    currency: "USD",
  },
});

const sample = () => ({
  version: 1,
  archiveMissing: false,
  plans: [
    {
      group: "Flowplan Plus",
      kind: "plan",
      name_de: "Plus",
      storageMb: 25600,
      uploadMb: 1024,
      aiActions: 1000,
      aiModels: "sonnet",
      aiAfter: "haiku",
      prioritySupport: false,
      order: 1,
      highlight: true,
      paddle: { name: "Flowplan Plus", taxCategory: "standard" },
      prices: [{ interval: "month", eur: 5, usd: 5 }],
      _ids: { productId: "pro_1" },
    },
    { group: "Flowplan Pro", kind: "plan", storageMb: 102400, uploadMb: 20480, workspaces: 50, aiActions: 5000, aiModels: "all", aiAfter: "haiku" },
    { group: "Flowplan +50 GB", kind: "addon", storageMb: 51200, uploadMb: 0, aiActions: 0, aiModels: "haiku" },
  ],
  flowplan: {
    defaults: { storageMb: 500, uploadMb: 10 },
    aiQuota: { unit: "cost", defaultActions: 30, defaultAfter: "off", instanceCapUsd: 50 },
    moreLimitsUrl: "https://billing.flowplan.org/preise",
  },
});
const importFile = async (file: unknown, dryRun: boolean, who: Identity = admin) => (await command(who, { action: "admin.limitsImport", file, dryRun })) as LimitsImportResult;
const snapshot = async () => ({
  limits: await all("SELECT target,limits FROM group_limits ORDER BY target"),
  quota: await all("SELECT scope,target,exempt,limits,after_model,after_kind FROM ai_quota_rules ORDER BY scope,target"),
  models: await all("SELECT scope,target,model,kind FROM ai_model_rules ORDER BY scope,target"),
  settings: await all("SELECT key,value FROM instance_settings WHERE key<>'limitsFile' ORDER BY key"),
});

test("model families: the instance's model of a family, “all” the most capable", () => {
  const options = Object.values(MODELS);
  const prices = [{ model: MODELS.opus, input: 15, output: 75 }];
  assert.equal(familyModel("haiku", options, []), MODELS.haiku);
  assert.equal(familyModel("sonnet", [...options, "claude-sonnet-4-5"], []), MODELS.sonnet);
  assert.equal(familyModel("opus", ["llama3"], []), null);
  assert.equal(allModel(options, prices), MODELS.opus);
  assert.equal(allModel([MODELS.haiku, MODELS.sonnet], []), MODELS.sonnet);
  assert.equal(allModel(["llama3"], []), null);
});

test("validation: every error with its JSON path, nothing written", async () => {
  const before = await snapshot();
  const bad = sample() as Json;
  bad.plans[0].storageMb = -5;
  bad.plans[0].aiAfter = "gpt-9";
  bad.plans[1].kind = "premium";
  bad.plans[2].typo = 1;
  bad.plans.push({ group: "Flowplan Team", kind: "team" }, { group: "Flowplan Team", kind: "team" });
  bad.flowplan.moreLimitsUrl = "ftp://x";
  bad.flowplan.aiQuota.period = "decade";
  bad.flowplan.colour = "blue";
  const r = await importFile(JSON.stringify(bad), true);
  assert.equal(r.ok, false);
  const paths = r.errors.map((e) => `${e.path} ${e.code}`).sort();
  assert.deepEqual(paths, [
    "flowplan.aiQuota.period invalid",
    "flowplan.colour unknown_field",
    "flowplan.moreLimitsUrl invalid_url",
    "plans[0].storageMb out_of_range",
    "plans[1].kind invalid",
    "plans[2].typo unknown_field",
    "plans[4].group duplicate",
  ]);
  assert.deepEqual(r.changes, []);
  // A model the instance does not know: the list of the allowed ones.
  const model = sample() as Json;
  model.plans[0].aiAfter = "gpt-9";
  const m = await importFile(model, true);
  assert.deepEqual(m.errors, [{ path: "plans[0].aiAfter", code: "unknown_model", value: "gpt-9", allowed: [MODELS.haiku, MODELS.opus, MODELS.sonnet].sort() }]);
  // Invalid JSON: the line.
  assert.deepEqual((await importFile('{\n "version": 1,\n "plans": [,]\n}', true)).errors.map((e) => e.code), ["invalid_json"]);
  assert.deepEqual((await importFile({ version: 2 }, true)).errors, [{ path: "version", code: "unsupported" }]);
  // Applying a file with errors is refused, nothing changes.
  await assert.rejects(importFile(bad, false), /Fehler/);
  assert.deepEqual(await snapshot(), before);
});

test("dry run lists every change and writes nothing; applying maps every plan; again: no changes", async () => {
  const before = await snapshot();
  const dry = await importFile(JSON.stringify(sample()), true);
  assert.equal(dry.ok, true, JSON.stringify(dry.errors));
  assert.equal(dry.applied, false);
  assert.deepEqual(await snapshot(), before);
  assert.ok(dry.changes.some((c) => c.area === "limits" && c.name === "Flowplan Plus" && c.field === "storageMb" && c.after === 25600));
  assert.ok(dry.changes.some((c) => c.area === "quota" && c.scope === "group" && c.name === "Flowplan Pro" && c.before === null && c.after?.actions === 5000 && c.after.after === MODELS.haiku));
  assert.ok(dry.changes.some((c) => c.area === "setting" && c.field === "unit" && c.after === "cost"));
  // Pro's 20,480 MB upload is capped at the server's 10,240 MB (10 GB), with a note.
  assert.deepEqual(dry.notes, [{ path: "plans[1].uploadMb", code: "capped", max: 10240 }]);

  const applied = await importFile(sample(), false);
  assert.equal(applied.applied, true);
  assert.equal(applied.changes.length, dry.changes.length);
  // Group limits: the add-on as storage mode "add", without an upload.
  const limits = Object.fromEntries((await all<{ target: string; limits: string }>("SELECT target,limits FROM group_limits")).map((r) => [r.target, JSON.parse(r.limits)]));
  assert.deepEqual(limits, {
    "dir:Flowplan Plus": { storageMb: 25600, uploadMb: 1024 },
    "dir:Flowplan Pro": { storageMb: 102400, workspaces: 50, uploadMb: 10240 },
    "dir:Flowplan +50 GB": { storageMb: 51200, storageMode: "add" },
  });
  // AI quota rules in cost: actions × 0.02 USD per month; the add-on has none.
  assert.equal((await quotaSettings()).unit, "cost");
  const rules = Object.fromEntries((await quotaRules()).map((r) => [`${r.scope}|${r.target}`, r]));
  assert.deepEqual(Object.keys(rules).sort(), ["default|", "group|dir:Flowplan Plus", "group|dir:Flowplan Pro", "instance|"]);
  assert.deepEqual(rules["group|dir:Flowplan Plus"].limits, { month: 20 });
  assert.equal(rules["group|dir:Flowplan Plus"].after, MODELS.haiku);
  assert.equal(rules["group|dir:Flowplan Plus"].afterKind, "anthropic");
  assert.deepEqual(rules["group|dir:Flowplan Pro"].limits, { month: 100 });
  assert.deepEqual(rules["default|"].limits, { month: 0.6 });
  assert.equal(rules["default|"].after ?? null, null);
  assert.deepEqual(rules["instance|"].limits, { month: 50 });
  // Model rules: sonnet → the instance's Sonnet, all → Opus.
  assert.deepEqual(
    (await modelRules()).map((r) => [r.target, r.model, r.kind]),
    [
      ["dir:Flowplan Plus", MODELS.sonnet, "anthropic"],
      ["dir:Flowplan Pro", MODELS.opus, "anthropic"],
    ],
  );
  const s = await instanceSettings();
  assert.equal(s.defaultUserStorageMb, 500);
  assert.equal(s.maxUploadMb, 10);
  assert.equal(s.moreLimitsUrl, "https://billing.flowplan.org/preise");
  // Mara (Flowplan Plus) gets the plan's storage.
  assert.equal((await userLimitDetails(member.id)).values.storageMb, 25600);
  // Every change is audited.
  assert.equal(Number((await one<{ n: number }>("SELECT COUNT(*) n FROM audit WHERE action='admin.limitsImport'"))!.n), applied.changes.length);

  // The same file again: no changes, nothing written.
  const again = await importFile(sample(), false);
  assert.deepEqual([again.applied, again.changes], [false, []]);
});

test("export → import round trip has no changes; workspace groups by name; _skipped", async () => {
  const wid = id();
  await run("INSERT INTO workspaces(id,name) VALUES(?,?)", wid, "Agentur");
  const gid = id();
  await run("INSERT INTO groups(id,workspace_id,name) VALUES(?,?,?)", gid, wid, "Design");
  await run("INSERT INTO group_limits(target,limits,updated_at) VALUES(?,?,?)", gid, JSON.stringify({ storageMb: 3000 }), Date.now());
  await run("INSERT INTO ai_quota_rules(scope,target,exempt,limits,updated_at) VALUES('role','guest',0,?,?)", JSON.stringify({ day: 1 }), Date.now());
  const file = (await command(admin, { action: "admin.limitsExport" })) as Json;
  assert.equal(file.version, 1);
  const plus = file.plans.find((p: Json) => p.group === "Flowplan Plus");
  assert.deepEqual(plus, { group: "Flowplan Plus", kind: "plan", storageMb: 25600, uploadMb: 1024, aiActions: 1000, aiAfter: "haiku", aiModels: "sonnet" });
  assert.deepEqual(file.plans.find((p: Json) => p.group === "Flowplan Pro").aiModels, "all");
  assert.deepEqual(file.plans.find((p: Json) => p.group === "Flowplan +50 GB"), { group: "Flowplan +50 GB", kind: "addon", storageMb: 51200 });
  assert.deepEqual(file.flowplan.groups, [{ workspaceGroup: { workspace: "Agentur", group: "Design" }, kind: "plan", storageMb: 3000 }]);
  assert.deepEqual(file.flowplan.aiQuota, { period: "month", unit: "cost", costPerAction: 0.02, defaultActions: 30, defaultAfter: "off", instanceCapUsd: 50 });
  assert.ok(file._skipped.some((s: string) => s.includes("role guest")));
  const r = await importFile(JSON.stringify(file), true);
  assert.deepEqual([r.ok, r.changes], [true, []]);
  await run("DELETE FROM ai_quota_rules WHERE scope='role'");
  await run("DELETE FROM group_limits WHERE target=?", gid);
});

test("one transaction: a failing write leaves everything as it was", async () => {
  const before = await snapshot();
  const file = sample() as Json;
  file.plans[0].storageMb = 30000;
  file.flowplan.defaults.storageMb = 700;
  // A trigger makes the AI rule's write fail after the limits were written.
  await run("CREATE TRIGGER fail_quota BEFORE UPDATE ON ai_quota_rules BEGIN SELECT RAISE(ABORT, 'boom'); END");
  file.plans[0].aiActions = 2000;
  try {
    await assert.rejects(importFile(file, false));
  } finally {
    await run("DROP TRIGGER fail_quota");
  }
  assert.deepEqual(await snapshot(), before);
});

test("removeMissing: directory groups not in the file lose their limits and rules; default keeps them", async () => {
  await run("INSERT INTO group_limits(target,limits,updated_at) VALUES(?,?,?)", "dir:Old plan", JSON.stringify({ storageMb: 1 }), Date.now());
  await run("INSERT INTO ai_model_rules(scope,target,model,kind,updated_at) VALUES('group','dir:Old plan',?,'anthropic',?)", MODELS.haiku, Date.now());
  const file = sample() as Json;
  assert.deepEqual((await importFile(file, true)).changes, []);
  file.flowplan.removeMissing = true;
  const r = await importFile(file, false);
  assert.deepEqual(
    r.changes.map((c) => [c.area, "name" in c ? c.name : ""]),
    [
      ["limitsRemoved", "Old plan"],
      ["model", "Old plan"],
    ],
  );
  assert.equal(await one("SELECT 1 FROM group_limits WHERE target='dir:Old plan'"), undefined);
  assert.equal(await one("SELECT 1 FROM ai_model_rules WHERE target='dir:Old plan'"), undefined);
  assert.ok(await one("SELECT 1 FROM group_limits WHERE target='dir:Flowplan Plus'"));
});

test("changes: before → after; null removes; an add-on with actions gets an AI rule", async () => {
  const file = sample() as Json;
  file.plans[0].storageMb = 2000;
  file.plans[1].aiAfter = "off";
  file.plans[2].aiActions = 500;
  file.plans[2].workspaces = null;
  file.plans.push({ group: "Flowplan Team", kind: "team", aiModel: MODELS.sonnet });
  const r = await importFile(file, false);
  const plus = r.changes.find((c) => c.area === "limits" && c.name === "Flowplan Plus");
  assert.deepEqual(plus, { area: "limits", target: "dir:Flowplan Plus", name: "Flowplan Plus", field: "storageMb", before: 25600, after: 2000 });
  const pro = r.changes.find((c) => c.area === "quota" && c.name === "Flowplan Pro");
  assert.ok(pro && pro.area === "quota" && pro.before?.after === MODELS.haiku && pro.after?.after === null);
  const addon = (await quotaRules()).find((q) => q.target === "dir:Flowplan +50 GB");
  assert.deepEqual(addon?.limits, { month: 10 });
  assert.ok((await modelRules()).some((m) => m.target === "dir:Flowplan Team" && m.model === MODELS.sonnet));
  // aiActions null removes the group's rule.
  const remove = sample() as Json;
  remove.plans[0].aiActions = null;
  await importFile(remove, false);
  assert.equal((await quotaRules()).find((q) => q.target === "dir:Flowplan Plus"), undefined);
});

test("AI families need a model of the instance; cost needs the right currency", async () => {
  const file = sample() as Json;
  await command(admin, { action: "admin.ai", settings: { currency: "EUR" } });
  try {
    const r = await importFile(file, true);
    assert.deepEqual(r.errors, [{ path: "flowplan.aiQuota.instanceCapUsd", code: "currency_mismatch", allowed: ["instanceCap"], value: "EUR" }]);
  } finally {
    await command(admin, { action: "admin.ai", settings: { currency: "USD" } });
  }
  await command(admin, { action: "admin.ai", settings: { provider: { kind: "openai", baseUrl: "http://127.0.0.1:9/v1", model: "llama3", embeddingModel: "" }, prices: [] } });
  try {
    const r = await importFile(file, true);
    const codes = r.errors.map((e) => `${e.path} ${e.code}`);
    assert.ok(codes.includes("plans[0].aiAfter no_family_model"), codes.join());
    assert.ok(codes.includes("plans[0].aiModels no_family_model"));
    assert.ok(codes.includes("flowplan.aiQuota.unit no_prices"));
    assert.deepEqual(r.errors.find((e) => e.path === "plans[0].aiAfter")?.allowed, ["llama3"]);
  } finally {
    await command(admin, {
      action: "admin.ai",
      settings: {
        provider: { kind: "anthropic", baseUrl: "http://127.0.0.1:9", model: MODELS.haiku, embeddingModel: "" },
        prices: Object.values(MODELS).map((model) => ({ model, input: 1, output: 1 })),
      },
    });
  }
});

test("members and API tokens are refused", async () => {
  await assert.rejects(command(member, { action: "admin.limitsImport", file: sample(), dryRun: true }), (e: { status?: number }) => e.status === 403);
  await assert.rejects(command(member, { action: "admin.limitsExport" }), (e: { status?: number }) => e.status === 403);
  const token = { ...admin, apiScope: "write" } as Identity;
  await assert.rejects(command(token, { action: "admin.limitsExport" }), (e: { status?: number }) => e.status === 403);
  await assert.rejects(command(token, { action: "admin.limitsImport", file: sample(), dryRun: true }), (e: { status?: number }) => e.status === 403);
});
