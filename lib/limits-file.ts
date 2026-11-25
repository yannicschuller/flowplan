// Export / import of the limits and AI settings as one JSON file
// (Administration → Grenzen & Aufbewahrung → Export / Import): so an
// administrator can set everything for the paid plans in one go.
//
// The file (version 1) is shared with flowplan-billing's catalogue file
// (its README "Catalogue file"): each side reads its own keys and ignores
// the other's. Here: per plan `group`, `kind`, `storageMb`, `uploadMb`,
// `workspaces`, `aiActions`, `aiModels`, `aiDefault`, `aiAfter`, `aiModel`, and the
// top-level `flowplan` object; Paddle's keys (prices, names, descriptions,
// order, highlight, …) and keys starting with "_" are ignored. Any other
// unknown key is an error, so a typo cannot pass silently.
//
//   { "version": 1,
//     "plans": [{ "group": "Flowplan Plus", "kind": "plan"|"team"|"addon",
//                 "storageMb": 25600, "uploadMb": 1024, "workspaces"?: 5,
//                 "aiTokens": 5000000 | "aiActions": 1000, "aiModels": "haiku"|"sonnet"|"all",
//                 "aiDefault"?: "smallest"|"largest" (with aiModels "all"),
//                 "aiAfter"?: "haiku"|"<model id>"|"off", "aiAfterTokens"?: 20000000,
//                 "aiModel"?: "<model id>" }],
//     "flowplan": { "defaults": { "storageMb", "uploadMb", "workspaces"? },
//                   "aiQuota": { "period"?, "unit"?, "tokensPerAction"?, "costPerAction"?,
//                                "defaultTokens"? | "defaultActions"?, "defaultAfter"?, "defaultAfterTokens"?,
//                                "instanceCapUsd"? | "instanceCap"? | "instanceCapTokens"? },
//                   "moreLimitsUrl"?, "removeMissing"?: false,
//                   "groups"?: [ same fields as a plan, for groups that are not plans;
//                                "workspaceGroup": { "workspace", "group" } for a workspace group ] } }
//
// Mapping, per plan (a directory group by name, `dir:<group>`):
// - the group's limits (group_limits, lib/user-limits.ts): storage – for an
//   add-on (kind "addon") as storage mode "add", else a limit –, the
//   largest upload (not for add-ons; 0 = not set by the group, above the
//   server's 10240 MB (10 GB) it is capped with a note) and own workspaces;
// - the AI quota rule of the group (ai_quota_rules, lib/ai/quota.ts):
//   aiActions per period (flowplan.aiQuota.period, default month),
//   converted into the quota's unit – tokensPerAction (default 5,000) or
//   costPerAction (default 0.02 in the instance's currency) – and "Danach"
//   from aiAfter ("off": AI stops; "haiku"/"sonnet"/"opus": the instance's
//   model of that family; else a model id the instance knows). aiTokens
//   (flowplan.aiQuota.defaultTokens for the default) sets the limit in
//   tokens per period directly, without a conversion – only with the unit
//   "tokens" (with the unit "cost" and no aiActions it is an error); given
//   with aiActions, aiTokens wins (a note in the check). flowplan-billing's
//   catalogue writes aiTokens; aiActions stays for older files.
//   aiAfterTokens (defaultAfterTokens): how many tokens per period may be
//   used with the model of aiAfter once the limit is used up (the rule's
//   after_limits; null: unlimited) – the unit "tokens" only. Add-ons get
//   no AI rule (and no model rule) unless aiActions or aiTokens > 0;
// - the model rule of the group (ai_model_rules, lib/ai/model-policy.ts):
//   aiModels "haiku"/"sonnet" → the instance's model of that family, "all"
//   → "up to" its most capable (Opus, else Sonnet, else Haiku, else the
//   priciest), your choice (#538: the rule's `choice` – members may pick
//   that one or the instance's smaller models, "Bis Opus – frei wählbar"),
//   or an explicit aiModel (exactly that one). aiDefault (only beside
//   aiModels "all"): the members' default until they pick a model –
//   "smallest" (the cheapest allowed) or "largest" (the most capable, the
//   rule's default_model NULL); left out, an existing "all" rule keeps its
//   default and a new one gets "largest". The export writes it only when it
//   is "smallest".
// A key left out leaves that setting as it is; null removes it. Nothing
// that is not in the file is removed, unless "removeMissing": true – then
// the limits, AI rules and model rules of directory groups not in the file
// go.
//
// Checking ("Prüfen", dryRun) validates the whole file (every error with
// its JSON path) and lists every change; it writes nothing. Applying does
// all changes in one transaction (all or nothing), audits each one and is
// idempotent: the same file again has no changes. The export writes the
// current settings in this format; what it cannot represent is listed
// under "_skipped". Administrators only (admin.limitsExport,
// admin.limitsImport); API tokens never (lib/api.ts refuses admin.*).
import { all, audit, one, run, transaction } from "./db";
import { HttpError } from "./auth";
import { requireAdmin } from "./permissions";
import type { Identity } from "./types";
import { instanceSettings, saveInstanceSettings } from "./instance-settings";
import { groupLimitRules, type GroupLimits } from "./user-limits";
import { directoryKey, directoryName, isDirectoryKey, MAX_DIRECTORY_NAME } from "./group-keys";
import { instanceAiSettings, type AiPrice } from "./ai/settings";
import { cleanLimits, instanceModelOptions, quotaRules, quotaSettings } from "./ai/quota";
import { allModel, familyModel, MODEL_FAMILIES, MODEL_NAME, modelRules, type ModelFamily } from "./ai/model-policy";
import { MODEL_DEFAULTS, QUOTA_PERIODS, type ModelDefault, type QuotaLimits, type QuotaPeriod, type QuotaUnit } from "./ai/quota-shared";
import { MAX_UPLOAD_MB } from "./upload-limit";

export const LIMITS_FILE_VERSION = 1;
export const MAX_LIMITS_FILE_CHARS = 512 * 1024;
const MAX_PLANS = 500;
const MAX_ERRORS = 200;
// The largest single upload this server takes (instance-settings.ts).
export { MAX_UPLOAD_MB };
export const DEFAULT_TOKENS_PER_ACTION = 5000;
export const DEFAULT_COST_PER_ACTION = 0.02;
// The largest aiTokens / defaultTokens (the quota's own limit, lib/ai/quota.ts).
export const MAX_AI_TOKENS = 1_000_000_000_000;
// Where the conversion of the last import is kept, for the export.
const STATE_KEY = "limitsFile";
// The families and their models live in lib/ai/model-policy.ts (#538).
export { allModel, familyModel, MODEL_FAMILIES };
type Family = ModelFamily;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

// ---- What the file says ----

// A problem with a place in the file. `allowed`: the values that would be
// accepted (models, units); `max`: the limit a value was capped at.
export type FileIssue = { path: string; code: string; allowed?: string[]; max?: number; value?: string };

