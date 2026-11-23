// The instance settings file (#447, Administration → Instanz → Einstellungen
// exportieren / importieren): the instance's configuration as one versioned
// JSON file – to move it to another instance, keep it in version control or
// restore it after a mistake.
//
//   { "format": "flowplan-settings", "version": 1,
//     "instance": { …Administration's instance settings (lib/instance-settings.ts:
//                   name, notice, sign-up, retention, sessions, features, editor
//                   toolbar, backups, …), "workflowLimits": {…} (lib/workflows/
//                   limits.ts, null = the environment), "maintenance": {message,
//                   start, end} | null (lib/admin-ops.ts), "sftpBackup": {…
//                   options…, "password": {"set": true}, …} | null },
//     "ai":       { enabled, provider: {kind, baseUrl, model, embeddingModel} | null,
//                   access, guests, userProviders, features, semanticSearch,
//                   device, tokens, prices, currency (lib/ai/settings.ts),
//                   "apiKey": {"set": true},
//                   "quota": {unit, timeZone, weekStart, warnAt,
//                             workflowsCountInstance} (lib/ai/quota.ts),
//                   "quotaRules": [{ scope: "instance"|"default"|"role"|"group",
//                                    role?, group?, exempt, limits, after, afterLimits }],
//                   "modelRules": [{ scope: "role"|"group", role?, group?, model }] },
//     "limits":   { the limits file, version 1, unchanged (lib/limits-file.ts) } }
//
// Secrets are never in the file: where one belongs, the file says only
// whether it is set ({"set": true}). A secret's value in its place is an
// error for that key and is never stored. On import the instance keeps its
// own secrets; those the file says are set but the instance lacks are listed
// as "still to enter".
//
// Not part of the file: sign-in and SSO (OIDC, LDAP, SCIM), directory group
// mappings, workspaces and their content (starter space, workspace groups,
// banners), accounts and anything per person (AI rules of single accounts),
// health alerts, push and messengers. Rules in "ai" name directory groups
// by name ("group"); rules of workspace groups stay with the limits file.
//
// Every key is optional: what is not in the file stays as it is. A key that
// is there replaces the value – a list (prices, quotaRules, modelRules) as a
// whole: quotaRules replaces the rules of the instance, the default, the
// roles and the directory groups (rules of single accounts and workspace
// groups stay), modelRules those of the roles and directory groups for the
// instance's provider. Keys starting with "_" at the top are ignored.
//
// Checking ("Prüfen", dryRun) validates the whole file strictly (unknown
// keys, types and ranges with their path, the same schemas as the
// administration's forms), applies it inside a savepoint that is rolled
// back, and lists every change old → new. Applying does the same in one
// transaction: instance → ai (provider, default model and prices before the
// quotas and model rules) → limits, so the limits section's model checks see
// the AI settings of the same file. Any error rolls everything back. One
// audit entry per import. Administrators only (admin.settingsExport,
// admin.settingsImport); API tokens never (lib/api.ts refuses admin.*).
import { z } from "zod";
import { all, audit, run, transaction } from "./db";
import { HttpError } from "./auth";
import { requireAdmin } from "./permissions";
import type { Identity } from "./types";
import { instanceSettings, instanceSettingsSchema, saveInstanceSettings, type InstanceSettings } from "./instance-settings";
import { instanceSettingsChanged } from "./instance-settings-events";
import { toolbarLayoutSchema } from "./toolbar-layout";
import { hiddenModulesSchema } from "./feature-modules-schema";
import { saveWorkflowLimits, storedWorkflowLimits, workflowLimitsSchema } from "./workflows/limits";
import { maintenanceNotice, maintenanceSchema, saveMaintenance } from "./admin-ops";
import { removeSftpBackup, saveSftpBackup, sftpBackupSettings, sftpOptionsSchema } from "./sftp-backup";
import { aiFeatureFlags, aiInstanceSchema, aiPriceSchema, aiProviderSchema, instanceAiSettings, instanceKey, saveInstanceAi } from "./ai/settings";
import { afterSchema, checkedAfter, cleanLimits, hasLimit, instanceModelOptions, limitsSchema, quotaRules, quotaSettings, quotaSettingsSchema } from "./ai/quota";
import { MODEL_NAME, modelRules } from "./ai/model-policy";
import { QUOTA_ROLES, type QuotaLimits, type QuotaSettings } from "./ai/quota-shared";
import { directoryKey, directoryName, isDirectoryKey, MAX_DIRECTORY_NAME } from "./group-keys";
import { exportLimitsFile, importLimitsFile, type FileIssue, type LimitsChange } from "./limits-file";

