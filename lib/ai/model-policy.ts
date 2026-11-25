// The AI model per person, workspace group and role: which model of the
// instance's provider a person's AI uses – so the whole instance can run on
// a small model by default while some people use a larger one. Set by the
// administrators under Administration → Benutzer (a person's details), in a
// workspace's group dialog and in the limits table of Administration → KI →
// Kontingente (admin.aiRule, lib/ai/admin-rule.ts).
//
// Precedence for a person:
//   1. their own rule (a model, or '' = the instance's default whatever
//      their groups say);
//   2. else the rules of their workspace groups and roles ("admin",
//      "guest"): the most capable model among them – the one with the
//      highest price per million tokens (input + output) in the instance's
//      price list (Administration → KI → Preise); models without a price
//      rank below priced ones, and among equals the name decides (A–Z), so
//      the outcome never depends on the order of the rows;
//   3. else the instance's default model (Administration → KI).
//
// Only the instance's provider: a person's own provider and the on-device
// model choose their own model, as with the quotas. A rule remembers the
// provider kind it was chosen for; after the instance switches to another
// kind, the rule is inactive until it is set again (a Claude model never
// goes to OpenAI). Enforced in lib/ai/resolve.ts, where every AI feature
// gets its provider – the browser only shows it. Workflows run as the
// person who activated them (lib/workflows/runner.ts): that person's rules
// apply, without the role "admin" (runs never have admin rights).
//
// Choosing (#538): a group or role rule marked `choice` ("Bis Opus – frei
// wählbar") allows its model and the instance's smaller ones
// (allowedByRule); without the mark exactly its model. A person's allowed
// set is the union of their group and role rules; their own rule (a single
// model, or the instance's default) allows exactly that one. With more than
// one model allowed, the person picks one in the AI panel or under
// Einstellungen → KI (ai_user_settings.config.instanceModel,
// lib/ai/settings.ts); the default is the most capable, as without a
// choice. The server applies a choice only while it is in the allowed set
// (applyModelChoice) – after a plan change a stale choice is ignored and
// the default applies. Workflows always run with the default.
import { all, one } from "../db";
import { costOf } from "../ai-statistics";
import { instanceAiSettings, userAiSettings, type AiPrice } from "./settings";
import { hasLimit, instanceModelOptions, personalLimits, quotaPerson, quotaRules, quotaSettings, type QuotaPerson } from "./quota";
import { MODEL_RULE_SCOPES, type ModelPolicy, type ModelRule, type ModelTier, type QuotaRole } from "./quota-shared";
import type { Identity } from "../types";

// A model name as providers spell them (also Ollama's "name:tag" and
// OpenRouter's "vendor/model").
export const MODEL_NAME = /^[\w.\-:/@]+$/;

export async function modelRules(): Promise<ModelRule[]> {
  try {
    return (await all<Omit<ModelRule, "choice"> & { choice: number | null }>("SELECT scope,target,model,kind,choice FROM ai_model_rules ORDER BY scope,target"))
      .filter((r) => (MODEL_RULE_SCOPES as readonly string[]).includes(r.scope))
      .map(({ choice, ...r }) => (choice && r.scope !== "user" ? { ...r, choice: true } : r));
  } catch {
    return [];
  }
}

// Rank of a model: its price for a million tokens in and out, -1 without one.
const rank = (prices: AiPrice[], model: string) => costOf(prices, model, 1e6, 1e6) ?? -1;
// The most capable of several models (see the precedence above).
export function mostCapable(models: string[], prices: AiPrice[]) {
  return [...models].sort((a, b) => rank(prices, b) - rank(prices, a) || a.localeCompare(b))[0];
}
// Most capable first (the order of a choice).
const byCapability = (models: string[], prices: AiPrice[]) => [...new Set(models)].sort((a, b) => rank(prices, b) - rank(prices, a) || a.localeCompare(b));

// Model families of Claude's naming (the limits file's aiModels, #538).
export const MODEL_FAMILIES = ["haiku", "sonnet", "opus"] as const;
export type ModelFamily = (typeof MODEL_FAMILIES)[number];
// The instance's model of a family: among the instance's models whose name
// has the family in it, the most expensive, else the newest by name.
export function familyModel(family: ModelFamily, options: string[], prices: AiPrice[]) {
  const list = options.filter((m) => m.toLowerCase().includes(family));
  if (!list.length) return null;
  return [...list].sort((a, b) => rank(prices, b) - rank(prices, a) || b.localeCompare(a, "en", { numeric: true }))[0];
}
// "all": the most capable model the instance knows.
export function allModel(options: string[], prices: AiPrice[]) {
  for (const f of ["opus", "sonnet", "haiku"] as const) {
    const m = familyModel(f, options, prices);
    if (m) return m;
  }
  return options.length && prices.length ? mostCapable(options, prices) : null;
}