// The payment provider's keys of a plan (flowplan-billing: "creem", older
// files "paddle") and the top level: ignored here.
const BILLING_PLAN_KEYS = ["status", "creem", "paddle", "prices", "name_de", "name_en", "description_de", "description_en", "prioritySupport", "order", "highlight", "studentDiscount", "minSeats", "taxCategory"];
const PLAN_KEYS = new Set(["group", "kind", "storageMb", "uploadMb", "workspaces", "aiActions", "aiTokens", "aiModels", "aiDefault", "aiAfter", "aiAfterTokens", "aiModel", ...BILLING_PLAN_KEYS]);
const GROUP_KEYS = new Set(["group", "workspaceGroup", "kind", "storageMb", "uploadMb", "workspaces", "aiActions", "aiTokens", "aiModels", "aiDefault", "aiAfter", "aiAfterTokens", "aiModel"]);
const TOP_KEYS = new Set(["version", "plans", "flowplan", "archiveMissing"]);
const FLOWPLAN_KEYS = new Set(["defaults", "aiQuota", "moreLimitsUrl", "groups", "removeMissing"]);
const DEFAULTS_KEYS = new Set(["storageMb", "uploadMb", "workspaces"]);
const AI_KEYS = new Set(["period", "unit", "tokensPerAction", "costPerAction", "defaultActions", "defaultTokens", "defaultAfter", "defaultAfterTokens", "instanceCapUsd", "instanceCap", "instanceCapTokens"]);
const KINDS = ["plan", "team", "addon"] as const;
type Kind = (typeof KINDS)[number];

// A model choice as written: off, a family or a model id.
type ModelChoice = { off: true } | { family: Family } | { model: string };
type DesiredGroup = {
  path: string;
  target: string;
  name: string;
  kind: Kind;
  // Each: absent = unchanged; null = removed.
  storageMb?: number | null;
  uploadMb?: number | null;
  workspaces?: number | null;
  aiActions?: number | null;
  // Tokens per period, without a conversion (unit "tokens" only).
  aiTokens?: number | null;
  aiAfter?: ModelChoice;
  // Tokens per period for the model after the quota (null: unlimited).
  aiAfterTokens?: number | null;
  aiModels?: "haiku" | "sonnet" | "all";
  // With aiModels "all": the default of the choice.
  aiDefault?: ModelDefault;
  aiModel?: string | null;
};
type DesiredAi = {
  period?: QuotaPeriod;
  unit?: QuotaUnit;
  tokensPerAction?: number;
  costPerAction?: number;
  defaultActions?: number | null;
  defaultTokens?: number | null;
  defaultAfter?: ModelChoice;
  defaultAfterTokens?: number | null;
  instanceCap?: { value: number | null; path: string; key: "instanceCapUsd" | "instanceCap" | "instanceCapTokens" };
};
type Desired = {
  groups: DesiredGroup[];
  defaults: { storageMb?: number | null; uploadMb?: number; workspaces?: number | null };
  moreLimitsUrl?: string;
  ai: DesiredAi;
  removeMissing: boolean;
};

const has = (o: Obj, k: string) => Object.hasOwn(o, k);
function unknownKeys(value: Obj, allowed: Set<string>, prefix: string, errors: FileIssue[]) {
  for (const k of Object.keys(value)) if (!allowed.has(k) && !k.startsWith("_")) errors.push({ path: `${prefix}${k}`, code: "unknown_field" });
}
// A whole number in a range; null when allowed; undefined when absent.
function count(o: Obj, key: string, path: string, errors: FileIssue[], max: number, nullable = true): number | null | undefined {
  if (!has(o, key)) return undefined;
  const v = o[key];
  if (v === null) {
    if (nullable) return null;
    errors.push({ path, code: "required" });
    return undefined;
  }
  if (typeof v !== "number" || !Number.isInteger(v)) {
    errors.push({ path, code: "invalid" });
    return undefined;
  }
  if (v < 0 || v > max) {
    errors.push({ path, code: "out_of_range", max });
    return undefined;
  }
  return v;
}
function modelChoice(v: unknown, path: string, errors: FileIssue[]): ModelChoice | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "off") return { off: true };
  if (typeof v !== "string" || !v.trim() || v.length > 200 || !MODEL_NAME.test(v.trim())) {
    errors.push({ path, code: "invalid" });
    return undefined;
  }
  const s = v.trim();
  return (MODEL_FAMILIES as readonly string[]).includes(s.toLowerCase()) ? { family: s.toLowerCase() as Family } : { model: s };
}

// A plan or an entry of flowplan.groups. `notes`: values that were capped.
async function parseGroup(raw: unknown, path: string, plan: boolean, errors: FileIssue[], notes: FileIssue[]): Promise<DesiredGroup | null> {
  if (!isObj(raw)) {
    errors.push({ path, code: "invalid" });
    return null;
  }
  const before = errors.length;
  unknownKeys(raw, plan ? PLAN_KEYS : GROUP_KEYS, `${path}.`, errors);
  let kind: Kind = "plan";
  if (plan || has(raw, "kind")) {
    if (!(KINDS as readonly string[]).includes(raw.kind as string)) errors.push({ path: `${path}.kind`, code: plan && !has(raw, "kind") ? "required" : "invalid", allowed: [...KINDS] });
    else kind = raw.kind as Kind;
  }
  // The group: a directory group by name, or (flowplan.groups only) a
  // workspace group by its workspace's and its own name.
  let target = "",
    name = "";
  if (!plan && has(raw, "workspaceGroup")) {
    const wg = raw.workspaceGroup;
    if (has(raw, "group")) errors.push({ path: `${path}.group`, code: "unknown_field" });
    if (!isObj(wg) || typeof wg.workspace !== "string" || typeof wg.group !== "string" || !wg.workspace.trim() || !wg.group.trim()) errors.push({ path: `${path}.workspaceGroup`, code: "invalid" });
    else {
      unknownKeys(wg, new Set(["workspace", "group"]), `${path}.workspaceGroup.`, errors);
      const found = await all<{ id: string }>("SELECT g.id FROM groups g JOIN workspaces w ON w.id=g.workspace_id WHERE w.name=? AND g.name=? LIMIT 2", wg.workspace.trim(), wg.group.trim());
      if (!found.length) errors.push({ path: `${path}.workspaceGroup`, code: "not_found" });
      else if (found.length > 1) errors.push({ path: `${path}.workspaceGroup`, code: "ambiguous" });
      else {
        target = found[0].id;
        name = `${wg.workspace.trim()} · ${wg.group.trim()}`;
      }
    }
  } else {
    const g = typeof raw.group === "string" ? raw.group.trim().replace(/\s+/g, " ") : "";
    if (!has(raw, "group") || raw.group === null) errors.push({ path: `${path}.group`, code: "required" });
    else if (!g || g.length > MAX_DIRECTORY_NAME) errors.push({ path: `${path}.group`, code: "invalid" });
    else {
      target = directoryKey(g);
      name = g;
    }
  }
  const out: DesiredGroup = { path, target, name, kind };
  const storage = count(raw, "storageMb", `${path}.storageMb`, errors, 10_000_000);
  // An add-on of 0 adds nothing: the group sets no storage.
  if (storage !== undefined) out.storageMb = kind === "addon" && storage === 0 ? null : storage;
  // Add-ons have no upload of their own (the key is ignored, a value goes).
  const upload = count(raw, "uploadMb", `${path}.uploadMb`, errors, 100_000_000);
  if (kind === "addon") {
    if (upload !== undefined) out.uploadMb = null;
  } else if (upload !== undefined) {
    if (upload === 0 || upload === null) out.uploadMb = null;
    else if (upload > MAX_UPLOAD_MB) {
      notes.push({ path: `${path}.uploadMb`, code: "capped", max: MAX_UPLOAD_MB });
      out.uploadMb = MAX_UPLOAD_MB;
    } else out.uploadMb = upload;
  }
  const workspaces = count(raw, "workspaces", `${path}.workspaces`, errors, 10_000);
  if (workspaces !== undefined) out.workspaces = workspaces;
  const actions = count(raw, "aiActions", `${path}.aiActions`, errors, 10_000_000);
  const tokens = count(raw, "aiTokens", `${path}.aiTokens`, errors, MAX_AI_TOKENS);
  // Add-ons: no AI rule unless they bring actions or tokens.
  const ai = kind !== "addon" || (typeof actions === "number" && actions > 0) || (typeof tokens === "number" && tokens > 0);
  if (ai) {
    if (actions !== undefined) out.aiActions = actions;
    if (tokens !== undefined) out.aiTokens = tokens;
    const after = modelChoice(raw.aiAfter, `${path}.aiAfter`, errors);
    if (after) out.aiAfter = after;
    const afterTokens = count(raw, "aiAfterTokens", `${path}.aiAfterTokens`, errors, MAX_AI_TOKENS);
    if (afterTokens !== undefined) out.aiAfterTokens = afterTokens;
    if (has(raw, "aiModels")) {
      if (raw.aiModels === "haiku" || raw.aiModels === "sonnet" || raw.aiModels === "all") out.aiModels = raw.aiModels;
      else errors.push({ path: `${path}.aiModels`, code: "invalid", allowed: ["haiku", "sonnet", "all"] });
    }
    if (has(raw, "aiDefault")) {
      if (!(MODEL_DEFAULTS as readonly unknown[]).includes(raw.aiDefault)) errors.push({ path: `${path}.aiDefault`, code: "invalid", allowed: [...MODEL_DEFAULTS] });
      else if (raw.aiModels !== "all" || has(raw, "aiModel")) errors.push({ path: `${path}.aiDefault`, code: "needs_choice" });
      else out.aiDefault = raw.aiDefault as ModelDefault;
    }
    if (has(raw, "aiModel")) {
      const m = raw.aiModel;
      if (m === null) out.aiModel = null;
      else if (typeof m !== "string" || !m.trim() || m.length > 200 || !MODEL_NAME.test(m.trim())) errors.push({ path: `${path}.aiModel`, code: "invalid" });
      else out.aiModel = m.trim();
    }
  }
  return errors.length > before ? null : out;
}