export const SETTINGS_FILE_FORMAT = "flowplan-settings";
export const SETTINGS_FILE_VERSION = 1;
export const MAX_SETTINGS_FILE_CHARS = 1024 * 1024;
const MAX_ERRORS = 200;
const AUDIT_ACTION = "admin.settingsImport";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const has = (o: Obj, k: string) => Object.hasOwn(o, k);

// ---- The file's schemas: the stores' own, strict ----

// Where a secret belongs: only whether one is set.
const secretMarker = z.object({ set: z.boolean() }).strict();
type SecretMarker = z.infer<typeof secretMarker>;
// Every secret the file knows, by its path.
export const SECRET_PATHS = ["instance.sftpBackup.password", "instance.sftpBackup.privateKey", "instance.sftpBackup.passphrase", "ai.apiKey"] as const;
export type SecretPath = (typeof SECRET_PATHS)[number];

// Administration's instance settings, without the starter content (a space
// of a workspace, and who chose it).
const NOT_IN_FILE = new Set(["starterSpace", "starterBy"]);
const AI_SETTING_KEYS = ["enabled", "provider", "access", "guests", "userProviders", "features", "semanticSearch", "device", "tokens", "prices", "currency"] as const;
// The scopes of rules the file carries (not single accounts).
const RULE_SCOPES = ["instance", "default", "role", "group"] as const;
// Built on first use: the stores' modules import this one in a cycle
// (lib/api.ts), so their schemas are not there yet while it loads.
let schemas: ReturnType<typeof buildSchemas> | null = null;
const fileSchemas = () => (schemas ??= buildSchemas());
const instanceKeys = () => fileSchemas().instanceKeys;
function buildSchemas() {
  const instanceKeys = Object.keys(instanceSettingsSchema.shape).filter((k) => !NOT_IN_FILE.has(k)) as (keyof InstanceSettings)[];
  const sftp = sftpOptionsSchema.extend({ password: secretMarker.optional(), privateKey: secretMarker.optional(), passphrase: secretMarker.optional() }).strict();
  const instance = z
    .object({
      ...Object.fromEntries(instanceKeys.map((k) => [k, instanceSettingsSchema.shape[k]])),
      // Read leniently in the store; in the file as strictly as they are saved.
      toolbarLayoutDefault: toolbarLayoutSchema,
      modulesDefault: hiddenModulesSchema,
      modulesOff: hiddenModulesSchema,
      workflowLimits: workflowLimitsSchema,
      maintenance: z.object(maintenanceSchema.unwrap().shape).strict().nullable(),
      sftpBackup: sftp.nullable(),
    })
    .partial()
    .strict();
  const groupName = z.string().trim().min(1).max(MAX_DIRECTORY_NAME);
  const quotaRule = z
    .object({
      scope: z.enum(RULE_SCOPES),
      role: z.enum(QUOTA_ROLES).optional(),
      group: groupName.optional(),
      exempt: z.boolean().default(false),
      limits: limitsSchema.default({}),
      after: afterSchema,
      afterLimits: limitsSchema.nullable().optional(),
    })
    .strict();
  const modelRule = z
    .object({
      scope: z.enum(["role", "group"]),
      role: z.enum(QUOTA_ROLES).optional(),
      group: groupName.optional(),
      model: z.string().trim().min(1).max(200).regex(MODEL_NAME, "Ungültiger Modellname."),
    })
    .strict();
  const ai = z
    .object({
      ...Object.fromEntries(AI_SETTING_KEYS.map((k) => [k, aiInstanceSchema.shape[k]])),
      provider: aiProviderSchema.strict().nullable(),
      features: aiFeatureFlags.strict(),
      prices: z.array(aiPriceSchema.strict()).max(50),
      apiKey: secretMarker,
      quota: quotaSettingsSchema.partial().strict(),
      quotaRules: z.array(quotaRule).max(5000),
      modelRules: z.array(modelRule).max(5000),
    })
    .partial()
    .strict();
  return { instanceKeys, instance, ai };
}

