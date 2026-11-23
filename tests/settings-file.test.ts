// The instance settings file (#447, lib/settings-file.ts, Administration →
// Instanz → Einstellungen exportieren / importieren): the export without
// secrets, the round trip without changes, a partial file that changes only
// its values, secrets refused, strict validation with paths, one
// transaction (a late failure rolls back everything), the limits section
// checked against the AI section of the same file, and who may use it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-settings-file-"));
process.env.APP_URL = "https://flowplan.example.test";
delete process.env.FLOWPLAN_AI;
const { run, one, all, id } = await import("../lib/db");
const { identityFromToken } = await import("../lib/auth");
const { command } = await import("../lib/api");
const { instanceSettings } = await import("../lib/instance-settings");
const { instanceAiSettings, adminAiView } = await import("../lib/ai/settings");
const { quotaRules, quotaSettings } = await import("../lib/ai/quota");
const { modelRules } = await import("../lib/ai/model-policy");
const { saveSftpBackup, sftpBackupSettings } = await import("../lib/sftp-backup");
import type { Identity } from "../lib/types";
import type { SettingsImportResult } from "../lib/settings-file";

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

// Throwaway secrets, made at runtime.
const AI_KEY = `sk-test-${randomBytes(12).toString("hex")}`;
const SFTP_PASSWORD = `pw-${randomBytes(12).toString("hex")}`;
const MODELS = { haiku: "claude-haiku-4-5", sonnet: "claude-sonnet-4-6", opus: "claude-opus-4-1" };
await command(admin, {
  action: "admin.ai",
  apiKey: AI_KEY,
  settings: {
    enabled: true,
    provider: { kind: "anthropic", baseUrl: "http://127.0.0.1:9", model: MODELS.haiku, embeddingModel: "" },
    prices: [
      { model: MODELS.haiku, input: 1, output: 5 },
      { model: MODELS.sonnet, input: 3, output: 15 },
    ],
    currency: "USD",
  },
});
await saveSftpBackup(admin.id, { enabled: false, host: "backup.example.test", port: 2222, username: "flowplan", auth: "password", password: SFTP_PASSWORD, directory: "flowplan", keep: 5, uploads: false });
await command(admin, { action: "admin.settings", settings: { name: "Muster", announcement: "Hallo", trashDays: 14, allowSignup: false } });
await command(admin, { action: "admin.aiQuotas", rules: [{ scope: "default", limits: { month: 100_000 } }, { scope: "role", target: "guest", limits: { day: 1000 } }, { scope: "user", target: member.id, exempt: true }] });
await command(admin, { action: "admin.aiRule", scope: "role", target: "admin", model: MODELS.sonnet });

const exportFile = async (who: Identity = admin) => (await command(who, { action: "admin.settingsExport" })) as Json;
const importFile = async (file: unknown, dryRun: boolean, who: Identity = admin) => (await command(who, { action: "admin.settingsImport", file, dryRun })) as SettingsImportResult;
const header = { format: "flowplan-settings", version: 1 };
const snapshot = async () => ({
  settings: await all("SELECT key,value FROM instance_settings WHERE key NOT IN ('limitsFile','securityPepper') ORDER BY key"),
  ai: await all("SELECT config,key_cipher,key_hint FROM ai_instance"),
  quota: await all("SELECT scope,target,exempt,limits,after_model,after_kind,after_limits FROM ai_quota_rules ORDER BY scope,target"),
  models: await all("SELECT scope,target,model,kind FROM ai_model_rules ORDER BY scope,target"),
  limits: await all("SELECT target,limits FROM group_limits ORDER BY target"),
});
const imports = async () => Number((await one<{ n: number }>("SELECT COUNT(*) n FROM audit WHERE action='admin.settingsImport'"))!.n);