async function parseFile(file: unknown, errors: FileIssue[], notes: FileIssue[]): Promise<Desired | null> {
  let raw = file;
  if (typeof raw === "string") {
    if (raw.length > MAX_LIMITS_FILE_CHARS) {
      errors.push({ path: "", code: "too_large" });
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
  unknownKeys(raw, TOP_KEYS, "", errors);
  if (raw.version !== LIMITS_FILE_VERSION) errors.push({ path: "version", code: has(raw, "version") ? "unsupported" : "required" });
  const desired: Desired = { groups: [], defaults: {}, ai: {}, removeMissing: false };
  if (has(raw, "plans") && !Array.isArray(raw.plans)) errors.push({ path: "plans", code: "invalid" });
  const plans = Array.isArray(raw.plans) ? raw.plans : [];
  if (plans.length > MAX_PLANS) errors.push({ path: "plans", code: "too_many", max: MAX_PLANS });
  for (const [i, p] of plans.slice(0, MAX_PLANS).entries()) {
    const g = await parseGroup(p, `plans[${i}]`, true, errors, notes);
    if (g) desired.groups.push(g);
  }
  if (has(raw, "flowplan") && !isObj(raw.flowplan)) errors.push({ path: "flowplan", code: "invalid" });
  const fp = isObj(raw.flowplan) ? raw.flowplan : {};
  unknownKeys(fp, FLOWPLAN_KEYS, "flowplan.", errors);
  if (has(fp, "removeMissing")) {
    if (typeof fp.removeMissing !== "boolean") errors.push({ path: "flowplan.removeMissing", code: "invalid" });
    else desired.removeMissing = fp.removeMissing;
  }
  if (has(fp, "groups") && !Array.isArray(fp.groups)) errors.push({ path: "flowplan.groups", code: "invalid" });
  const extra = Array.isArray(fp.groups) ? fp.groups : [];
  if (extra.length > MAX_PLANS) errors.push({ path: "flowplan.groups", code: "too_many", max: MAX_PLANS });
  for (const [i, p] of extra.slice(0, MAX_PLANS).entries()) {
    const g = await parseGroup(p, `flowplan.groups[${i}]`, false, errors, notes);
    if (g) desired.groups.push(g);
  }
  // A group once (directory names compared exactly, as the SSO mappings do).
  const seen = new Set<string>();
  for (const g of desired.groups) {
    if (seen.has(g.target)) errors.push({ path: `${g.path}.${g.target.startsWith("dir:") ? "group" : "workspaceGroup"}`, code: "duplicate" });
    seen.add(g.target);
  }
  // The instance's defaults.
  if (has(fp, "defaults") && !isObj(fp.defaults)) errors.push({ path: "flowplan.defaults", code: "invalid" });
  const d = isObj(fp.defaults) ? fp.defaults : {};
  unknownKeys(d, DEFAULTS_KEYS, "flowplan.defaults.", errors);
  const storage = count(d, "storageMb", "flowplan.defaults.storageMb", errors, 10_000_000);
  if (storage !== undefined) desired.defaults.storageMb = storage;
  const upload = count(d, "uploadMb", "flowplan.defaults.uploadMb", errors, 100_000_000, false);
  if (upload !== undefined && upload !== null) {
    if (upload < 1) errors.push({ path: "flowplan.defaults.uploadMb", code: "out_of_range", max: MAX_UPLOAD_MB });
    else if (upload > MAX_UPLOAD_MB) {
      notes.push({ path: "flowplan.defaults.uploadMb", code: "capped", max: MAX_UPLOAD_MB });
      desired.defaults.uploadMb = MAX_UPLOAD_MB;
    } else desired.defaults.uploadMb = upload;
  }
  const workspaces = count(d, "workspaces", "flowplan.defaults.workspaces", errors, 10_000);
  if (workspaces !== undefined) desired.defaults.workspaces = workspaces;
  if (has(fp, "moreLimitsUrl")) {
    const u = fp.moreLimitsUrl === null ? "" : fp.moreLimitsUrl;
    if (typeof u !== "string" || u.trim().length > 500 || (u.trim() !== "" && !(/^https?:\/\/\S+$/i.test(u.trim()) && URL.canParse(u.trim())))) errors.push({ path: "flowplan.moreLimitsUrl", code: "invalid_url" });
    else desired.moreLimitsUrl = u.trim();
  }
  // The AI quota.
  if (has(fp, "aiQuota") && !isObj(fp.aiQuota)) errors.push({ path: "flowplan.aiQuota", code: "invalid" });
  const a = isObj(fp.aiQuota) ? fp.aiQuota : {};
  unknownKeys(a, AI_KEYS, "flowplan.aiQuota.", errors);
  if (has(a, "period")) {
    if ((QUOTA_PERIODS as readonly string[]).includes(a.period as string)) desired.ai.period = a.period as QuotaPeriod;
    else errors.push({ path: "flowplan.aiQuota.period", code: "invalid", allowed: [...QUOTA_PERIODS] });
  }
  if (has(a, "unit")) {
    if (a.unit === "tokens" || a.unit === "cost") desired.ai.unit = a.unit;
    else errors.push({ path: "flowplan.aiQuota.unit", code: "invalid", allowed: ["tokens", "cost"] });
  }
  if (has(a, "tokensPerAction")) {
    const v = a.tokensPerAction;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 10_000_000) errors.push({ path: "flowplan.aiQuota.tokensPerAction", code: "out_of_range", max: 10_000_000 });
    else desired.ai.tokensPerAction = v;
  }
  if (has(a, "costPerAction")) {
    const v = a.costPerAction;
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > 1000) errors.push({ path: "flowplan.aiQuota.costPerAction", code: "out_of_range", max: 1000 });
    else desired.ai.costPerAction = v;
  }
  const defaultActions = count(a, "defaultActions", "flowplan.aiQuota.defaultActions", errors, 10_000_000);
  if (defaultActions !== undefined) desired.ai.defaultActions = defaultActions;
  const defaultTokens = count(a, "defaultTokens", "flowplan.aiQuota.defaultTokens", errors, MAX_AI_TOKENS);
  if (defaultTokens !== undefined) desired.ai.defaultTokens = defaultTokens;
  const defaultAfter = modelChoice(a.defaultAfter, "flowplan.aiQuota.defaultAfter", errors);
  if (defaultAfter) desired.ai.defaultAfter = defaultAfter;
  const defaultAfterTokens = count(a, "defaultAfterTokens", "flowplan.aiQuota.defaultAfterTokens", errors, MAX_AI_TOKENS);
  if (defaultAfterTokens !== undefined) desired.ai.defaultAfterTokens = defaultAfterTokens;
  const caps = (["instanceCapUsd", "instanceCap", "instanceCapTokens"] as const).filter((k) => has(a, k));
  if (caps.length > 1) for (const k of caps.slice(1)) errors.push({ path: `flowplan.aiQuota.${k}`, code: "duplicate" });
  if (caps.length) {
    const key = caps[0];
    const v = a[key];
    const path = `flowplan.aiQuota.${key}`;
    if (v === null) desired.ai.instanceCap = { value: null, path, key };
    else if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1e12) errors.push({ path, code: "invalid" });
    else desired.ai.instanceCap = { value: v, path, key };
  }
  return errors.length ? null : desired;
}