// ---- Problems with a place in the file ----

// FileIssue of the limits file, with the smallest value a range allows and
// the server's own words for a refusal (code "rejected").
export type SettingsIssue = FileIssue & { min?: number; message?: string };

const pathOf = (prefix: string, parts: readonly PropertyKey[]) =>
  parts.reduce<string>((p, k) => (typeof k === "number" ? `${p}[${k}]` : p ? `${p}.${String(k)}` : String(k)), prefix);
const valueAt = (root: unknown, parts: readonly PropertyKey[]) => parts.reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as Obj)[k as string] : undefined), root);
function zodIssues(error: z.ZodError, raw: unknown, prefix: string, out: SettingsIssue[]) {
  for (const issue of error.issues) {
    const path = pathOf(prefix, issue.path);
    if (issue.code === "unrecognized_keys") for (const key of issue.keys) out.push({ path: pathOf(path, [key]), code: "unknown_field" });
    else if (issue.code === "too_big") out.push({ path, code: issue.origin === "array" ? "too_many" : "out_of_range", max: Number(issue.maximum) });
    else if (issue.code === "too_small") out.push({ path, code: issue.origin === "string" && Number(issue.minimum) === 1 ? "required" : "too_small", min: Number(issue.minimum) });
    else if (issue.code === "invalid_value") out.push({ path, code: "invalid", allowed: issue.values.map(String) });
    else if (issue.code === "invalid_type" && valueAt(raw, issue.path) === undefined) out.push({ path, code: "required" });
    else out.push({ path, code: "invalid" });
  }
}
// What a save function refused, at the place of the file it came from.
function refusal(error: unknown, path: string): SettingsIssue {
  if (error instanceof z.ZodError) return { path, code: "invalid" };
  if (error instanceof HttpError && error.status < 500) return { path, code: "rejected", message: error.message };
  throw error;
}

// ---- The current settings, in the file's shape ----

type QuotaRuleFile = { scope: (typeof RULE_SCOPES)[number]; role?: string; group?: string; exempt: boolean; limits: QuotaLimits; after: string | null; afterLimits: QuotaLimits | null };
type ModelRuleFile = { scope: "role" | "group"; role?: string; group?: string; model: string };
const ruleTarget = (r: { scope: string; role?: string; group?: string }) => (r.scope === "role" ? (r.role ?? "") : r.scope === "group" ? directoryKey((r.group ?? "").replace(/\s+/g, " ")) : "");
const ruleKey = (r: { scope: string; role?: string; group?: string }) => `${r.scope}:${r.scope === "group" ? (r.group ?? "") : (r.role ?? "")}`;
// A rule of a scope the file carries: not single accounts, not workspace groups.
const portable = (scope: string, target: string) => scope === "instance" || scope === "default" || scope === "role" || (scope === "group" && isDirectoryKey(target));
const who = (scope: string, target: string) => (scope === "role" ? { role: target } : scope === "group" ? { group: directoryName(target) } : {});
const onlyNumbers = (l: QuotaLimits | null | undefined) => Object.fromEntries(Object.entries(l ?? {}).filter(([, v]) => typeof v === "number")) as QuotaLimits;

