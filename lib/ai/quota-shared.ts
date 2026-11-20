// AI quotas (#382): the shapes the server (lib/ai/quota.ts), the
// administration and the settings share. Safe for the browser: no server
// imports, no Temporal.
//
// Limits count tokens (input and output together) or, with prices per model
// in the AI settings, the estimated cost in the instance's currency. Levels:
// the whole instance (a ceiling for everyone together), a default per
// person, roles and workspace groups (the highest group limit applies) and
// single accounts. Periods are calendar days, weeks, months and years in the
// quota's time zone, each optional.

export const QUOTA_PERIODS = ["day", "week", "month", "year"] as const;
export type QuotaPeriod = (typeof QUOTA_PERIODS)[number];
// A limit per period; null or absent: no limit for that period.
export type QuotaLimits = Partial<Record<QuotaPeriod, number | null>>;

// instance: the ceiling for everyone together (target '');
// default: everyone without a more specific rule (target '');
// role: "admin" (instance administrators) or "guest" (people who are a
// full member of no workspace);
// group: a workspace group (groups.id; SSO, SCIM and LDAP groups reach
// these through the SSO group mappings);
// user: a single account.
export const QUOTA_SCOPES = ["instance", "default", "role", "group", "user"] as const;
export type QuotaScope = (typeof QUOTA_SCOPES)[number];
export const QUOTA_ROLES = ["admin", "guest"] as const;
export type QuotaRole = (typeof QUOTA_ROLES)[number];

// exempt: no personal limit at all (a person or a group the limits don't
// apply to); the instance ceiling still does.
export type QuotaRule = { scope: QuotaScope; target: string; exempt: boolean; limits: QuotaLimits };

export type QuotaUnit = "tokens" | "cost";
export type QuotaSettings = {
  unit: QuotaUnit;
  // IANA zone of the calendar periods; the week starts on weekStart.
  timeZone: string;
  weekStart: "monday" | "sunday";
  // Per cent of a limit from which people see a note (and administrators a
  // notification for the instance ceiling).
  warnAt: number;
  // AI nodes of workflows count towards the instance ceiling (never towards
  // the person a workflow runs as; workflows keep their own daily budget).
  workflowsCountInstance: boolean;
};

// One period of a limit as people see it.
export type QuotaPeriodState = {
  level: "person" | "instance";
  period: QuotaPeriod;
  limit: number;
  used: number;
  left: number;
  // When the period ends (ms) and its first day afterwards ('YYYY-MM-DD').
  resetAt: number;
};
// GET /api/ai/quota: what is left for the person asking.
export type QuotaStatus = {
  // Quotas apply to this person's AI (false: own provider or no quotas).
  applies: boolean;
  unit: QuotaUnit;
  currency: string;
  warnAt: number;
  timeZone: string;
  // personal: the person is exempt from personal limits.
  exempt: boolean;
  periods: QuotaPeriodState[];
  // Some period has less than (100 − warnAt) % left / nothing left.
  low: boolean;
  blocked: boolean;
};

// Share of a limit used, 0…1 (a limit of 0 is used up).
export const quotaShare = (s: Pick<QuotaPeriodState, "limit" | "used">) => (s.limit > 0 ? Math.min(1, s.used / s.limit) : 1);
// The period with the least left, relative to its limit.
export function tightest(periods: QuotaPeriodState[]): QuotaPeriodState | null {
  let best: QuotaPeriodState | null = null;
  for (const p of periods) if (!best || quotaShare(p) > quotaShare(best)) best = p;
  return best;
}

// The model per person, group and role (lib/ai/model-policy.ts): which
// model of the instance's provider a person's AI uses instead of the
// instance's default. On a person, model '' means the instance's default
// (whatever their groups say). `kind`: the provider kind the rule was
// chosen for – a rule for another kind than the instance's provider is
// inactive.
export const MODEL_RULE_SCOPES = ["role", "group", "user"] as const;
export type ModelRuleScope = (typeof MODEL_RULE_SCOPES)[number];
export type ModelRule = { scope: ModelRuleScope; target: string; model: string; kind: string };
// What applies to a person: the model, which level set it ('instance': the
// instance's default, no rule) and the instance's default for comparison.
export type ModelPolicy = { model: string; source: "user" | "group" | "role" | "instance"; target: string | null; default: string };