// ---- The current state ----

type QuotaState = { limits: QuotaLimits; exempt: boolean; after: string | null; afterKind: string | null; afterLimits?: QuotaLimits | null };
type State = {
  settings: { defaultUserStorageMb: number | null; maxUploadMb: number; defaultUserWorkspaces: number | null; moreLimitsUrl: string };
  limits: Map<string, GroupLimits>;
  quota: Map<string, QuotaState>; // "scope|target"
  models: Map<string, { model: string; kind: string; choice: boolean; smallest: boolean }>; // group targets
  unit: QuotaUnit;
  currency: string;
  prices: AiPrice[];
  provider: { kind: string; model: string } | null;
  options: string[];
  conversion: { period: QuotaPeriod; tokensPerAction: number; costPerAction: number };
  names: Map<string, string>;
};
async function storedConversion() {
  const out = { period: "month" as QuotaPeriod, tokensPerAction: DEFAULT_TOKENS_PER_ACTION, costPerAction: DEFAULT_COST_PER_ACTION };
  try {
    const row = await one<{ value: string }>("SELECT value FROM instance_settings WHERE key=?", STATE_KEY);
    const v = row ? (JSON.parse(row.value) as Obj) : {};
    if ((QUOTA_PERIODS as readonly string[]).includes(v.period as string)) out.period = v.period as QuotaPeriod;
    if (typeof v.tokensPerAction === "number" && v.tokensPerAction >= 1) out.tokensPerAction = v.tokensPerAction;
    if (typeof v.costPerAction === "number" && v.costPerAction > 0) out.costPerAction = v.costPerAction;
  } catch {}
  return out;
}
async function currentState(): Promise<State> {
  const s = await instanceSettings();
  const q = await quotaSettings();
  const ai = await instanceAiSettings();
  const provider = ai.provider?.model.trim() ? { kind: ai.provider.kind, model: ai.provider.model.trim() } : null;
  const quota = new Map<string, QuotaState>();
  for (const r of await quotaRules(q.unit)) quota.set(`${r.scope}|${r.target}`, { limits: r.limits, exempt: r.exempt, after: r.after ?? null, afterKind: r.afterKind ?? null, afterLimits: r.afterLimits ?? null });
  const models = new Map<string, { model: string; kind: string; choice: boolean; smallest: boolean }>();
  for (const r of await modelRules()) if (r.scope === "group") models.set(r.target, { model: r.model, kind: r.kind, choice: !!r.choice, smallest: r.defaultModel === "smallest" });
  const names = new Map<string, string>();
  for (const g of await all<{ id: string; name: string; workspace: string | null }>("SELECT g.id,g.name,w.name workspace FROM groups g LEFT JOIN workspaces w ON w.id=g.workspace_id")) names.set(g.id, `${g.workspace ?? "–"} · ${g.name}`);
  return {
    settings: { defaultUserStorageMb: s.defaultUserStorageMb ?? null, maxUploadMb: s.maxUploadMb, defaultUserWorkspaces: s.defaultUserWorkspaces ?? null, moreLimitsUrl: s.moreLimitsUrl },
    limits: new Map((await groupLimitRules()).map((r) => [r.target, r.limits])),
    quota,
    models,
    unit: q.unit,
    currency: ai.currency,
    prices: ai.prices,
    provider,
    options: provider ? await instanceModelOptions(provider.kind) : [],
    conversion: await storedConversion(),
    names,
  };
}
const nameOf = (state: State, target: string) => (isDirectoryKey(target) ? directoryName(target) : (state.names.get(target) ?? target));

// ---- Comparing ----

// One change in plain data; the administration words it (components/
// settings/admin/limits-file.tsx). before/after null: not there.
// afterLimit: the continuation's limit in the period (null: unlimited).
export type QuotaSide = { actions: number | null; limit: number | null; period: QuotaPeriod; exempt: boolean; after: string | null; afterLimit?: number | null; otherPeriods: boolean };
export type LimitsChange =
  | { area: "setting"; field: "defaultUserStorageMb" | "maxUploadMb" | "defaultUserWorkspaces" | "moreLimitsUrl" | "unit"; before: number | string | null; after: number | string | null }
  | { area: "limits"; target: string; name: string; field: "storageMb" | "uploadMb" | "workspaces" | "storageMode"; before: number | string | null; after: number | string | null }
  | { area: "limitsRemoved"; target: string; name: string }
  | { area: "quota"; scope: "group" | "default" | "instance" | "role" | "user"; target: string; name: string; before: QuotaSide | null; after: QuotaSide | null; unit: QuotaUnit; currency: string }
  | { area: "model"; target: string; name: string; before: string | null; after: string | null; beforeChoice?: boolean; afterChoice?: boolean; beforeSmallest?: boolean; afterSmallest?: boolean };