// Every value the file can carry, as it is now (null where nothing is set,
// for comparing); the export leaves out the empty maintenance and SFTP target.
async function currentSections() {
  const s = await instanceSettings();
  const instance: Obj = {};
  for (const k of instanceKeys()) instance[k] = s[k];
  instance.workflowLimits = await storedWorkflowLimits();
  instance.maintenance = await maintenanceNotice();
  const sftp = await sftpBackupSettings();
  instance.sftpBackup = sftp.host
    ? {
        enabled: sftp.enabled,
        host: sftp.host,
        port: sftp.port,
        username: sftp.username,
        auth: sftp.auth,
        directory: sftp.directory,
        keep: sftp.keep,
        uploads: sftp.uploads,
        password: { set: sftp.hasPassword },
        privateKey: { set: sftp.hasPrivateKey },
        passphrase: { set: sftp.hasPassphrase },
      }
    : null;
  const a = await instanceAiSettings();
  const ai: Obj = {};
  for (const k of AI_SETTING_KEYS) ai[k] = a[k];
  ai.apiKey = { set: (await instanceKey()).source !== null };
  const q = await quotaSettings();
  ai.quota = { ...q };
  const kind = a.provider?.model.trim() ? a.provider.kind : null;
  ai.quotaRules = (await quotaRules(q.unit))
    .filter((r) => portable(r.scope, r.target))
    .map(
      (r): QuotaRuleFile => ({
        scope: r.scope as QuotaRuleFile["scope"],
        ...who(r.scope, r.target),
        exempt: r.exempt,
        limits: onlyNumbers(r.limits),
        // A model for another provider kind is inactive: not carried.
        after: r.after && r.afterKind === kind ? r.after : null,
        afterLimits: r.after && r.afterKind === kind && hasLimit(r.afterLimits) ? onlyNumbers(r.afterLimits) : null,
      }),
    );
  ai.modelRules = (await modelRules())
    .filter((r) => (r.scope === "role" || (r.scope === "group" && isDirectoryKey(r.target))) && r.kind === kind && r.model)
    .map((r): ModelRuleFile => ({ scope: r.scope as "role" | "group", ...who(r.scope, r.target), model: r.model }));
  return { instance, ai };
}

// ---- Export ----

// admin.settingsExport: the current settings as a file of this format.
export async function exportSettingsFile(user: Identity) {
  requireAdmin(user);
  const { instance, ai } = await currentSections();
  if (instance.maintenance === null) delete instance.maintenance;
  if (instance.sftpBackup === null) delete instance.sftpBackup;
  const limits = (await exportLimitsFile(user)) as Obj;
  delete limits._exportedAt;
  return { format: SETTINGS_FILE_FORMAT, version: SETTINGS_FILE_VERSION, _exportedAt: new Date().toISOString(), instance, ai, limits };
}

// ---- Comparing ----

// One change: a value of "instance" or "ai" (path in the file, old → new;
// null: not set), or one of the limits file's changes.
export type SettingsChange = { section: "instance" | "ai"; path: string; before: unknown; after: unknown } | { section: "limits"; change: LimitsChange };

const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (isObj(v))
    return Object.fromEntries(
      Object.keys(v)
        .filter((k) => v[k] !== undefined)
        .sort()
        .map((k) => [k, canonical(v[k])]),
    );
  return v === undefined ? null : v;
}
// Lists whose entries have a name: compared entry by entry.
const KEYED: Record<string, (entry: Obj) => string> = {
  "ai.prices": (e) => String(e.model),
  "ai.quotaRules": (e) => ruleKey(e as { scope: string }),
  "ai.modelRules": (e) => ruleKey(e as { scope: string }),
};
function diff(section: "instance" | "ai", path: string, before: unknown, after: unknown, out: SettingsChange[]) {
  if (same(before, after)) return;
  const keyed = KEYED[path];
  if (keyed && Array.isArray(before) && Array.isArray(after)) {
    const a = new Map(before.map((e) => [keyed(e as Obj), e]));
    const b = new Map(after.map((e) => [keyed(e as Obj), e]));
    for (const k of new Set([...a.keys(), ...b.keys()])) if (!same(a.get(k), b.get(k))) out.push({ section, path: `${path}[${k}]`, before: a.get(k) ?? null, after: b.get(k) ?? null });
    return;
  }
  // A secret's marker and the provider are one value each.
  if (isObj(before) && isObj(after) && path !== "ai.provider" && !("set" in after)) {
    for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) diff(section, `${path}.${k}`, before[k] ?? null, after[k] ?? null, out);
    return;
  }
  out.push({ section, path, before: before ?? null, after: after ?? null });
}

