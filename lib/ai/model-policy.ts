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
import { all, one } from "../db";
import { costOf } from "../ai-statistics";
import { instanceAiSettings, type AiPrice } from "./settings";
import { quotaPerson, type QuotaPerson } from "./quota";
import { MODEL_RULE_SCOPES, type ModelPolicy, type ModelRule, type QuotaRole } from "./quota-shared";
import type { Identity } from "../types";

// A model name as providers spell them (also Ollama's "name:tag" and
// OpenRouter's "vendor/model").
export const MODEL_NAME = /^[\w.\-:/@]+$/;

export async function modelRules(): Promise<ModelRule[]> {
  try {
    return (await all<ModelRule>("SELECT scope,target,model,kind FROM ai_model_rules ORDER BY scope,target")).filter((r) => (MODEL_RULE_SCOPES as readonly string[]).includes(r.scope));
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

// Which model applies to a person – pure, for the tests and the
// administration's overview.
export function chooseModel(rules: ModelRule[], who: QuotaPerson, instance: { kind: string; model: string }, prices: AiPrice[]): ModelPolicy {
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
  return { ...base, model, source: rule.scope === "group" ? "group" : "role", target: rule.target };
}

// The model for this person's requests through the instance's provider
// (lib/ai/resolve.ts). Without rules: the instance's default, one query.
export async function modelPolicyFor(user: Pick<Identity, "id" | "isAdmin">): Promise<ModelPolicy> {
  const instance = await instanceAiSettings();
  const provider = instance.provider;
  const base: ModelPolicy = { model: provider?.model || "", source: "instance", target: null, default: provider?.model || "" };
  if (!provider?.model.trim()) return base;
  try {
    if (!(await one("SELECT 1 FROM ai_model_rules WHERE kind=? LIMIT 1", provider.kind))) return base;
  } catch {
    return base;
  }
  return chooseModel(await modelRules(), await quotaPerson(user), provider, instance.prices);
}
