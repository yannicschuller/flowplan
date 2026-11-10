// Logic nodes (docs/specs/workflows.md §6.3): If, Set values, Stop.
import { matches } from "../../database-filters";
import { isFormattedText } from "../../inline-markdown";
import type { Field, Filter } from "../../types";
import type { WorkflowCondition, WorkflowConditionGroup } from "../catalog";
import { conditionField } from "../legacy";
import { isEmpty, renderCompare, renderText, renderValue, type RenderScope } from "../placeholders";
import { compareNumberText, toNumber } from "../values";
import { databaseFields, personValue, refId } from "./data";
import { dryRun, FAR, StepError, type NodeImpl, type NodeRun } from "./types";
import { id, one, run } from "../../db";
import { isGuest, memberRole, pageRole } from "../../permissions";
import { Temporal } from "../../date-values";
import { durationMs } from "../catalog";
import { lower, workflowLimits } from "../limits";
import { runnerIdentity } from "../runner";
import { opsNotify } from "../notices";

const DATE = /^\d{4}-\d{2}-\d{2}/;
function inferredType(value: unknown): Field["type"] {
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "checkbox";
  if (Array.isArray(value)) return "multiselect";
  if (typeof value === "string" && DATE.test(value) && Number.isFinite(Date.parse(value))) return "date";
  return "text";
}
const cellOf = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(cellOf);
  if (value && typeof value === "object") {
    const o = value as { title?: unknown; name?: unknown; id?: unknown };
    return typeof o.title === "string" ? o.title : typeof o.name === "string" ? o.name : typeof o.id === "string" ? o.id : JSON.stringify(value);
  }
  return value;
};

// Evaluates a condition group with the operators of the database filters
// (lib/database-filters.ts): a condition on a property of a record before
// this node compares like a view filter on that property (computed values,
// formatted text, time zones); any other left side is compared as a value
// of its own type. And/or as matchesFilterGroup() does it.
const conditionCount = (g: WorkflowConditionGroup): number => g.rules.reduce((n, r) => n + (r.kind === "group" ? conditionCount(r) : 1), 0);
export async function evaluateConditions(group: WorkflowConditionGroup, scope: RenderScope, timeZone: string): Promise<boolean> {
  const fieldCache = new Map<string, Field[]>();
  const now = new Date();
  const test = async (c: WorkflowCondition): Promise<boolean> => {
    const text = (v: string | undefined) => (v === undefined ? undefined : compareNumberText(c.op, renderCompare(v, scope)));
    const filter = {
      kind: "condition",
      field: "x",
      op: c.op,
      value: text(c.value) ?? "",
      ...(c.values ? { values: c.values.map((v) => renderCompare(v, scope)) } : {}),
      ...(c.to !== undefined ? { to: text(c.to) } : {}),
      ...(c.timeZone || ["in_relative", "not_in_relative"].includes(c.op) ? { timeZone: c.timeZone || timeZone } : {}),
      ...(c.days !== undefined ? { days: c.days } : {}),
    } as Filter & { kind: "condition" };
    const target = conditionField(c.left);
    const record = target ? (scope.values[target.node] as { record?: { fields?: Record<string, unknown>; database?: { id: string } } } | undefined)?.record : undefined;
    // Sample data of a dry run has no real database behind it: compared as a value.
    if (target && typeof record?.database?.id === "string") {
      const dbFields = fieldCache.get(record.database.id) ?? (await databaseFields(record.database.id));
      fieldCache.set(record.database.id, dbFields);
      const field = dbFields.find((f) => f.id === target.field);
      // A deleted property: no match, as in a view.
      if (!field) return false;
      return matches({ x: record.fields?.[target.field] }, filter, { ...field, id: "x" }, now, isFormattedText(field, dbFields));
    }
    let value = cellOf(renderValue(c.left, scope));
    let type = inferredType(value);
    if (typeof value === "string" && ["gt", "gte", "lt", "lte"].includes(c.op) && toNumber(value) !== null) {
      value = toNumber(value);
      type = "number";
    }
    return matches({ x: value }, filter, { id: "x", name: "x", type }, now);
  };
  const evaluate = async (g: WorkflowConditionGroup): Promise<boolean> => {
    const results: boolean[] = [];
    let counted = 0;
    for (const rule of g.rules) {
      if (rule.kind === "group") {
        if (!conditionCount(rule)) continue;
        counted++;
        results.push(await evaluate(rule));
      } else {
        counted++;
        results.push(await test(rule));
      }
    }
    if (!counted) return true;
    return g.join === "or" ? results.some(Boolean) : results.every(Boolean);
  };
  return await evaluate(group);
}