// ---- Import ----

export type SettingsImportResult = {
  ok: boolean;
  dryRun: boolean;
  applied: boolean;
  errors: SettingsIssue[];
  errorCount: number;
  notes: SettingsIssue[];
  changes: SettingsChange[];
  // Secrets the file says are set and this instance lacks: still to enter.
  secrets: SecretPath[];
};

type Parsed = { instance: Obj | null; ai: Obj | null; limits: Obj | null; secrets: Map<SecretPath, SecretMarker> };

function parseFile(file: unknown, errors: SettingsIssue[]): Parsed | null {
  let raw = file;
  if (typeof raw === "string") {
    if (raw.length > MAX_SETTINGS_FILE_CHARS) {
      errors.push({ path: "", code: "too_large", max: MAX_SETTINGS_FILE_CHARS });
      return null;
    }
    try {
      raw = JSON.parse(raw);
    } catch (error) {
      // JSON.parse names the position, never the content.
      const at = /position (\d+)/.exec((error as Error).message)?.[1];
      errors.push({ path: at === undefined ? "" : `line ${(file as string).slice(0, Number(at)).split("\n").length}`, code: "invalid_json" });
      return null;
    }
  }
  if (!isObj(raw)) {
    errors.push({ path: "", code: "invalid" });
    return null;
  }
  // A limits file on its own: it belongs to Grenzen & Aufbewahrung.
  if (!has(raw, "format") && (has(raw, "plans") || has(raw, "flowplan"))) {
    errors.push({ path: "format", code: "limits_file" });
    return null;
  }
  for (const k of Object.keys(raw)) if (!["format", "version", "instance", "ai", "limits"].includes(k) && !k.startsWith("_")) errors.push({ path: k, code: "unknown_field" });
  if (raw.format !== SETTINGS_FILE_FORMAT) errors.push({ path: "format", code: has(raw, "format") ? "invalid" : "required", allowed: [SETTINGS_FILE_FORMAT] });
  if (raw.version !== SETTINGS_FILE_VERSION) errors.push({ path: "version", code: has(raw, "version") ? "unsupported" : "required" });
  const out: Parsed = { instance: null, ai: null, limits: null, secrets: new Map() };
  for (const section of ["instance", "ai", "limits"] as const) {
    if (!has(raw, section)) continue;
    if (!isObj(raw[section])) {
      errors.push({ path: section, code: "invalid" });
      continue;
    }
    if (section === "limits") {
      out.limits = raw.limits as Obj;
      continue;
    }
    // Secrets first: a value in their place is refused and never read.
    const copy = structuredClone(raw[section]) as Obj;
    for (const path of SECRET_PATHS) {
      const parts = path.split(".");
      if (parts[0] !== section) continue;
      const parent = valueAt(copy, parts.slice(1, -1));
      const key = parts[parts.length - 1];
      if (!isObj(parent) || !has(parent, key)) continue;
      const marker = secretMarker.safeParse(parent[key]);
      if (marker.success) out.secrets.set(path, marker.data);
      else {
        errors.push({ path, code: isObj(parent[key]) ? "invalid" : "secret_value" });
        delete parent[key];
      }
    }
    const schema = section === "instance" ? fileSchemas().instance : fileSchemas().ai;
    const parsed = schema.safeParse(copy);
    if (!parsed.success) {
      zodIssues(parsed.error, copy, section, errors);
      continue;
    }
    // Only the keys the file has: defaults of the schema are not values.
    const data = parsed.data as Obj;
    out[section] = Object.fromEntries(Object.keys(copy).map((k) => [k, data[k]]));
  }
  // Rules: who they are for, once each.
  const rules = (list: unknown, path: string, scopes: readonly string[]) => {
    if (!Array.isArray(list)) return;
    const seen = new Set<string>();
    list.forEach((r: { scope: string; role?: string; group?: string }, i) => {
      if (!scopes.includes(r.scope)) return;
      if (r.scope === "role" && !r.role) errors.push({ path: `${path}[${i}].role`, code: "required", allowed: [...QUOTA_ROLES] });
      if (r.scope === "group" && !r.group) errors.push({ path: `${path}[${i}].group`, code: "required" });
      if (r.scope !== "role" && r.role !== undefined) errors.push({ path: `${path}[${i}].role`, code: "unknown_field" });
      if (r.scope !== "group" && r.group !== undefined) errors.push({ path: `${path}[${i}].group`, code: "unknown_field" });
      const key = ruleKey(r);
      if (seen.has(key)) errors.push({ path: `${path}[${i}]`, code: "duplicate" });
      seen.add(key);
    });
  };
  rules(out.ai?.quotaRules, "ai.quotaRules", RULE_SCOPES);
  rules(out.ai?.modelRules, "ai.modelRules", ["role", "group"]);
  return errors.length ? null : out;
}