type Plan = {
  changes: LimitsChange[];
  writes: {
    settings: Record<string, unknown>;
    unit: QuotaUnit | null;
    limits: { target: string; limits: GroupLimits | null }[];
    quota: { scope: string; target: string; rule: { limits: QuotaLimits; exempt: boolean; after: string | null; afterKind: string | null; afterLimits?: QuotaLimits | null } | null }[];
    models: { target: string; model: string | null; kind: string; choice?: boolean; smallest?: boolean }[];
    conversion: { period: QuotaPeriod; tokensPerAction: number; costPerAction: number };
  };
};

const sameLimits = (a: QuotaLimits, b: QuotaLimits) => QUOTA_PERIODS.every((p) => (a[p] ?? null) === (b[p] ?? null));
// `direct`: the file gives tokens (aiTokens), so no actions are shown.
function side(rule: QuotaState | null, period: QuotaPeriod, factor: number, unit: QuotaUnit, direct = false): QuotaSide | null {
  if (!rule) return null;
  const limit = typeof rule.limits[period] === "number" ? (rule.limits[period] as number) : null;
  const actions = limit === null || (direct && unit === "tokens") ? null : unit === "tokens" ? Math.round(limit / factor) : Math.round((limit / factor) * 100) / 100;
  const afterLimit = rule.after && typeof rule.afterLimits?.[period] === "number" ? (rule.afterLimits[period] as number) : null;
  return { actions, limit, period, exempt: rule.exempt, after: rule.after, ...(afterLimit !== null ? { afterLimit } : {}), otherPeriods: QUOTA_PERIODS.some((p) => p !== period && typeof rule.limits[p] === "number") };
}