export const logicIf: NodeImpl = async (ctx: NodeRun) => {
  const matched = await evaluateConditions(ctx.config.condition as WorkflowConditionGroup, ctx.scope, ctx.scope.timeZone);
  return { port: matched ? "true" : "false", output: { matched } };
};

export const logicSet: NodeImpl = async (ctx) => {
  const out: Record<string, unknown> = {};
  for (const v of (ctx.config.values as { name: string; value: string; type: string }[]) || []) {
    const raw = renderValue(v.value, ctx.scope);
    out[v.name] =
      v.type === "text"
        ? renderText(v.value, ctx.scope)
        : v.type === "number"
          ? toNumber(raw)
          : v.type === "boolean"
            ? typeof raw === "boolean"
              ? raw
              : /^(true|1|ja|yes)$/i.test(String(raw ?? "").trim())
            : v.type === "date"
              ? isEmpty(raw)
                ? null
                : String(raw).slice(0, 10)
              : v.type === "list"
                ? Array.isArray(raw)
                  ? raw
                  : isEmpty(raw)
                    ? []
                    : [raw]
                : raw;
  }
  return { port: "out", output: out };
};

export const logicStop: NodeImpl = async (ctx) => ({
  stop: ctx.config.result === "failed" ? "failed" : "succeeded",
  message: renderText(String(ctx.config.message || ""), ctx.scope).slice(0, 500),
});

/* ---------- Wave 2: switch, for each, wait, approval ---------- */

// The first case whose condition holds; else "default" (§6.3).
export const logicSwitch: NodeImpl = async (ctx) => {
  const c = ctx.config as { value: string; cases: { id: string; label: string; op: WorkflowCondition["op"]; value: string }[] };
  for (const kase of c.cases || []) {
    const group: WorkflowConditionGroup = { kind: "group", join: "and", rules: [{ kind: "condition", left: c.value, op: kase.op, value: kase.value }] };
    if (await evaluateConditions(group, ctx.scope, ctx.scope.timeZone)) return { port: `case:${kase.id}`, output: { case: kase.label || kase.value } };
  }
  return { port: "default", output: { case: null } };
};

// The list a loop runs over, shortened to the limit (§6.3, §8.7).
export const logicForeach: NodeImpl = async (ctx) => {
  const c = ctx.config as { list: string; limit: number };
  const raw = renderValue(c.list, ctx.scope);
  const items = Array.isArray(raw) ? raw : isEmpty(raw) ? [] : [raw];
  const max = lower((await workflowLimits()).foreachMax, c.limit);
  if (items.length > max) {
    const warning = `Gekürzt auf ${max} Elemente (von ${items.length}).`;
    ctx.warn(warning);
    return { loop: items.slice(0, max), warning };
  }
  return { loop: items };
};