// The steps of one import, in order; each records what it refused.
async function applyInstance(user: Identity, file: Obj, now: Obj, errors: SettingsIssue[], notes: SettingsIssue[], missing: Set<SecretPath>, real: boolean) {
  const settings: Obj = {};
  for (const k of instanceKeys()) if (has(file, k) && !same(file[k], now[k])) settings[k] = file[k];
  if (Object.keys(settings).length) {
    const previous = await instanceSettings();
    await step(async () => {
      const saved = await saveInstanceSettings(settings);
      if (real) await instanceSettingsChanged(user, previous, saved);
    }, "instance", errors);
  }
  if (has(file, "workflowLimits") && !same({ ...(now.workflowLimits as Obj), ...(file.workflowLimits as Obj) }, now.workflowLimits))
    await step(() => saveWorkflowLimits(user.id, file.workflowLimits), "instance.workflowLimits", errors);
  if (has(file, "maintenance") && !same(file.maintenance, now.maintenance)) await step(() => saveMaintenance(user.id, file.maintenance), "instance.maintenance", errors);
  if (has(file, "sftpBackup")) {
    const want = file.sftpBackup as (Obj & Partial<Record<"password" | "privateKey" | "passphrase", SecretMarker>>) | null;
    if (want === null) {
      if (now.sftpBackup !== null) await step(() => removeSftpBackup(user.id), "instance.sftpBackup", errors);
    } else {
      const current = await sftpBackupSettings();
      const lacks = (["password", "privateKey", "passphrase"] as const).filter((k) => want[k]?.set && !current[k === "password" ? "hasPassword" : k === "privateKey" ? "hasPrivateKey" : "hasPassphrase"]);
      for (const k of lacks) missing.add(`instance.sftpBackup.${k}`);
      // Without the secret its sign-in needs, the target is not taken over:
      // the administration could not save it either.
      const needed = want.auth === "password" ? "password" : "privateKey";
      if (lacks.includes(needed)) notes.push({ path: "instance.sftpBackup", code: "needs_secret", value: needed });
      else {
        const { password: _p, privateKey: _k, passphrase: _s, ...options } = want;
        const compare = { ...options, password: { set: current.hasPassword }, privateKey: { set: current.hasPrivateKey }, passphrase: { set: current.hasPassphrase } };
        if (!same(compare, now.sftpBackup)) await step(() => saveSftpBackup(user.id, options), "instance.sftpBackup", errors);
      }
    }
  }
}