async function plan(desired: Desired, state: State, errors: FileIssue[], notes: FileIssue[] = []): Promise<Plan> {
  const changes: LimitsChange[] = [];
  const conversion = {
    period: desired.ai.period ?? state.conversion.period,
    tokensPerAction: desired.ai.tokensPerAction ?? state.conversion.tokensPerAction,
    costPerAction: desired.ai.costPerAction ?? state.conversion.costPerAction,
  };
  const writes: Plan["writes"] = { settings: {}, unit: null, limits: [], quota: [], models: [], conversion };
  const unit = desired.ai.unit ?? state.unit;
  const factor = unit === "tokens" ? conversion.tokensPerAction : conversion.costPerAction;
  // Actions as they were counted before (for the "before" of a change).
  const stateFactor = state.unit === "tokens" ? state.conversion.tokensPerAction : state.conversion.costPerAction;
  const toLimit = (actions: number) => (unit === "tokens" ? Math.round(actions * factor) : Math.round(actions * factor * 100) / 100);
  const needsProvider = (path: string) => {
    if (state.provider) return true;
    errors.push({ path, code: "no_provider" });
    return false;
  };
  // Models the file sets as model rules count as known for "Danach".
  const options = [...new Set([...state.options, ...desired.groups.flatMap((g) => (typeof g.aiModel === "string" ? [g.aiModel] : []))])].sort((a, b) => a.localeCompare(b));
  const resolve = (choice: ModelChoice, path: string): string | null | undefined => {
    if ("off" in choice) return null;
    if (!needsProvider(path)) return undefined;
    if ("family" in choice) {
      const m = familyModel(choice.family, options, state.prices);
      if (!m) errors.push({ path, code: "no_family_model", value: choice.family, allowed: options });
      return m ?? undefined;
    }
    if (!options.includes(choice.model)) {
      errors.push({ path, code: "unknown_model", value: choice.model, allowed: options });
      return undefined;
    }
    return choice.model;
  };

  // The unit: cost needs prices; another unit empties the numbers of the
  // rules the file does not set (as Administration → KI → Kontingente).
  if (unit === "cost" && !state.prices.length) errors.push({ path: desired.ai.unit ? "flowplan.aiQuota.unit" : "flowplan.aiQuota", code: "no_prices" });
  const cap = desired.ai.instanceCap;
  if (cap && cap.value !== null) {
    if (cap.key === "instanceCapTokens" && unit !== "tokens") errors.push({ path: cap.path, code: "unit_mismatch", allowed: ["instanceCapUsd", "instanceCap"], value: unit });
    if (cap.key !== "instanceCapTokens" && unit !== "cost") errors.push({ path: cap.path, code: "unit_mismatch", allowed: ["instanceCapTokens"], value: unit });
    if (cap.key === "instanceCapUsd" && state.currency !== "USD") errors.push({ path: cap.path, code: "currency_mismatch", allowed: ["instanceCap"], value: state.currency });
  }
  if (unit !== state.unit) {
    changes.push({ area: "setting", field: "unit", before: state.unit, after: unit });
    writes.unit = unit;
  }

  // The instance's defaults.
  const setting = (field: "defaultUserStorageMb" | "maxUploadMb" | "defaultUserWorkspaces" | "moreLimitsUrl", value: number | string | null | undefined) => {
    if (value === undefined) return;
    const before = state.settings[field];
    // An empty default and 0 both mean unlimited.
    const norm = (v: number | string | null) => (field !== "maxUploadMb" && field !== "moreLimitsUrl" && (v === null || v === 0) ? 0 : v);
    if (norm(before) === norm(value)) return;
    changes.push({ area: "setting", field, before, after: value });
    writes.settings[field] = value;
  };
  setting("defaultUserStorageMb", desired.defaults.storageMb);
  setting("maxUploadMb", desired.defaults.uploadMb);
  setting("defaultUserWorkspaces", desired.defaults.workspaces);
  setting("moreLimitsUrl", desired.moreLimitsUrl);

  // A quota rule as it should be; undefined: leave it.
  const sameAfterLimits = (a: QuotaLimits | null | undefined, b: QuotaLimits | null | undefined) => sameLimits(a ?? {}, b ?? {});
  const quotaRule = (scope: "group" | "default" | "instance", target: string, name: string, actionsOrLimit: number | null | undefined, after: ModelChoice | undefined, afterPath: string, isLimit = false, direct = false, afterTokens?: { value: number | null | undefined; path: string }) => {
    const key = `${scope}|${target}`;
    const current = state.quota.get(key) ?? null;
    // After a unit change, the stored numbers mean nothing.
    const now = current && unit !== state.unit ? { ...current, limits: {} } : current;
    let afterModel: string | null | undefined = undefined;
    if (after && scope !== "instance") afterModel = resolve(after, afterPath);
    // The continuation's limit: tokens only.
    let afterLimitValue = afterTokens?.value;
    if (afterLimitValue !== undefined && afterLimitValue !== null && unit !== "tokens") {
      errors.push({ path: afterTokens!.path, code: "tokens_need_unit", value: unit, allowed: ["tokens"] });
      afterLimitValue = undefined;
    }
    if (actionsOrLimit === undefined && afterModel === undefined && afterLimitValue === undefined) return;
    // "Danach" alone does not create a rule: a rule without limits would
    // mean no limit for the group.
    if (actionsOrLimit === undefined && !current) return;
    if (actionsOrLimit === null) {
      if (current) {
        changes.push({ area: "quota", scope, target, name, before: side(current, conversion.period, stateFactor, state.unit, direct), after: null, unit, currency: state.currency });
        writes.quota.push({ scope, target, rule: null });
      }
      return;
    }
    const limits: QuotaLimits = actionsOrLimit === undefined ? (now?.limits ?? {}) : cleanLimits({ [conversion.period]: isLimit ? actionsOrLimit : toLimit(actionsOrLimit) }, unit);
    const nextAfter = afterModel !== undefined ? afterModel : (now?.after ?? null);
    const nextKind = afterModel !== undefined ? (afterModel ? state.provider!.kind : null) : (now?.afterKind ?? null);
    // Kept unless the file says; gone without a model to go on with.
    const nextAfterLimits = !nextAfter ? null : afterLimitValue !== undefined ? (afterLimitValue === null ? null : { [conversion.period]: afterLimitValue }) : unit === state.unit ? (now?.afterLimits ?? null) : null;
    const next = { limits, exempt: actionsOrLimit === undefined ? !!now?.exempt : false, after: nextAfter, afterKind: nextKind, afterLimits: nextAfterLimits };
    if (now && current && sameLimits(now.limits, next.limits) && now.exempt === next.exempt && now.after === next.after && (now.after === null || now.afterKind === next.afterKind) && (now.after === null || sameAfterLimits(now.afterLimits, next.afterLimits)) && unit === state.unit) return;
    changes.push({
      area: "quota",
      scope,
      target,
      name,
      before: side(current, conversion.period, stateFactor, state.unit, direct),
      after: side(next, conversion.period, factor, unit, direct),
      unit,
      currency: state.currency,
    });
    writes.quota.push({ scope, target, rule: next });
  };
  // aiTokens (or defaultTokens) and aiActions to the amount of a rule:
  // tokens directly with the unit "tokens" (and they win over actions,
  // with a note); with the unit "cost" tokens alone are an error, and next
  // to actions they are left out (a note). null removes, in any unit.
  const amount = (actions: number | null | undefined, tokens: number | null | undefined, path: string, actionsKey: string, tokensKey: string) => {
    if (tokens === undefined) return { value: actions, isLimit: false, direct: false };
    if (tokens === null) return { value: actions === undefined ? null : actions, isLimit: false, direct: actions === undefined };
    if (unit === "tokens") {
      if (actions !== undefined) notes.push({ path: `${path}.${actionsKey}`, code: "tokens_win", value: tokensKey });
      return { value: tokens, isLimit: true, direct: true };
    }
    if (actions === undefined) {
      errors.push({ path: `${path}.${tokensKey}`, code: "tokens_need_unit", value: unit, allowed: ["tokens"] });
      return { value: undefined, isLimit: false, direct: false };
    }
    notes.push({ path: `${path}.${tokensKey}`, code: "tokens_ignored", value: unit });
    return { value: actions, isLimit: false, direct: false };
  };
  const defaults = amount(desired.ai.defaultActions, desired.ai.defaultTokens, "flowplan.aiQuota", "defaultActions", "defaultTokens");
  quotaRule("default", "", "", defaults.value, desired.ai.defaultAfter, "flowplan.aiQuota.defaultAfter", defaults.isLimit, defaults.direct, { value: desired.ai.defaultAfterTokens, path: "flowplan.aiQuota.defaultAfterTokens" });
  if (cap) quotaRule("instance", "", "", cap.value, undefined, cap.path, true);

  // The groups.
  const inFile = new Set<string>();
  for (const g of desired.groups) {
    inFile.add(g.target);
    // Limits: the stored row with the file's values.
    const current = state.limits.get(g.target) ?? null;
    const touched = g.storageMb !== undefined || g.uploadMb !== undefined || g.workspaces !== undefined;
    if (touched) {
      const next: GroupLimits = { ...(current ?? {}) };
      for (const field of ["storageMb", "uploadMb", "workspaces"] as const) {
        const v = g[field];
        if (v === null) delete next[field];
        else if (v !== undefined) next[field] = v;
      }
      if (g.kind === "addon") next.storageMode = "add";
      else delete next.storageMode;
      // No row yet and nothing to set: none is created.
      const empty = !(["storageMb", "uploadMb", "workspaces"] as const).some((k) => typeof next[k] === "number");
      if ((current || !empty) && JSON.stringify(normLimits(current ?? {})) !== JSON.stringify(normLimits(next))) {
        for (const field of ["storageMb", "uploadMb", "workspaces", "storageMode"] as const) {
          const before = current?.[field] ?? null;
          const after = next[field] ?? null;
          if (before !== after) changes.push({ area: "limits", target: g.target, name: g.name, field, before, after });
        }
        writes.limits.push({ target: g.target, limits: next });
      }
    }
    const ai = amount(g.aiActions, g.aiTokens, g.path, "aiActions", "aiTokens");
    quotaRule("group", g.target, g.name, ai.value, g.aiAfter, `${g.path}.aiAfter`, ai.isLimit, ai.direct, { value: g.aiAfterTokens, path: `${g.path}.aiAfterTokens` });
    // The model rule.
    let model: string | null | undefined = undefined;
    // "all": up to the most capable, the person's choice (#538).
    let choice = false;
    if (g.aiModel !== undefined) {
      if (g.aiModel === null) model = null;
      else if (needsProvider(`${g.path}.aiModel`)) model = g.aiModel;
    } else if (g.aiModels) {
      const path = `${g.path}.aiModels`;
      if (needsProvider(path)) {
        const m = g.aiModels === "all" ? allModel(options, state.prices) : familyModel(g.aiModels, options, state.prices);
        if (!m) errors.push({ path, code: "no_family_model", value: g.aiModels, allowed: options });
        else {
          model = m;
          choice = g.aiModels === "all";
        }
      }
    }
    if (model !== undefined) {
      const cur = state.models.get(g.target) ?? null;
      const active = cur && state.provider && cur.kind === state.provider.kind ? cur.model : null;
      // The default of the choice: from the file, else as the rule has it
      // (a new rule, or one without the choice: the most capable).
      const smallest = model !== null && choice && (g.aiDefault ? g.aiDefault === "smallest" : !!cur?.choice && cur.smallest);
      const curSmallest = !!cur?.choice && cur.smallest;
      if (model === null ? cur !== null : !(active === model && cur!.choice === choice && curSmallest === smallest)) {
        changes.push({
          area: "model",
          target: g.target,
          name: g.name,
          before: cur ? cur.model : null,
          after: model,
          ...(cur?.choice ? { beforeChoice: true } : {}),
          ...(model !== null && choice ? { afterChoice: true } : {}),
          ...(curSmallest ? { beforeSmallest: true } : {}),
          ...(smallest ? { afterSmallest: true } : {}),
        });
        writes.models.push({ target: g.target, model, kind: state.provider?.kind ?? "", choice: model !== null && choice, smallest });
      }
    }
  }
  // With "removeMissing": directory groups that are not in the file.
  if (desired.removeMissing) {
    for (const target of state.limits.keys())
      if (isDirectoryKey(target) && !inFile.has(target)) {
        changes.push({ area: "limitsRemoved", target, name: nameOf(state, target) });
        writes.limits.push({ target, limits: null });
      }
    for (const [key, rule] of state.quota) {
      const [scope, target] = [key.slice(0, key.indexOf("|")), key.slice(key.indexOf("|") + 1)];
      if (scope === "group" && isDirectoryKey(target) && !inFile.has(target)) {
        changes.push({ area: "quota", scope: "group", target, name: nameOf(state, target), before: side(rule, conversion.period, stateFactor, state.unit), after: null, unit, currency: state.currency });
        writes.quota.push({ scope, target, rule: null });
      }
    }
    for (const [target, m] of state.models)
      if (isDirectoryKey(target) && !inFile.has(target)) {
        changes.push({ area: "model", target, name: nameOf(state, target), before: m.model, after: null, ...(m.choice ? { beforeChoice: true } : {}), ...(m.choice && m.smallest ? { beforeSmallest: true } : {}) });
        writes.models.push({ target, model: null, kind: m.kind });
      }
  }
  // Another unit: the numbers of every rule the file leaves alone go.
  if (unit !== state.unit) {
    const written = new Set(writes.quota.map((w) => `${w.scope}|${w.target}`));
    for (const [key, rule] of state.quota) {
      if (written.has(key) || !QUOTA_PERIODS.some((p) => typeof rule.limits[p] === "number" || typeof rule.afterLimits?.[p] === "number")) continue;
      const [scope, target] = [key.slice(0, key.indexOf("|")), key.slice(key.indexOf("|") + 1)];
      const next = { ...rule, limits: {}, afterLimits: null };
      changes.push({ area: "quota", scope: scope as "group", target, name: scope === "group" ? nameOf(state, target) : scope === "user" ? ((await one<{ name: string }>("SELECT name FROM users WHERE id=?", target))?.name ?? target) : target, before: side(rule, conversion.period, stateFactor, state.unit), after: side(next, conversion.period, factor, unit), unit, currency: state.currency });
      writes.quota.push({ scope, target, rule: next });
    }
  }
  return { changes, writes };
}
// The stored form of a group's limits (storageMode only when "add").
const normLimits = (l: GroupLimits) => {
  const out: Obj = {};
  for (const k of ["storageMb", "workspaces", "uploadMb"] as const) if (typeof l[k] === "number") out[k] = l[k];
  if (l.storageMode === "add") out.storageMode = "add";
  return out;
};