// The models a rule allows (#538). Without `choice` exactly its model. With
// it, "up to this model": its model and the instance's model of each family
// (Haiku, Sonnet, Opus – familyModel) that does not cost more; for a
// provider without these families (OpenAI, Ollama …) every model of the
// instance's price list that does not cost more. `options`: the models the
// instance offers (lib/ai/quota.ts instanceModelOptions).
export function allowedByRule(rule: Pick<ModelRule, "model" | "choice">, options: string[], prices: AiPrice[]): string[] {
  if (!rule.model) return [];
  if (!rule.choice) return [rule.model];
  const top = rank(prices, rule.model);
  const families = MODEL_FAMILIES.map((f) => familyModel(f, options, prices)).filter((m): m is string => !!m && m !== rule.model);
  const below = (m: string) => rank(prices, m) <= top;
  const smaller = families.length ? families.filter(below) : options.filter((m) => m !== rule.model && rank(prices, m) >= 0 && below(m));
  return byCapability([rule.model, ...smaller], prices);
}
// The options of a model choice in the admin's selects: per model, what
// "Bis … – frei wählbar" would allow (only models where that is more than
// the model itself).
export function choiceRanges(options: string[], prices: AiPrice[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const m of options) {
    const list = allowedByRule({ model: m, choice: true }, options, prices);
    if (list.length > 1) out[m] = list;
  }
  return out;
}

// Which model applies to a person – pure, for the tests and the
// administration's overview. `options`: the instance's models (for the
// allowed set of choice rules); by default the default, the price list
// and the rules' models, as instanceModelOptions.
export function chooseModel(rules: ModelRule[], who: QuotaPerson, instance: { kind: string; model: string }, prices: AiPrice[], options?: string[]): ModelPolicy {
  const active = rules.filter((r) => r.kind === instance.kind);
  const base: ModelPolicy = { model: instance.model, source: "instance", target: null, default: instance.model };
  const own = active.find((r) => r.scope === "user" && r.target === who.userId);
  if (own) return { ...base, model: own.model || instance.model, source: "user", target: own.target };
  const groups = active.filter((r) => r.model && ((r.scope === "group" && who.groups.includes(r.target)) || (r.scope === "role" && who.roles.includes(r.target as QuotaRole))));
  if (!groups.length) return base;
  const model = mostCapable(
    groups.map((r) => r.model),
    prices,
  );
  const rule = groups.filter((r) => r.model === model).sort((a, b) => (a.scope === b.scope ? a.target.localeCompare(b.target) : a.scope === "group" ? -1 : 1))[0];
  const policy: ModelPolicy = { ...base, model, source: rule.scope === "group" ? "group" : "role", target: rule.target };
  if (!groups.some((r) => r.choice)) {
    const fixed = byCapability(groups.map((r) => r.model), prices);
    return fixed.length > 1 ? { ...policy, allowed: fixed } : policy;
  }
  const known = options ?? [...new Set([instance.model, ...prices.map((p) => p.model), ...active.map((r) => r.model)].map((m) => m.trim()).filter(Boolean))];
  // The union; the default (the most capable) first.
  const allowed = byCapability(groups.flatMap((r) => allowedByRule(r, known, prices)), prices);
  return allowed.length > 1 ? { ...policy, allowed: [model, ...allowed.filter((m) => m !== model)] } : policy;
}

// The person's choice, when it is allowed; else the default (silently: a
// choice from before a plan change, or forged).
export function applyModelChoice(policy: ModelPolicy, choice: string | null | undefined): ModelPolicy {
  if (!choice || choice === policy.model || !policy.allowed?.includes(choice)) return policy;
  return { ...policy, model: choice, chosen: true };
}

// The tiers of an allowed set (most capable first): the last the fastest
// and cheapest, the first the strongest, the others balanced.
export function modelTiers(allowed: string[]): { model: string; tier: ModelTier }[] {
  return allowed.map((model, i) => ({ model, tier: i === 0 ? "strong" : i === allowed.length - 1 ? "fast" : "balanced" }));
}

// The model for this person's requests through the instance's provider
// (lib/ai/resolve.ts). Without rules: the instance's default, one query.
// `personal`: apply the person's own choice (not for workflows).
export async function modelPolicyFor(user: Pick<Identity, "id" | "isAdmin">, options: { personal?: boolean } = {}): Promise<ModelPolicy> {
  const instance = await instanceAiSettings();
  const provider = instance.provider;
  const base: ModelPolicy = { model: provider?.model || "", source: "instance", target: null, default: provider?.model || "" };
  if (!provider?.model.trim()) return base;
  try {
    if (!(await one("SELECT 1 FROM ai_model_rules WHERE kind=? LIMIT 1", provider.kind))) return base;
  } catch {
    return base;
  }
  const rules = await modelRules();
  const policy = chooseModel(rules, await quotaPerson(user), provider, instance.prices, rules.some((r) => r.choice) ? await instanceModelOptions(provider.kind, rules) : undefined);
  if (!options.personal || !policy.allowed) return policy;
  return applyModelChoice(policy, (await userAiSettings(user.id)).instanceModel);
}

// What the AI panel's picker shows (AiStatus.provider.choice): the allowed
// models with their tier, the default, and whether the person's quota
// counts cost – then a smaller model stretches it.
export async function modelChoiceView(user: Pick<Identity, "id" | "isAdmin">, policy: ModelPolicy) {
  if (!policy.allowed || policy.allowed.length < 2) return null;
  let costQuota = false;
  try {
    const settings = await quotaSettings();
    if (settings.unit === "cost") {
      const personal = personalLimits(await quotaRules(settings.unit), await quotaPerson(user), (await instanceAiSettings()).prices);
      costQuota = !personal.exempt && hasLimit(personal.limits);
    }
  } catch {}
  return { models: modelTiers(policy.allowed), default: policy.allowed[0], costQuota };
}