async function applyAi(user: Identity, file: Obj, now: Obj, errors: SettingsIssue[]) {
  // Provider, default model, prices and switches: as Administration → KI
  // saves them (another kind or address removes the stored key).
  const settings: Obj = {};
  for (const k of AI_SETTING_KEYS) {
    if (!has(file, k)) continue;
    // Features given are merged into the stored ones (as the form saves them).
    const value = k === "features" ? { ...(now.features as Obj), ...(file.features as Obj) } : file[k];
    if (!same(value, now[k])) settings[k] = file[k];
  }
  if (Object.keys(settings).length) await step(() => saveInstanceAi(user, { settings }), "ai", errors);
  const ai = await instanceAiSettings();
  const kind = ai.provider?.model.trim() ? ai.provider.kind : null;
  // The quotas' settings: as Administration → KI → Kontingente.
  const current = await quotaSettings();
  const next: QuotaSettings = { ...current, ...((file.quota as Partial<QuotaSettings>) ?? {}) };
  if (next.unit === "cost" && !ai.prices.length) {
    errors.push({ path: has((file.quota as Obj) ?? {}, "unit") ? "ai.quota.unit" : "ai.quota", code: "no_prices" });
    return;
  }
  const unitChanged = next.unit !== current.unit;
  if (!same(next, current)) await run("INSERT INTO instance_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", "aiQuota", JSON.stringify(next));
  // Model rules first: their models count as known for "after" below.
  if (has(file, "modelRules") && !same(file.modelRules, now.modelRules)) {
    const list = file.modelRules as ModelRuleFile[];
    if (list.length && !kind) errors.push({ path: "ai.modelRules", code: "no_provider" });
    else {
      const keep = new Set(list.map((r) => `${r.scope}|${ruleTarget(r)}`));
      for (const r of await modelRules())
        if ((r.scope === "role" || (r.scope === "group" && isDirectoryKey(r.target))) && r.kind === kind && !keep.has(`${r.scope}|${r.target}`)) await run("DELETE FROM ai_model_rules WHERE scope=? AND target=?", r.scope, r.target);
      const at = Date.now();
      for (const r of list)
        await run(
          "INSERT INTO ai_model_rules(scope,target,model,kind,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(scope,target) DO UPDATE SET model=excluded.model,kind=excluded.kind,updated_at=excluded.updated_at",
          r.scope,
          ruleTarget(r),
          r.model,
          kind,
          at,
        );
    }
  }
  // Quota rules: the file's replace those of its scopes. Another unit
  // empties the numbers of every rule the file does not set (as the
  // administration does).
  const given = has(file, "quotaRules") && (!same(file.quotaRules, now.quotaRules) || unitChanged);
  if (!given && !unitChanged) return;
  const list = given ? (file.quotaRules as QuotaRuleFile[]) : [];
  const rows: { scope: string; target: string; exempt: boolean; limits: QuotaLimits; after: { model: string; kind: string } | null; afterLimits: QuotaLimits }[] = [];
  for (const [i, r] of list.entries()) {
    const instanceWide = r.scope === "instance" || r.scope === "default";
    const exempt = instanceWide ? false : r.exempt;
    let after: { model: string; kind: string } | null = null;
    if (r.scope !== "instance" && !exempt && r.after)
      try {
        after = await checkedAfter(r.after);
      } catch (error) {
        const e = refusal(error, `ai.quotaRules[${i}].after`);
        errors.push(kind ? { ...e, code: "unknown_model", value: r.after, allowed: await afterOptions() } : { path: e.path, code: "no_provider" });
        continue;
      }
    rows.push({ scope: r.scope, target: ruleTarget(r), exempt, limits: cleanLimits(exempt ? {} : r.limits, next.unit), after, afterLimits: after ? cleanLimits(r.afterLimits ?? {}, next.unit) : {} });
  }
  if (errors.length) return;
  const stored = await all<{ scope: string; target: string; exempt: number; limits: string; after_model: string | null; after_kind: string | null; after_limits: string | null }>("SELECT scope,target,exempt,limits,after_model,after_kind,after_limits FROM ai_quota_rules");
  const at = Date.now();
  for (const r of stored) {
    if (given && portable(r.scope, r.target)) await run("DELETE FROM ai_quota_rules WHERE scope=? AND target=?", r.scope, r.target);
    else if (unitChanged) await run("UPDATE ai_quota_rules SET limits='{}',after_limits=NULL,updated_at=? WHERE scope=? AND target=?", at, r.scope, r.target);
  }
  for (const r of rows) {
    // Nothing to say: no row (instance and default without numbers).
    if (!r.exempt && !hasLimit(r.limits) && (r.scope === "instance" || r.scope === "default")) continue;
    await run(
      "INSERT INTO ai_quota_rules(scope,target,exempt,limits,after_model,after_kind,after_limits,updated_at) VALUES(?,?,?,?,?,?,?,?)",
      r.scope,
      r.target,
      r.exempt ? 1 : 0,
      JSON.stringify(r.limits),
      r.after?.model ?? null,
      r.after?.kind ?? null,
      hasLimit(r.afterLimits) ? JSON.stringify(r.afterLimits) : null,
      at,
    );
  }
}
async function afterOptions() {
  const ai = await instanceAiSettings();
  return ai.provider ? await instanceModelOptions(ai.provider.kind) : [];
}
// One save of the import in a savepoint of its own: a refusal undoes only
// that save, so the check can go on and report the next ones.
async function step(fn: () => Promise<unknown>, path: string, errors: SettingsIssue[]) {
  try {
    await transaction(fn);
  } catch (error) {
    errors.push(refusal(error, path));
  }
}