// ---- Import ----

export type LimitsImportResult = { ok: boolean; dryRun: boolean; applied: boolean; errors: FileIssue[]; errorCount: number; notes: FileIssue[]; changes: LimitsChange[] };

// admin.limitsImport { file, dryRun }: the file as text or as an object.
export async function importLimitsFile(user: Identity, input: { file?: unknown; dryRun?: unknown }): Promise<LimitsImportResult> {
  requireAdmin(user);
  const dryRun = input.dryRun !== false;
  const errors: FileIssue[] = [];
  const notes: FileIssue[] = [];
  const desired = await parseFile(input.file, errors, notes);
  const state = await currentState();
  const result = desired ? await plan(desired, state, errors, notes) : null;
  const done = (applied: boolean): LimitsImportResult => ({ ok: !errors.length, dryRun, applied, errors: errors.slice(0, MAX_ERRORS), errorCount: errors.length, notes, changes: errors.length ? [] : (result?.changes ?? []) });
  if (errors.length || !result || dryRun) {
    if (!dryRun && errors.length) throw new HttpError(400, "Die Datei enthält Fehler – nichts wurde geändert.");
    return done(false);
  }
  if (!result.changes.length) {
    // Nothing differs; the conversion is remembered for the export.
    await saveConversion(result.writes.conversion);
    return done(false);
  }
  await transaction(async () => {
    const w = result.writes;
    if (Object.keys(w.settings).length) await saveInstanceSettings(w.settings);
    if (w.unit) {
      const q = await quotaSettings();
      await run("INSERT INTO instance_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", "aiQuota", JSON.stringify({ ...q, unit: w.unit }));
    }
    const now = Date.now();
    for (const l of w.limits) {
      if (l.limits === null) await run("DELETE FROM group_limits WHERE target=?", l.target);
      else
        await run(
          "INSERT INTO group_limits(target,limits,updated_at) VALUES(?,?,?) ON CONFLICT(target) DO UPDATE SET limits=excluded.limits,updated_at=excluded.updated_at",
          l.target,
          JSON.stringify(normLimits(l.limits)),
          now,
        );
    }
    for (const q of w.quota) {
      if (q.rule === null) await run("DELETE FROM ai_quota_rules WHERE scope=? AND target=?", q.scope, q.target);
      else
        await run(
          "INSERT INTO ai_quota_rules(scope,target,exempt,limits,after_model,after_kind,after_limits,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(scope,target) DO UPDATE SET exempt=excluded.exempt,limits=excluded.limits,after_model=excluded.after_model,after_kind=excluded.after_kind,after_limits=excluded.after_limits,updated_at=excluded.updated_at",
          q.scope,
          q.target,
          q.rule.exempt ? 1 : 0,
          JSON.stringify(q.rule.limits),
          q.rule.after,
          q.rule.after ? q.rule.afterKind : null,
          q.rule.after && q.rule.afterLimits && Object.keys(q.rule.afterLimits).length ? JSON.stringify(q.rule.afterLimits) : null,
          now,
        );
    }
    for (const m of w.models) {
      if (m.model === null) await run("DELETE FROM ai_model_rules WHERE scope='group' AND target=?", m.target);
      else
        await run(
          "INSERT INTO ai_model_rules(scope,target,model,kind,choice,default_model,updated_at) VALUES('group',?,?,?,?,?,?) ON CONFLICT(scope,target) DO UPDATE SET model=excluded.model,kind=excluded.kind,choice=excluded.choice,default_model=excluded.default_model,updated_at=excluded.updated_at",
          m.target,
          m.model,
          m.kind,
          m.choice ? 1 : 0,
          m.choice && m.smallest ? "smallest" : null,
          now,
        );
    }
    await saveConversion(w.conversion);
    // Every change in the activity log.
    for (const c of result.changes) await audit(user.id, "admin.limitsImport", "target" in c && c.target ? c.target : "instance", JSON.stringify(c));
  }, user);
  return done(true);
}
async function saveConversion(c: Plan["writes"]["conversion"]) {
  const value = JSON.stringify(c);
  const row = await one<{ value: string }>("SELECT value FROM instance_settings WHERE key=?", STATE_KEY);
  if (row?.value !== value) await run("INSERT INTO instance_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", STATE_KEY, value);
}

// ---- Export ----