const zoned = (ms: number, zone: string) => {
  try {
    return Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(zone);
  } catch {
    return Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO("UTC");
  }
};
const atTime = (date: Temporal.PlainDate, time: string, zone: string) => {
  const [h, m] = time.split(":").map(Number);
  return date.toPlainDateTime({ hour: h, minute: m }).toZonedDateTime(zone).epochMilliseconds;
};
// Where a wait ends (§6.3, §8.7): durations of days count in the
// workflow's time zone (a day is a calendar day across daylight saving),
// minutes and hours in real time; "until" a date (at a time of day) or a
// moment; "next" the next time of day, on working days if asked.
export function waitTarget(c: { mode: string; amount: number; unit: string; until?: string; time?: string; weekdays?: boolean }, value: unknown, zone: string, now = Date.now()): number {
  if (c.mode === "duration") {
    if (c.unit === "days") return zoned(now, zone).add({ days: c.amount }).epochMilliseconds;
    return now + durationMs(c);
  }
  if (c.mode === "next") {
    const time = c.time || "09:00";
    let day = zoned(now, zone).toPlainDate();
    for (let i = 0; i < 10; i++, day = day.add({ days: 1 })) {
      if (c.weekdays && day.dayOfWeek > 5) continue;
      const at = atTime(day, time, zone);
      if (at > now) return at;
    }
    throw new StepError("Keine nächste Uhrzeit gefunden.", "validation");
  }
  const text = typeof value === "string" ? value.trim() : value && typeof value === "object" && typeof (value as { date?: unknown }).date === "string" ? String((value as { date: string }).date) : "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return atTime(Temporal.PlainDate.from(text), c.time || "00:00", zone);
  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) {
    let instant: Temporal.Instant;
    try {
      instant = /(?:Z|[+-]\d{2}:\d{2})$/.test(text) ? Temporal.Instant.from(text) : Temporal.PlainDateTime.from(text).toZonedDateTime(zone).toInstant();
    } catch {
      throw new StepError(`„${text.slice(0, 60)}“ ist kein Zeitpunkt.`, "validation");
    }
    if (c.time) return atTime(instant.toZonedDateTimeISO(zone).toPlainDate(), c.time, zone);
    return instant.epochMilliseconds;
  }
  throw new StepError(`„${text.slice(0, 60) || "(leer)"}“ ist kein Datum.`, "validation");
}

export const logicWait: NodeImpl = async (ctx) => {
  const resumed = ctx.resume as { $wait?: boolean; until?: number } | undefined;
  if (resumed?.$wait && typeof resumed.until === "number") {
    if (resumed.until > Date.now()) return { wait: resumed.until, state: resumed };
    return { port: "out", output: { waitedUntil: new Date(resumed.until).toISOString() } };
  }
  const c = ctx.config as { mode: string; amount: number; unit: string; until: string; time?: string; weekdays: boolean };
  const now = Date.now();
  const until = waitTarget(c, c.mode === "until" ? renderValue(c.until, ctx.scope) : null, ctx.scope.timeZone, now);
  const maxDays = (await workflowLimits()).maxWaitDays;
  if (until - now > maxDays * 86_400_000) throw new StepError(`Länger als ${maxDays} Tage warten geht nicht.`, "validation");
  // The target already passed: on at once. Dry runs do not wait.
  if (until <= now || dryRun(ctx)) return { port: "out", output: { waitedUntil: new Date(Math.max(until, 0)).toISOString(), ...(dryRun(ctx) && until > now ? { skipped: true } : {}) } };
  return { wait: until, state: { $wait: true, until } };
};

// Who may decide an approval: the ids, "@runner", "@actor", "@creator",
// "field:<id>" of the triggering record or placeholders on people – of
// them only full members (no guests) who may see the workflow page (§8.7).
export async function approversOf(ctx: NodeRun, entries: string[]): Promise<string[]> {
  const trigger = ctx.scope.values[ctx.run.triggerNodeId] as { record?: { fields?: Record<string, unknown>; createdBy?: { id: string } } } | undefined;
  const ids: string[] = [];
  for (const entry of entries) {
    if (entry === "@runner") ctx.runner && ids.push(ctx.runner.id);
    else if (entry === "@actor") ctx.actor && ids.push(ctx.actor.id);
    else if (entry === "@creator") trigger?.record?.createdBy?.id && ids.push(trigger.record.createdBy.id);
    else if (entry.startsWith("field:")) {
      const v = trigger?.record?.fields?.[entry.slice(6)];
      for (const x of Array.isArray(v) ? v : [v]) {
        const uid = refId(x);
        if (uid) ids.push(uid);
      }
    } else if (entry.includes("{{")) {
      const v = renderValue(entry, ctx.scope);
      for (const x of Array.isArray(v) ? v : [v]) {
        const uid = refId(x);
        if (uid) ids.push(uid);
      }
    } else if (entry.trim()) ids.push(entry.trim());
  }
  const out: string[] = [];
  for (const uid of [...new Set(ids)].slice(0, 50)) {
    const who = await runnerIdentity(uid);
    if (!who || !ctx.workflowPage) continue;
    if (!(await memberRole(who, ctx.run.workspaceId)) || (await isGuest(who, ctx.run.workspaceId))) continue;
    if (!(await pageRole(who, ctx.workflowPage))) continue;
    out.push(uid);
  }
  return out;
}