// Thrown to roll the savepoint back after a check or an error.
class Rollback extends Error {}
const prefixed = (issues: FileIssue[]): SettingsIssue[] => issues.map((e) => ({ ...e, path: e.path ? `limits.${e.path}` : "limits" }));

// admin.settingsImport { file, dryRun }: the file as text or as an object.
export async function importSettingsFile(user: Identity, input: { file?: unknown; dryRun?: unknown }): Promise<SettingsImportResult> {
  requireAdmin(user);
  const dryRun = input.dryRun !== false;
  const errors: SettingsIssue[] = [];
  const notes: SettingsIssue[] = [];
  const changes: SettingsChange[] = [];
  const missing = new Set<SecretPath>();
  const done = (applied: boolean): SettingsImportResult => ({
    ok: !errors.length,
    dryRun,
    applied,
    errors: errors.slice(0, MAX_ERRORS),
    errorCount: errors.length,
    notes,
    changes: errors.length ? [] : changes,
    secrets: errors.length ? [] : SECRET_PATHS.filter((p) => missing.has(p)),
  });
  const parsed = parseFile(input.file, errors);
  if (!parsed) {
    if (!dryRun) throw new HttpError(400, "Die Datei enthält Fehler – nichts wurde geändert.");
    return done(false);
  }
  // Everything happens in a savepoint: rolled back after a check or an
  // error, kept when applied.
  try {
    await transaction(async () => {
      const before = await currentSections();
      if (parsed.instance) await applyInstance(user, parsed.instance, before.instance, errors, notes, missing, !dryRun);
      if (parsed.ai && !errors.length) await applyAi(user, parsed.ai, before.ai, errors);
      if (errors.length) throw new Rollback();
      const after = await currentSections();
      for (const section of ["instance", "ai"] as const) diff(section, section, before[section], after[section], changes);
      // Secrets the file has and this instance (now) lacks.
      if (parsed.secrets.get("ai.apiKey")?.set && !(after.ai.apiKey as SecretMarker).set) missing.add("ai.apiKey");
      // The limits file, against the AI settings just set.
      if (parsed.limits) {
        const check = await importLimitsFile(user, { file: parsed.limits, dryRun: true });
        errors.push(...prefixed(check.errors));
        notes.push(...prefixed(check.notes));
        if (errors.length) throw new Rollback();
        changes.push(...check.changes.map((change) => ({ section: "limits" as const, change })));
        if (!dryRun && check.changes.length) await importLimitsFile(user, { file: parsed.limits, dryRun: false });
      }
      if (dryRun || !changes.length) throw new Rollback();
      await audit(user.id, AUDIT_ACTION, "instance", JSON.stringify({ sections: (["instance", "ai", "limits"] as const).filter((s) => parsed[s]), changes: changes.length, paths: changes.map((c) => ("path" in c ? c.path : `limits.${c.change.area}`)).slice(0, 50) }).slice(0, 2000));
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
    if (!dryRun && errors.length) throw new HttpError(400, "Die Datei enthält Fehler – nichts wurde geändert.");
    return done(false);
  }
  return done(true);
}
