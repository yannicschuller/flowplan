// The AI of one person, workspace group or role as the administration edits
// it in place – the "KI" part of a person's details (Administration →
// Benutzer), of a workspace's group dialog and of a row of the limits table
// (Administration → KI → Kontingente): the model (lib/ai/model-policy.ts)
// and the quota limits. The limits are the rules of the quota table
// (ai_quota_rules, lib/ai/quota.ts) – the same rows, no second store.
//
// GET /api/ai/admin/rule?scope=user&target=… (aiRuleView) and the command
// admin.aiRule (saveAiRule); administrators only, every change audited.
import { z } from "zod";
import { all, audit, one, run } from "../db";
import { HttpError } from "../auth";
import { requireAdmin } from "../permissions";
import type { Identity } from "../types";
import { instanceAiSettings } from "./settings";
import { activeAfter, afterSchema, amountOf, checkedAfter, cleanLimits, instanceModelOptions, limitsSchema, periodBounds, personalLimits, quotaPerson, quotaRules, quotaSettings, type PersonalLimits } from "./quota";
import { allGroupKeys, validGroupKey } from "../person-groups";
import { directoryName, isDirectoryKey } from "../group-keys";
import { allowedByRule, chooseModel, choiceRanges, MODEL_NAME, modelRules } from "./model-policy";
import { MODEL_DEFAULTS, MODEL_RULE_SCOPES, QUOTA_PERIODS, QUOTA_ROLES, type ModelPolicy, type ModelRule, type ModelRuleScope, type QuotaPeriod, type QuotaRule } from "./quota-shared";

const target = z.string().trim().min(1).max(210);
const scopeInput = z.object({ scope: z.enum(MODEL_RULE_SCOPES), target });

// The target exists: a role of QUOTA_ROLES, a group, an account.
async function requireTarget(scope: ModelRuleScope, id: string) {
  if (scope === "role" && !(QUOTA_ROLES as readonly string[]).includes(id)) throw new HttpError(400, "Unbekannte Rolle.");
  if (scope === "group" && !(await validGroupKey(id))) throw new HttpError(404, "Gruppe nicht gefunden.");
  if (scope === "user" && !(await one("SELECT 1 FROM users WHERE id=?", id))) throw new HttpError(404, "Benutzer nicht gefunden.");
}

// Models to offer: the instance's default, the models of the price list and
// of the rules for the instance's provider kind (the provider's own list is
// fetched in the browser on demand: POST /api/ai/admin/models).
export async function modelOptions(kind: string | null, rules?: ModelRule[]) {
  return await instanceModelOptions(kind, rules ?? (await modelRules()));
}
// A group's or role's own rule as it applies to its members (#538): its
// model, and with "Bis … – frei wählbar" the models they may pick.
function rulePolicy(rule: ModelRule | null, scope: "group" | "role", id: string, provider: { kind: string; model: string }, options: string[], prices: Parameters<typeof allowedByRule>[2]): ModelPolicy {
  if (!rule || rule.kind !== provider.kind || !rule.model) return { model: provider.model, source: "instance", target: null, default: provider.model };
  const allowed = allowedByRule(rule, options, prices);
  if (allowed.length < 2) return { model: rule.model, source: scope, target: id, default: provider.model };
  // "Standard: kleinstes Modell": the cheapest of the set is the default.
  const smallest = rule.defaultModel === "smallest";
  const standard = smallest ? allowed[allowed.length - 1] : rule.model;
  return { model: standard, source: scope, target: id, default: provider.model, allowed, standard, ...(smallest ? { smallest: true } : {}) };
}

type UsageRow = { day: string; model: string; tokens_in: number; tokens_out: number };
export type AiRuleUsage = { period: QuotaPeriod; used: number; limit: number | null; resetAt: number };