test("export: every section, secrets only as whether they are set", async () => {
  const file = await exportFile();
  assert.equal(file.format, "flowplan-settings");
  assert.equal(file.version, 1);
  assert.deepEqual(Object.keys(file).filter((k) => !k.startsWith("_")), ["format", "version", "instance", "ai", "limits"]);
  assert.equal(file.instance.name, "Muster");
  assert.equal(file.instance.trashDays, 14);
  assert.equal(file.instance.starterSpace, undefined);
  assert.equal(file.instance.starterBy, undefined);
  assert.equal(file.instance.maintenance, undefined);
  assert.deepEqual(file.instance.sftpBackup, {
    enabled: false,
    host: "backup.example.test",
    port: 2222,
    username: "flowplan",
    auth: "password",
    directory: "flowplan",
    keep: 5,
    uploads: false,
    password: { set: true },
    privateKey: { set: false },
    passphrase: { set: false },
  });
  assert.deepEqual(file.ai.apiKey, { set: true });
  assert.equal(file.ai.provider.kind, "anthropic");
  assert.equal(file.ai.provider.model, MODELS.haiku);
  assert.equal(file.ai.quota.unit, "tokens");
  // The rules of the instance, the default and the roles; never a single account's.
  assert.deepEqual(file.ai.quotaRules, [
    { scope: "default", exempt: false, limits: { month: 100_000 }, after: null, afterLimits: null },
    { scope: "role", role: "guest", exempt: false, limits: { day: 1000 }, after: null, afterLimits: null },
  ]);
  assert.deepEqual(file.ai.modelRules, [{ scope: "role", role: "admin", model: MODELS.sonnet }]);
  // The limits file, version 1, as it is.
  assert.equal(file.limits.version, 1);
  assert.ok(file.limits.flowplan.defaults);
  // No secret anywhere, nor anything sealed.
  const text = JSON.stringify(file);
  assert.ok(!text.includes(AI_KEY) && !text.includes(SFTP_PASSWORD), "a secret in the export");
  assert.ok(!/key_cipher|v\d:[A-Za-z0-9+/=]{20,}/.test(text), "a sealed value in the export");
  assert.ok(!text.includes(member.id), "a person in the export");
});

test("round trip: the export imported again has no changes", async () => {
  const before = await snapshot();
  const audits = await imports();
  const file = await exportFile();
  const check = await importFile(JSON.stringify(file, null, 2), true);
  assert.equal(check.ok, true, JSON.stringify(check.errors));
  assert.deepEqual([check.changes, check.secrets, check.notes], [[], [], []]);
  const applied = await importFile(file, false);
  assert.deepEqual([applied.ok, applied.applied, applied.changes], [true, false, []]);
  assert.deepEqual(await snapshot(), before);
  assert.equal(await imports(), audits);
});

test("a partial file changes only its values; one audit entry", async () => {
  const before = await snapshot();
  const audits = await imports();
  const file = { ...header, instance: { name: "Neu", allowSignup: true }, ai: { features: { summarize: false } } };
  const check = await importFile(file, true);
  assert.equal(check.ok, true, JSON.stringify(check.errors));
  assert.deepEqual(
    check.changes.map((c) => ("path" in c ? [c.path, c.before, c.after] : null)),
    [
      ["instance.name", "Muster", "Neu"],
      ["instance.allowSignup", false, true],
      ["ai.features.summarize", true, false],
    ],
  );
  // The check wrote nothing.
  assert.deepEqual(await snapshot(), before);
  const applied = await importFile(file, false);
  assert.equal(applied.applied, true);
  const s = await instanceSettings();
  assert.deepEqual([s.name, s.allowSignup, s.announcement, s.trashDays], ["Neu", true, "Hallo", 14]);
  const ai = await instanceAiSettings();
  assert.equal(ai.features.summarize, false);
  assert.equal(ai.provider?.model, MODELS.haiku);
  // The key stays.
  assert.equal((await adminAiView()).key.stored, true);
  assert.equal((await quotaRules()).length, 3);
  assert.equal(await imports(), audits + 1);
  // Back as it was.
  await importFile({ ...header, instance: { name: "Muster", allowSignup: false }, ai: { features: { summarize: true } } }, false);
});

test("secrets: a value in their place is refused and never stored", async () => {
  const before = await snapshot();
  const leaked = `sk-other-${randomBytes(8).toString("hex")}`;
  const file = {
    ...header,
    instance: { name: "X", sftpBackup: { enabled: true, host: "other.example.test", port: 22, username: "u", auth: "password", directory: "d", keep: 3, uploads: true, password: leaked } },
    ai: { apiKey: leaked },
  };
  const check = await importFile(file, true);
  assert.equal(check.ok, false);
  assert.deepEqual(
    check.errors.map((e) => [e.path, e.code]),
    [
      ["instance.sftpBackup.password", "secret_value"],
      ["ai.apiKey", "secret_value"],
    ],
  );
  assert.ok(!JSON.stringify(check).includes(leaked), "the secret comes back in the answer");
  await assert.rejects(importFile(file, false), (e: { status?: number }) => e.status === 400);
  assert.deepEqual(await snapshot(), before);
  // A key in the provider is an unknown field, not a way in.
  const inProvider = await importFile({ ...header, ai: { provider: { kind: "openai", baseUrl: "", model: "gpt-4o", embeddingModel: "", apiKey: leaked } } }, true);
  assert.deepEqual(
    inProvider.errors.map((e) => [e.path, e.code]),
    [["ai.provider.apiKey", "unknown_field"]],
  );
});