// admin.limitsExport: the current settings as a file of this format.
export async function exportLimitsFile(user: Identity) {
  requireAdmin(user);
  const state = await currentState();
  const { period, tokensPerAction, costPerAction } = state.conversion;
  const factor = state.unit === "tokens" ? tokensPerAction : costPerAction;
  const skipped: string[] = [];
  const toActions = (limit: number, what: string) => {
    const exact = state.unit === "tokens" ? limit / factor : Math.round((limit / factor) * 1e6) / 1e6;
    const n = Math.round(exact);
    if (Math.abs(exact - n) > 1e-6) skipped.push(`${what}: ${limit} ${state.unit === "tokens" ? "tokens" : state.currency} → ${n} actions (rounded)`);
    return n;
  };
  // The continuation's limit as aiAfterTokens (tokens, the export's period).
  const afterLimitOf = (q: QuotaState, what: string, set: (v: number) => void) => {
    if (!q.after || !q.afterLimits) return;
    const others = QUOTA_PERIODS.filter((p) => p !== period && typeof q.afterLimits![p] === "number");
    if (others.length) skipped.push(`${what}: limits after the quota per ${others.join(", ")} (only "${period}" is exported)`);
    const v = q.afterLimits[period];
    if (typeof v !== "number") return;
    if (state.unit === "tokens") set(v);
    else skipped.push(`${what}: limit after the quota in ${state.currency} (only tokens are exported)`);
  };
  const modelName = (m: string) => {
    for (const f of MODEL_FAMILIES) if (familyModel(f, state.options, state.prices) === m) return f;
    return m;
  };
  // A group's fields; null when the group has nothing to say.
  const groupEntry = (target: string, what: string) => {
    const entry: Obj = {};
    const l = state.limits.get(target);
    entry.kind = l?.storageMode === "add" ? "addon" : "plan";
    if (l) for (const k of ["storageMb", "uploadMb", "workspaces"] as const) if (typeof l[k] === "number") entry[k] = l[k];
    const q = state.quota.get(`group|${target}`);
    if (q) {
      if (q.exempt) skipped.push(`${what}: AI quota exempt (not representable)`);
      else {
        const others = QUOTA_PERIODS.filter((p) => p !== period && typeof q.limits[p] === "number");
        if (others.length) skipped.push(`${what}: AI limits per ${others.join(", ")} (only "${period}" is exported)`);
        // Tokens directly with the unit "tokens" (aiTokens), actions with cost.
        if (typeof q.limits[period] === "number") {
          if (state.unit === "tokens") entry.aiTokens = q.limits[period] as number;
          else entry.aiActions = toActions(q.limits[period] as number, what);
        }
        if (typeof q.limits[period] === "number" || q.after) entry.aiAfter = q.after && state.provider && q.afterKind === state.provider.kind ? modelName(q.after) : "off";
        afterLimitOf(q, what, (v) => (entry.aiAfterTokens = v));
      }
    }
    const m = state.models.get(target);
    if (m) {
      if (!state.provider || m.kind !== state.provider.kind) skipped.push(`${what}: model rule for another provider (${m.kind})`);
      else {
        const f = modelName(m.model);
        // "all" is the choice up to the most capable (#538); a fixed rule
        // of the most capable model stays an explicit aiModel.
        if (m.choice && m.model === allModel(state.options, state.prices)) {
          entry.aiModels = "all";
          // Only when it is not the default ("largest").
          if (m.smallest) entry.aiDefault = "smallest";
        } else if (!m.choice && (f === "haiku" || f === "sonnet")) entry.aiModels = f;
        else {
          entry.aiModel = m.model;
          if (m.choice) skipped.push(`${what}: "up to ${m.model}, your choice" (exported as exactly this model)`);
        }
      }
    }
    // An add-on with AI actions keeps its kind; one without anything: none.
    return Object.keys(entry).length > 1 ? entry : null;
  };
  const targets = new Set<string>([...state.limits.keys(), ...[...state.quota.keys()].filter((k) => k.startsWith("group|")).map((k) => k.slice(6)), ...state.models.keys()]);
  const plans: Obj[] = [];
  const groups: Obj[] = [];
  for (const target of [...targets].sort((a, b) => nameOf(state, a).localeCompare(nameOf(state, b)))) {
    if (isDirectoryKey(target)) {
      const e = groupEntry(target, directoryName(target));
      if (e) plans.push({ group: directoryName(target), ...e });
      continue;
    }
    // A workspace group: by its workspace's and its own name, if unique.
    const g = await one<{ name: string; workspace: string | null }>("SELECT g.name,w.name workspace FROM groups g LEFT JOIN workspaces w ON w.id=g.workspace_id WHERE g.id=?", target);
    if (!g || !g.workspace) {
      skipped.push(`${target}: deleted group`);
      continue;
    }
    const same = await one<{ n: number }>("SELECT COUNT(*) n FROM groups g JOIN workspaces w ON w.id=g.workspace_id WHERE w.name=? AND g.name=?", g.workspace, g.name);
    if (Number(same?.n) > 1) {
      skipped.push(`${g.workspace} · ${g.name}: workspace group name not unique`);
      continue;
    }
    const e = groupEntry(target, `${g.workspace} · ${g.name}`);
    if (e) groups.push({ workspaceGroup: { workspace: g.workspace, group: g.name }, ...e });
  }
  for (const [key] of state.quota) if (key.startsWith("role|") || key.startsWith("user|")) skipped.push(`AI rule ${key.startsWith("role|") ? `for role ${key.slice(5)}` : "for a single person"} (not part of the file)`);
  for (const r of await modelRules()) if (r.scope !== "group") skipped.push(`model rule ${r.scope === "role" ? `for role ${r.target}` : "for a single person"} (not part of the file)`);
  const def = state.quota.get("default|");
  const inst = state.quota.get("instance|");
  const aiQuota: Obj = { period, unit: state.unit, ...(state.unit === "tokens" ? { tokensPerAction } : { costPerAction }) };
  for (const [what, r] of [["default", def], ["instance ceiling", inst]] as const) {
    const others = r ? QUOTA_PERIODS.filter((p) => p !== period && typeof r.limits[p] === "number") : [];
    if (others.length) skipped.push(`AI ${what}: limits per ${others.join(", ")} (only "${period}" is exported)`);
  }
  if (def) {
    if (typeof def.limits[period] === "number") {
      if (state.unit === "tokens") aiQuota.defaultTokens = def.limits[period] as number;
      else aiQuota.defaultActions = toActions(def.limits[period] as number, "default");
    }
    aiQuota.defaultAfter = def.after && state.provider && def.afterKind === state.provider.kind ? modelName(def.after) : "off";
    afterLimitOf(def, "default", (v) => (aiQuota.defaultAfterTokens = v));
  }
  if (inst && typeof inst.limits[period] === "number") {
    const v = inst.limits[period] as number;
    if (state.unit === "tokens") aiQuota.instanceCapTokens = v;
    else if (state.currency === "USD") aiQuota.instanceCapUsd = v;
    else aiQuota.instanceCap = v;
  }
  return {
    version: LIMITS_FILE_VERSION,
    _exportedAt: new Date().toISOString(),
    plans,
    flowplan: {
      defaults: {
        storageMb: state.settings.defaultUserStorageMb ?? 0,
        uploadMb: state.settings.maxUploadMb,
        ...(state.settings.defaultUserWorkspaces !== null ? { workspaces: state.settings.defaultUserWorkspaces } : {}),
      },
      aiQuota,
      moreLimitsUrl: state.settings.moreLimitsUrl,
      removeMissing: false,
      ...(groups.length ? { groups } : {}),
    },
    ...(skipped.length ? { _skipped: skipped } : {}),
  };
}