type ApprovalRow = { id: string; decision: string | null; decided_by: string | null; comment: string; decided_at: number | null; expires_at: number | null };
// The port and output of a decided approval.
export async function approvalResult(a: ApprovalRow, onTimeout: string, workspaceId: string) {
  const decision = a.decision === "timeout" && onTimeout === "rejected" ? "rejected" : a.decision;
  return {
    port: decision === "approved" ? "approved" : decision === "timeout" ? "timeout" : "rejected",
    output: { decision: a.decision, decidedBy: await personValue(a.decided_by, workspaceId), comment: a.comment || "", decidedAt: a.decided_at ? new Date(a.decided_at).toISOString() : null },
  };
}

export const logicApproval: NodeImpl = async (ctx) => {
  const c = ctx.config as { approvers: string[]; message: string; deadline?: { amount: number; unit: string }; onTimeout: string };
  const resumed = ctx.resume as { $wait?: boolean; approvalId?: string } | undefined;
  if (resumed?.$wait && resumed.approvalId) {
    let a = await one<ApprovalRow>("SELECT * FROM workflow_approvals WHERE id=?", resumed.approvalId);
    if (!a) throw new StepError("Die Freigabe gibt es nicht mehr.", "validation");
    if (!a.decision && a.expires_at && a.expires_at <= Date.now()) {
      // The deadline passed: "timeout" – unless someone decided first.
      await run("UPDATE workflow_approvals SET decision='timeout',decided_at=? WHERE id=? AND decision IS NULL", Date.now(), a.id);
      a = (await one<ApprovalRow>("SELECT * FROM workflow_approvals WHERE id=?", a.id))!;
    }
    if (!a.decision) return { wait: a.expires_at ?? FAR, state: resumed };
    if (a.decision === "cancelled") throw new StepError("Die Freigabe wurde abgebrochen.", "validation");
    return await approvalResult(a, c.onTimeout, ctx.run.workspaceId);
  }
  // Dry runs assume a decision (§10.3).
  if (dryRun(ctx)) {
    const assumed = ctx.options?.approval === "rejected" ? "rejected" : "approved";
    return { port: assumed, output: { decision: assumed, assumed: true, decidedBy: null, comment: "", decidedAt: new Date().toISOString() } };
  }
  const approvers = await approversOf(ctx, c.approvers || []);
  if (!approvers.length) throw new StepError("Keine gültige freigebende Person.", "validation");
  if (!ctx.stepId || !ctx.workflowPage) throw new StepError("Freigaben laufen nicht im Sofortteil.", "validation");
  const message = renderText(c.message || "", ctx.scope).trim().slice(0, 2000);
  const maxDays = (await workflowLimits()).maxWaitDays;
  const expires = c.deadline ? Date.now() + Math.min(durationMs(c.deadline), maxDays * 86_400_000) : null;
  // A retried step asks again (its earlier approval was cancelled with the failure).
  const existing = await one<{ id: string }>("SELECT id FROM workflow_approvals WHERE step_id=?", ctx.stepId);
  const approvalId = existing?.id ?? id();
  if (existing)
    await run("UPDATE workflow_approvals SET approvers=?,message=?,decision=NULL,decided_by=NULL,comment='',decided_at=NULL,expires_at=?,created_at=? WHERE id=?", JSON.stringify(approvers), message, expires, Date.now(), approvalId);
  else
    await run(
      "INSERT INTO workflow_approvals(id,step_id,run_id,page_id,approvers,message,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?)",
      approvalId,
      ctx.stepId,
      ctx.run.id,
      ctx.workflowPage.id,
      JSON.stringify(approvers),
      message,
      expires,
      Date.now(),
    );
  const title = ctx.workflowPage.title || "Workflow";
  await opsNotify(approvers, ctx.workflowPage.id, (tr) => tr(`Freigabe erbeten – ${title}: ${message || "Bitte genehmigen oder ablehnen."}`, `Approval requested – ${title}: ${message || "Please approve or reject."}`), null, approvalId);
  return { wait: expires ?? FAR, state: { $wait: true, approvalId, approvers } };
};