test("secrets the file has and the instance lacks: still to enter", async () => {
  const file = await exportFile();
  await command(admin, { action: "admin.ai", apiKey: null });
  const check = await importFile(file, true);
  assert.equal(check.ok, true, JSON.stringify(check.errors));
  assert.deepEqual(check.secrets, ["ai.apiKey"]);
  assert.deepEqual(check.changes, []);
  // Another provider on import: its key goes, and is still to enter.
  await command(admin, { action: "admin.ai", apiKey: AI_KEY });
  const moved = await importFile({ ...header, ai: { provider: { ...file.ai.provider, kind: "openai", model: "gpt-4o" }, apiKey: { set: true } } }, true);
  assert.equal(moved.ok, true, JSON.stringify(moved.errors));
  assert.deepEqual(moved.secrets, ["ai.apiKey"]);
  assert.ok(moved.changes.some((c) => "path" in c && c.path === "ai.apiKey"));
  assert.equal((await adminAiView()).key.stored, true);
});

test("validation: unknown keys, wrong types and ranges with their paths, nothing written", async () => {
  const before = await snapshot();
  const check = await importFile(
    {
      ...header,
      extra: 1,
      _comment: "ignored",
      instance: { nmae: "typo", trashDays: 99_999, allowSignup: "yes", maxUploadMb: 0, workflowLimits: { runsPerMinute: 5000 }, starterSpace: null },
      ai: { quota: { unit: "dollars" }, quotaRules: [{ scope: "role", role: "owner" }, { scope: "group" }], provider: { kind: "anthropic" } },
      limits: { version: 1, plans: [{ group: "A", kind: "plan", storageMb: -1 }] },
    },
    true,
  );
  assert.equal(check.ok, false);
  const got = check.errors.map((e) => [e.path, e.code]);
  for (const want of [
    ["extra", "unknown_field"],
    ["instance.nmae", "unknown_field"],
    ["instance.starterSpace", "unknown_field"],
    ["instance.trashDays", "out_of_range"],
    ["instance.allowSignup", "invalid"],
    ["instance.maxUploadMb", "too_small"],
    ["instance.workflowLimits.runsPerMinute", "out_of_range"],
    ["ai.quota.unit", "invalid"],
    ["ai.quotaRules[0].role", "invalid"],
    ["ai.provider.model", "required"],
  ])
    assert.ok(
      got.some(([p, c]) => p === want[0] && c === want[1]),
      `${want.join(" ")} missing in ${JSON.stringify(got)}`,
    );
  assert.ok(!got.some(([p]) => p === "_comment"));
  // The limits section is checked only once the rest is valid.
  const limits = await importFile({ ...header, limits: { version: 1, plans: [{ group: "A", kind: "plan", storageMb: -1 }] } }, true);
  assert.deepEqual(
    limits.errors.map((e) => [e.path, e.code]),
    [["limits.plans[0].storageMb", "out_of_range"]],
  );
  // Without format, a limits file is pointed to its own import.
  const plain = await importFile({ version: 1, plans: [] }, true);
  assert.deepEqual(
    plain.errors.map((e) => [e.path, e.code]),
    [["format", "limits_file"]],
  );
  const json = await importFile("{ nope", true);
  assert.equal(json.errors[0].code, "invalid_json");
  // A rule of a group without its name, a duplicate.
  const rules = await importFile({ ...header, ai: { quotaRules: [{ scope: "group", group: "X" }, { scope: "group", group: "X" }, { scope: "group" }] } }, true);
  assert.deepEqual(
    rules.errors.map((e) => [e.path, e.code]),
    [
      ["ai.quotaRules[1]", "duplicate"],
      ["ai.quotaRules[2].group", "required"],
    ],
  );
  assert.deepEqual(await snapshot(), before);
});