export async function aiRuleView(user: Identity, raw: unknown, now = Date.now()) {
  requireAdmin(user);
  const { scope, target: id } = scopeInput.parse(raw);
  await requireTarget(scope, id);
  const settings = await quotaSettings();
  const ai = await instanceAiSettings();
  const rules = await quotaRules(settings.unit);
  const models = await modelRules();
  const provider = ai.provider?.model.trim() ? { kind: ai.provider.kind, model: ai.provider.model } : null;
  const ownQuota = rules.find((r) => r.scope === scope && r.target === id) ?? null;
  const ownModel = models.find((r) => r.scope === scope && r.target === id) ?? null;
  const options = await modelOptions(provider?.kind ?? null, models);
  // Whose usage: the person, or the members of a group (the role: nobody –
  // a role has no fixed member list here).
  let people: string[] = [];
  let members: number | null = null;
  let inheritedQuota: PersonalLimits | null = null,
    effectiveQuota: PersonalLimits | null = null;
  let inheritedModel: ModelPolicy | null = null,
    effectiveModel: ModelPolicy | null = null;
  const names = new Map<string, string>();
  if (scope === "user") {
    const { adminUserIds } = await import("../auth");
    const who = await quotaPerson({ id, isAdmin: (await adminUserIds()).includes(id) });
    people = [id];
    inheritedQuota = personalLimits(
      rules.filter((r) => !(r.scope === "user" && r.target === id)),
      who,
      ai.prices,
    );
    effectiveQuota = personalLimits(rules, who, ai.prices);
    if (provider) {
      inheritedModel = chooseModel(
        models.filter((r) => !(r.scope === "user" && r.target === id)),
        who,
        provider,
        ai.prices,
        options,
      );
      effectiveModel = chooseModel(models, who, provider, ai.prices, options);
    }
    for (const g of await all<{ id: string; name: string; workspace: string | null }>("SELECT g.id,g.name,w.name workspace FROM groups g LEFT JOIN workspaces w ON w.id=g.workspace_id WHERE g.id IN (SELECT group_id FROM group_members WHERE user_id=?)", id))
      names.set(g.id, `${g.workspace ?? "–"} · ${g.name}`);
    for (const key of who.groups) if (isDirectoryKey(key)) names.set(key, directoryName(key));
  } else if (scope === "group") {
    people = isDirectoryKey(id)
      ? [...(await allGroupKeys())].filter(([, keys]) => keys.includes(id)).map(([userId]) => userId)
      : (await all<{ user_id: string }>("SELECT user_id FROM group_members WHERE group_id=?", id)).map((m) => m.user_id);
    members = people.length;
    if (provider) effectiveModel = rulePolicy(ownModel, "group", id, provider, options, ai.prices);
  } else if (provider) effectiveModel = rulePolicy(ownModel, "role", id, provider, options, ai.prices);
  // Usage of every period (also without a limit), in the quota's unit.
  const bounds = QUOTA_PERIODS.map((p) => ({ p, ...periodBounds(p, now, settings.timeZone, settings.weekStart) }));
  const since = bounds.reduce((a, b) => (b.start < a ? b.start : a), bounds[0].start);
  const rows: UsageRow[] = [];
  for (let i = 0; i < people.length; i += 500) {
    const slice = people.slice(i, i + 500);
    rows.push(
      ...(await all<UsageRow>(
        `SELECT day,model,SUM(tokens_in) tokens_in,SUM(tokens_out) tokens_out FROM ai_quota_usage WHERE day>=? AND kind='person' AND user_id IN (${slice.map(() => "?").join(",")}) GROUP BY day,model`,
        since,
        ...slice,
      )),
    );
  }
  const limitsNow = scope === "user" ? (effectiveQuota?.exempt ? null : effectiveQuota?.limits) : ownQuota && !ownQuota.exempt ? ownQuota.limits : null;
  const usage: AiRuleUsage[] = bounds.map(({ p, start, resetAt }) => ({
    period: p,
    used: amountOf(
      rows.filter((r) => r.day >= start),
      settings.unit,
      ai.prices,
    ),
    limit: typeof limitsNow?.[p] === "number" ? (limitsNow[p] as number) : null,
    resetAt,
  }));
  for (const source of [effectiveModel, inheritedModel])
    if (source?.source === "group" && source.target && !names.has(source.target)) {
      if (isDirectoryKey(source.target)) names.set(source.target, directoryName(source.target));
      else {
        const g = await one<{ name: string; workspace: string | null }>("SELECT g.name,w.name workspace FROM groups g LEFT JOIN workspaces w ON w.id=g.workspace_id WHERE g.id=?", source.target);
        if (g) names.set(source.target, `${g.workspace ?? "–"} · ${g.name}`);
      }
    }
  return {
    scope,
    target: id,
    provider,
    unit: settings.unit,
    currency: ai.currency,
    priced: ai.prices.length > 0,
    members,
    quota: { own: ownQuota, inherited: inheritedQuota, effective: effectiveQuota, after: scope === "user" ? activeAfter(effectiveQuota, provider) : null },
    usage,
    model: {
      own: ownModel,
      // A rule for another provider kind than the instance's: inactive.
      active: !!ownModel && !!provider && ownModel.kind === provider.kind,
      inherited: inheritedModel,
      effective: effectiveModel,
      options,
      // Per model: what "Bis … – frei wählbar" allows (#538).
      ranges: choiceRanges(options, ai.prices),
    },
    groupNames: Object.fromEntries(names),
  };
}
export type AiRuleView = Awaited<ReturnType<typeof aiRuleView>>;

const saveInput = scopeInput.extend({
  // Absent: unchanged; null: no own model (inherited); '' (people only):
  // the instance's default whatever their groups say.
  model: z.string().trim().max(200).regex(MODEL_NAME, "Ungültiger Modellname.").or(z.literal("")).nullable().optional(),
  // With a model of a group or role: "up to this model, your choice"
  // (#538); absent or false: exactly this model. Never for a person.
  choice: z.boolean().optional(),
  // With the choice: the members' default until they pick a model –
  // "smallest" or "largest" (the most capable). Absent: as the rule had it
  // (a new rule: "largest").
  defaultModel: z.enum(MODEL_DEFAULTS).optional(),
  // Absent: unchanged; null: no own limits (inherited); else the rule of
  // the quota table for this target.
  // afterLimits: the continuation's limit (absent: kept as it is).
  quota: z.object({ exempt: z.boolean().default(false), limits: limitsSchema.default({}), after: afterSchema, afterLimits: limitsSchema.nullable().optional() }).nullable().optional(),
});