test("one transaction: a failure in the limits section rolls back instance and AI", async () => {
  const before = await snapshot();
  const file = {
    ...header,
    instance: { name: "Halb", announcement: "" },
    ai: { quota: { warnAt: 50 }, quotaRules: [{ scope: "default", limits: { month: 1 } }] },
    // Valid as a file, refused against the instance: a model it does not know.
    limits: { version: 1, plans: [{ group: "Late", kind: "plan", storageMb: 10, aiTokens: 1000, aiAfter: "claude-unknown-1" }] },
  };
  const check = await importFile(file, true);
  assert.equal(check.ok, false);
  assert.deepEqual(
    check.errors.map((e) => [e.path, e.code]),
    [["limits.plans[0].aiAfter", "unknown_model"]],
  );
  await assert.rejects(importFile(file, false), (e: { status?: number }) => e.status === 400);
  assert.deepEqual(await snapshot(), before);
  assert.equal((await instanceSettings()).name, "Muster");
  assert.equal((await quotaSettings()).warnAt, 80);
  // A refusal of a save function in the middle (the maintenance window is
  // over) rolls back as well.
  const past = await importFile({ ...header, instance: { name: "Halb", maintenance: { message: "Wartung", start: Date.now() - 7200_000, end: Date.now() - 3600_000 } } }, true);
  assert.deepEqual(
    past.errors.map((e) => [e.path, e.code]),
    [["instance.maintenance", "rejected"]],
  );
  await assert.rejects(importFile({ ...header, instance: { name: "Halb", maintenance: { message: "Wartung", start: Date.now() - 7200_000, end: Date.now() - 3600_000 } } }, false));
  assert.deepEqual(await snapshot(), before);
});

test("the limits section is checked against the AI section of the same file", async () => {
  const newModel = "claude-sonnet-9";
  const limits = { version: 1, plans: [{ group: "Team", kind: "plan", storageMb: 100, aiTokens: 50_000, aiAfter: newModel }] };
  // Alone, the instance does not know the model.
  const alone = (await command(admin, { action: "admin.limitsImport", file: limits, dryRun: true })) as { errors: { path: string; code: string }[] };
  assert.ok(alone.errors.some((e) => e.path === "plans[0].aiAfter" && e.code === "unknown_model"), JSON.stringify(alone.errors));
  // With the price list of the same file it does.
  const current = await instanceAiSettings();
  const file = { ...header, ai: { prices: [...current.prices, { model: newModel, input: 3, output: 15 }] }, limits };
  const check = await importFile(file, true);
  assert.equal(check.ok, true, JSON.stringify(check.errors));
  assert.ok(check.changes.some((c) => "path" in c && c.path === `ai.prices[${newModel}]`));
  assert.ok(check.changes.some((c) => c.section === "limits" && c.change.area === "quota" && c.change.after?.after === newModel), JSON.stringify(check.changes));
  assert.equal((await instanceAiSettings()).prices.length, 2);
  const applied = await importFile(file, false);
  assert.equal(applied.applied, true);
  assert.equal((await quotaRules()).find((r) => r.target === "dir:Team")?.after, newModel);
  // And the whole export once more: nothing to do.
  const again = await importFile(await exportFile(), true);
  assert.deepEqual([again.ok, again.changes], [true, []]);
});

test("quota and model rules: the file's replace those of its scopes, single accounts stay", async () => {
  const file = await exportFile();
  file.ai.quotaRules = [{ scope: "group", group: "Plus", limits: { month: 7 } }];
  file.ai.modelRules = [];
  delete file.limits;
  const check = await importFile(file, true);
  assert.equal(check.ok, true, JSON.stringify(check.errors));
  const paths = check.changes.map((c) => ("path" in c ? c.path : ""));
  for (const p of ["ai.quotaRules[default:]", "ai.quotaRules[role:guest]", "ai.quotaRules[group:Plus]", "ai.modelRules[role:admin]"]) assert.ok(paths.includes(p), `${p} in ${paths}`);
  await importFile(file, false);
  const rules = await quotaRules();
  assert.ok(rules.some((r) => r.scope === "user" && r.target === member.id && r.exempt), "the person's own rule stays");
  assert.ok(!rules.some((r) => r.scope === "default" || r.scope === "role"));
  assert.deepEqual(rules.find((r) => r.target === "dir:Plus")?.limits, { month: 7 });
  assert.ok(!(await modelRules()).some((r) => r.scope === "role"));
  // The SFTP target kept its password throughout.
  assert.equal((await sftpBackupSettings()).hasPassword, true);
});

test("administrators only, never with an API token", async () => {
  await assert.rejects(command(member, { action: "admin.settingsExport" }), (e: { status?: number }) => e.status === 403);
  await assert.rejects(command(member, { action: "admin.settingsImport", file: header, dryRun: true }), (e: { status?: number }) => e.status === 403);
  const token = { ...admin, apiScope: "write" } as Identity;
  await assert.rejects(command(token, { action: "admin.settingsExport" }), (e: { status?: number }) => e.status === 403);
  await assert.rejects(command(token, { action: "admin.settingsImport", file: header, dryRun: true }), (e: { status?: number }) => e.status === 403);
});