// admin.aiRule: the model and/or the limits of one person, group or role.
export async function saveAiRule(user: Identity, raw: unknown) {
  requireAdmin(user);
  const b = saveInput.parse(raw);
  await requireTarget(b.scope, b.target);
  const detail: Record<string, unknown> = { scope: b.scope };
  if (b.model !== undefined) {
    if (b.model === null) await run("DELETE FROM ai_model_rules WHERE scope=? AND target=?", b.scope, b.target);
    else {
      if (b.model === "" && b.scope !== "user") throw new HttpError(400, "Für Gruppen und Rollen gibt es kein eigenes „Standard der Instanz“ – entferne das Modell stattdessen.");
      const provider = (await instanceAiSettings()).provider;
      if (!provider?.model.trim()) throw new HttpError(409, "Bitte zuerst einen KI-Anbieter der Instanz einrichten (Einstellungen → Instanz → KI).");
      const choice = !!b.choice && b.scope !== "user" && !!b.model;
      // The default of the choice: given, else as the rule had it. Stored
      // as 'smallest' or NULL (the most capable, as every older rule).
      const before = choice && !b.defaultModel ? await one<{ choice: number; default_model: string | null }>("SELECT choice,default_model FROM ai_model_rules WHERE scope=? AND target=?", b.scope, b.target) : null;
      const defaultModel = choice && (b.defaultModel ? b.defaultModel === "smallest" : !!before?.choice && before.default_model === "smallest") ? "smallest" : null;
      await run(
        "INSERT INTO ai_model_rules(scope,target,model,kind,choice,default_model,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(scope,target) DO UPDATE SET model=excluded.model,kind=excluded.kind,choice=excluded.choice,default_model=excluded.default_model,updated_at=excluded.updated_at",
        b.scope,
        b.target,
        b.model,
        provider.kind,
        choice ? 1 : 0,
        defaultModel,
        Date.now(),
      );
      if (choice) detail.choice = true;
      if (defaultModel) detail.defaultModel = defaultModel;
    }
    detail.model = b.model === null ? "inherited" : b.model || "instance-default";
  }
  if (b.quota !== undefined) {
    if (b.quota === null) await run("DELETE FROM ai_quota_rules WHERE scope=? AND target=?", b.scope, b.target);
    else {
      const { unit } = await quotaSettings();
      const limits = cleanLimits(b.quota.exempt ? {} : b.quota.limits, unit);
      const after = b.quota.exempt ? null : await checkedAfter(b.quota.after);
      // The continuation's limit: given, or kept – gone without a model.
      const given = b.quota.afterLimits === undefined ? undefined : cleanLimits(b.quota.afterLimits ?? {}, unit);
      const afterLimits = after ? (given === undefined ? undefined : Object.keys(given).length ? JSON.stringify(given) : null) : null;
      await run(
        `INSERT INTO ai_quota_rules(scope,target,exempt,limits,after_model,after_kind,after_limits,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(scope,target) DO UPDATE SET exempt=excluded.exempt,limits=excluded.limits,after_model=excluded.after_model,after_kind=excluded.after_kind,${afterLimits === undefined ? "" : "after_limits=excluded.after_limits,"}updated_at=excluded.updated_at`,
        b.scope,
        b.target,
        b.quota.exempt ? 1 : 0,
        JSON.stringify(limits),
        after?.model ?? null,
        after?.kind ?? null,
        afterLimits ?? null,
        Date.now(),
      );
      if (after) detail.after = after.model;
    }
    detail.quota = b.quota === null ? "inherited" : b.quota.exempt ? "exempt" : cleanLimits(b.quota.limits, (await quotaSettings()).unit);
  }
  await audit(user.id, "admin.aiRule", b.target, JSON.stringify(detail));
  return await aiRuleView(user, { scope: b.scope, target: b.target });
}

// The model column of the limits table and the person table (Administration
// → KI → Kontingente): the rules, the instance's default, the options and,
// per person, what applies.
export async function quotaModelView(people: { id: string; roles: QuotaRule["target"][]; groups: string[] }[]) {
  const ai = await instanceAiSettings();
  const models = await modelRules();
  const provider = ai.provider?.model.trim() ? { kind: ai.provider.kind, model: ai.provider.model } : null;
  const options = await modelOptions(provider?.kind ?? null, models);
  return {
    provider,
    modelRules: models.map((r) => ({ ...r, active: !!provider && r.kind === provider.kind })),
    modelOptions: options,
    modelRanges: choiceRanges(options, ai.prices),
    effective: new Map(people.map((p) => [p.id, provider ? chooseModel(models, { userId: p.id, roles: p.roles as never, groups: p.groups }, provider, ai.prices, options) : null])),
  };
}
