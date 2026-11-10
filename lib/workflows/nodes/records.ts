// Record actions (docs/specs/workflows.md §6.2): create, update, find,
// apply a template. Outside the immediate part every write goes through
// command() as the person the run runs as – rights, locks, property rules,
// versions, webhooks and the immediate parts of other rules apply as for a
// click in the browser. In the immediate part (and for the database rules)
// writes on the triggering record are collected (lib/workflows/inline.ts).
import { all, id, one, run, nowText } from "../../db";
import { requirePage } from "../../permissions";
import { visibleRows } from "../../row-access";
import { unwritableFieldIds } from "../../field-access";
import { computedCells } from "../../database";
import { matches } from "../../database-filters";
import { isFormattedText } from "../../inline-markdown";
import { cellText } from "../../cell-text";
import { replaceRowDocument, type RowTemplate } from "../../row-documents";
import { applyTemplate, auditApply, fillNewRecord } from "../../record-template-apply";
import { recordStatusChange } from "../../automations";
import { databaseSettings } from "../../database-settings";
import type { Field, Filter, Identity, Page, Row } from "../../types";
import type { WorkflowCondition, WorkflowConditionGroup } from "../catalog";
import { hasPlaceholders, isEmpty, renderCompare, renderValue } from "../placeholders";
import { coerceToField, compareNumberText } from "../values";
import { databaseFields, recordValue, refId } from "./data";
import { dryRun, StepError, type NodeImpl, type NodeRun } from "./types";

type Cells = Record<string, unknown>;
const today = () => new Date().toISOString().slice(0, 10);

// The special values of the database rules, valid in workflows too.
function specialValue(v: unknown, field: Field, ctx: NodeRun, createdBy: string | null): { value: unknown } | null {
  if (v === "@today") return { value: today() };
  if (v === "@now") return { value: new Date().toISOString().slice(0, 16) + "Z" };
  if (v === "@actor") return { value: ctx.actor?.id ?? null };
  if (v === "@creator") return { value: createdBy || null };
  if (v === "@runner") return { value: ctx.runner?.id ?? null };
  if (v === "@clear") return { value: field.type === "checkbox" ? false : field.type === "multiselect" || field.type === "aliases" ? [] : "" };
  return null;
}
// The cell value of one configured value: special values, placeholders
// (typed when the whole value is one), fixed values. Database rules keep
// their values exactly as stored.
function cellValue(raw: unknown, field: Field, ctx: NodeRun, createdBy: string | null): unknown {
  const special = specialValue(raw, field, ctx, createdBy);
  if (special) return special.value;
  if (ctx.legacy && !(typeof raw === "string" && hasPlaceholders(raw))) return raw;
  if (typeof raw === "string") {
    if (!hasPlaceholders(raw) && ["text", "url", "email", "phone"].includes(field.type)) return raw.replace(/\\\{\{/g, "{{").replace(/\\\\/g, "\\");
    try {
      return coerceToField(renderValue(raw, ctx.scope), field, ctx.scope.locale, ctx.scope.timeZone);
    } catch (e) {
      throw new StepError((e as Error).message, "validation");
    }
  }
  try {
    return raw === null || typeof raw === "boolean" || typeof raw === "number" || Array.isArray(raw) ? coerceToField(raw, field, ctx.scope.locale, ctx.scope.timeZone) : raw;
  } catch (e) {
    throw new StepError((e as Error).message, "validation");
  }
}
async function cellsFor(values: Record<string, unknown>, fields: Field[], ctx: NodeRun, createdBy: string | null) {
  const out: Cells = {};
  for (const [fieldId, raw] of Object.entries(values || {})) {
    const field = fields.find((f) => f.id === fieldId);
    if (!field) {
      // Deleted after activation: left out, with a warning (§7.1).
      ctx.warn(`Die Eigenschaft ${fieldId} gibt es nicht mehr.`);
      continue;
    }
    out[field.id] = cellValue(raw, field, ctx, createdBy);
  }
  return out;
}

async function databasePage(ctx: NodeRun, databaseId: string, write: boolean): Promise<Page> {
  if (!ctx.runner) throw new StepError("Keine ausführende Person.", "permission");
  const page = await requirePage(ctx.runner, databaseId, write).catch((e) => {
    throw new StepError((e as Error).message, (e as { status?: number }).status === 404 ? "validation" : "permission");
  });
  if (page.kind !== "database") throw new StepError("Keine Datenbank.", "validation");
  return page;
}
// The record a node acts on: the triggering one, or a placeholder/id.
async function targetRecord(ctx: NodeRun, ref: unknown) {
  const raw = typeof ref === "string" && ref.trim() ? renderValue(ref, ctx.scope) : null;
  const rowId = raw === null ? ctx.trigger.rowId : refId(raw);
  if (!rowId) throw new StepError(raw === null ? "Kein auslösender Eintrag." : "Kein Eintrag angegeben.", "validation");
  const row = await one<{ id: string; page_id: string; version: number; cells: string; created_by: string | null }>("SELECT id,page_id,version,cells,created_by FROM rows WHERE id=?", rowId);
  if (!row) throw new StepError("Den Eintrag gibt es nicht (mehr).", "validation");
  return row;
}
// Who a write on the triggering record counts as in the status log.
const setter = (ctx: NodeRun) => (ctx.legacy ? ctx.legacy.createdBy : ctx.runner?.id ?? null);
const isTriggerRecord = (ctx: NodeRun, ref: unknown) => !(typeof ref === "string" && ref.trim()) && !!ctx.inline && ctx.inline.rowId === ctx.trigger.rowId;

export const recordUpdate: NodeImpl = async (ctx) => {
  const c = ctx.config as { record?: string; values: Record<string, unknown>; onlyEmpty?: boolean };
  // The immediate part: collected on the triggering record, written once.
  if (isTriggerRecord(ctx, c.record)) {
    const batch = ctx.inline!;
    let values = await cellsFor(c.values, batch.fields, ctx, batch.row.created_by);
    if (!ctx.legacy && ctx.runner) {
      const locked = await unwritableFieldIds(ctx.runner, batch.databasePage, batch.fields);
      const refused = Object.keys(values).filter((k) => locked.has(k));
      if (refused.length) throw new StepError(`Keine Schreibrechte für „${batch.fields.find((f) => f.id === refused[0])?.name}“.`, "permission");
    }
    if (c.onlyEmpty) values = Object.fromEntries(Object.entries(values).filter(([k]) => isEmpty({ ...batch.row.cells, ...batch.patch }[k])));
    const before = Object.fromEntries(Object.keys(values).map((k) => [k, { ...batch.row.cells, ...batch.patch }[k] ?? null]));
    Object.assign(batch.patch, values);
    for (const k of Object.keys(values)) batch.setBy[k] = setter(ctx);
    if (ctx.legacy) return { port: "out", output: { updated: Object.keys(values) } };
    return { port: "out", output: { record: await recordValue(ctx.runner, batch.rowId, batch.patch), before } };
  }
  const row = await targetRecord(ctx, c.record);
  const page = await databasePage(ctx, row.page_id, true);
  const fields = await databaseFields(page.id);
  const current = JSON.parse(row.cells) as Cells;
  let patch = await cellsFor(c.values, fields, ctx, row.created_by);
  if (c.onlyEmpty) patch = Object.fromEntries(Object.entries(patch).filter(([k]) => isEmpty(current[k])));
  const before = Object.fromEntries(Object.keys(patch).map((k) => [k, current[k] ?? null]));
  if (dryRun(ctx)) return { port: "out", output: { wouldUpdate: { record: row.id, cells: patch }, record: await recordValue(ctx.runner, row.id, patch), before } };
  if (Object.keys(patch).length) await asCommand(ctx, { action: "row.update", pageId: page.id, rowId: row.id, version: row.version, cells: patch });
  return { port: "out", output: { record: await recordValue(ctx.runner, row.id), before } };
};

// lib/api.ts is loaded lazily: it imports nearly everything, and this
// module is reached from low-level ones (lib/automations.ts) – a static
// import would make an import cycle that breaks module initialisation. The
// promise starts now, so inside a transaction it is long resolved.
const api = import("../../api");
// A command as the run's person, inside the step's transaction.
export async function asCommand(ctx: NodeRun, body: Record<string, unknown>) {
  if (!ctx.runner) throw new StepError("Keine ausführende Person.", "permission");
  try {
    return await (await api).command(ctx.runner, body, true);
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status === 403 || status === 423) throw new StepError((e as Error).message, "permission");
    if (status && status < 500) throw new StepError((e as Error).message, "validation");
    throw e;
  }
}

export const recordCreate: NodeImpl = async (ctx) => {
  const c = ctx.config as { database: string; values: Record<string, unknown>; template?: string };
  // A scheduled database rule: its old way, for its creator (lib/automations.ts).
  if (ctx.legacy) return await legacyCreate(ctx);
  const page = await databasePage(ctx, c.database, true);
  const fields = await databaseFields(page.id);
  const cells = await cellsFor(c.values, fields, ctx, ctx.runner?.id ?? null);
  if (dryRun(ctx)) return { port: "out", output: { wouldCreate: { database: page.id, cells, template: c.template || null } } };
  const created = (await asCommand(ctx, { action: "row.create", pageId: page.id, cells, ...(c.template ? { templateId: c.template } : {}), timeZone: ctx.scope.timeZone })) as { id: string };
  return { port: "out", output: { record: await recordValue(ctx.runner, created.id) } };
};

// The scheduled rules' record (processScheduledAutomations, unchanged):
// template + fixed values + relative dates, as the rule's creator.
async function legacyCreate(ctx: NodeRun): Promise<{ port: string; output: unknown }> {
  const c = ctx.config as { database: string; values: Record<string, unknown>; template?: string };
  const who = ctx.runner!;
  const page = (await one<Page>("SELECT * FROM pages WHERE id=?", c.database))!;
  const template = c.template ? await one<RowTemplate>("SELECT * FROM row_templates WHERE id=? AND page_id=?", c.template, c.database) : undefined;
  const cells: Cells = { ...(template ? JSON.parse(template.cells) : {}) };
  for (const [fieldId, raw] of Object.entries(c.values || {})) cells[fieldId] = typeof raw === "string" && hasPlaceholders(raw) ? renderValue(raw, ctx.scope) : raw;
  const rid = id();
  await run(
    "INSERT INTO rows(id,page_id,cells,position,created_by,updated_by) VALUES(?,?,?,?,?,?)",
    rid,
    c.database,
    JSON.stringify(cells),
    Date.now() + (ctx.legacy?.created.n ?? 0),
    who.id,
    who.id,
  );
  if (template?.html) await replaceRowDocument(rid, await fillNewRecord({ page, rowId: rid, template, actor: who, zone: ctx.scope.timeZone }), who.id);
  if (ctx.legacy) {
    ctx.legacy.created.n++;
    ctx.legacy.created.ids.push(rid);
  }
  return { port: "out", output: { record: { id: rid }, created: rid } };
}

export const recordTemplate: NodeImpl = async (ctx) => {
  const c = ctx.config as { record?: string; template: string; mode: "empty" | "append" };
  if (isTriggerRecord(ctx, c.record)) {
    const batch = ctx.inline!;
    batch.templates.push({
      key: ctx.legacy ? ctx.legacy.ruleId : `wf:${ctx.run.pageId}:${ctx.node.id}`,
      template: c.template,
      mode: c.mode,
      label: ctx.legacy ? ctx.legacy.ruleName || "Automation" : ctx.workflowPage?.title || "Workflow",
      by: setter(ctx),
    });
    return { port: "out", output: ctx.legacy ? {} : { record: await recordValue(ctx.runner, batch.rowId, batch.patch) } };
  }
  const row = await targetRecord(ctx, c.record);
  const page = await databasePage(ctx, row.page_id, true);
  if (dryRun(ctx)) return { port: "out", output: { wouldApply: { record: row.id, template: c.template, mode: c.mode } } };
  // Once per record and node, like the rules (automation_runs).
  const fresh = await run(
    "INSERT INTO automation_runs(automation_id,row_id,key,at) VALUES(?,?,?,?) ON CONFLICT DO NOTHING",
    `wf:${ctx.run.pageId}:${ctx.node.id}`,
    row.id,
    `template:${c.template}`,
    Date.now(),
  );
  if (fresh.changes) await asCommand(ctx, { action: "row.template.apply", pageId: page.id, rowId: row.id, templateId: c.template, mode: c.mode });
  return { port: "out", output: { record: await recordValue(ctx.runner, row.id) } };
};

// A template on the triggering record, once per rule (or node) and record:
// the rules' applyTemplateOnce, unchanged.
export async function applyTemplateOnce(page: Page, rowId: string, key: string, label: string, templateId: string, mode: "empty" | "append", actor: Identity | null, fields: Field[], by: string | null = null) {
  const settings = await databaseSettings(page.id);
  const template = await one<RowTemplate>("SELECT * FROM row_templates WHERE id=? AND page_id=?", templateId, page.id);
  if (!template) return;
  const fresh = await run("INSERT INTO automation_runs(automation_id,row_id,key,at) VALUES(?,?,?,?) ON CONFLICT DO NOTHING", key, rowId, `template:${templateId}`, Date.now());
  if (!fresh.changes) return;
  const raw = await one<Row & { cells: string }>("SELECT * FROM rows WHERE id=? AND page_id=?", rowId, page.id);
  if (!raw) return;
  const row: Row = { ...raw, cells: JSON.parse(raw.cells) };
  const applied = await applyTemplate({ page, row, template, actor, mode });
  if (Object.keys(applied.cells).length) {
    const next = { ...row.cells, ...applied.cells };
    await run("UPDATE rows SET cells=?,version=version+1,updated_at=? WHERE id=?", JSON.stringify(next), nowText(), row.id);
    await recordStatusChange(page.id, row.id, fields, settings, row.cells, next, by);
  }
  await auditApply(actor?.id || "system", row.id, template, `${label} · ${applied.document}`);
}

// Find: conditions on the database's properties (`left` names a property
// id), values with placeholders; only records the person may see.
export const recordFind: NodeImpl = async (ctx) => {
  const c = ctx.config as { database: string; filter: WorkflowConditionGroup; sort?: { field: string; direction: "asc" | "desc" }; limit: number };
  const page = await databasePage(ctx, c.database, false);
  const fields = await databaseFields(page.id);
  const raws = (await all<Row & { cells: string }>("SELECT * FROM rows WHERE page_id=?", page.id)).map((r) => ({ ...r, cells: JSON.parse(r.cells) as Cells }));
  const visible = await visibleRows(ctx.runner!, page, raws);
  const now = new Date();
  const test = (cells: Cells, g: WorkflowConditionGroup): boolean => {
    const results = g.rules.map((rule) => {
      if (rule.kind === "group") return test(cells, rule);
      const cond = rule as WorkflowCondition;
      const field = fields.find((f) => f.id === cond.left.trim());
      if (!field) return false;
      const filter = {
        kind: "condition",
        field: field.id,
        op: cond.op,
        value: compareNumberText(cond.op, renderCompare(cond.value || "", ctx.scope)),
        ...(cond.values ? { values: cond.values.map((v) => renderCompare(v, ctx.scope)) } : {}),
        ...(cond.to !== undefined ? { to: compareNumberText(cond.op, renderCompare(cond.to, ctx.scope)) } : {}),
        ...(cond.timeZone || ["in_relative", "not_in_relative"].includes(cond.op) ? { timeZone: cond.timeZone || ctx.scope.timeZone } : {}),
        ...(cond.days !== undefined ? { days: cond.days } : {}),
      } as Filter;
      return matches(cells, filter, field, now, isFormattedText(field, fields));
    });
    if (!results.length) return true;
    return g.join === "or" ? results.some(Boolean) : results.every(Boolean);
  };
  const computed = visible.map((r) => {
    const row = r as unknown as Row;
    return { row, cells: computedCells(row, fields) };
  });
  let found = computed.filter((r) => test(r.cells, c.filter || { kind: "group", join: "and", rules: [] }));
  if (c.sort) {
    const f = fields.find((x) => x.id === c.sort!.field);
    const dir = c.sort.direction === "desc" ? -1 : 1;
    if (f)
      found = found.sort((a, b) => {
        const x = a.cells[f.id],
          y = b.cells[f.id];
        if (typeof x === "number" && typeof y === "number") return (x - y) * dir;
        return cellText(x).localeCompare(cellText(y)) * dir;
      });
  }
  const records = [];
  for (const r of found.slice(0, Math.min(100, c.limit || 10))) records.push(await recordValue(ctx.runner, r.row.id));
  return { port: "out", output: { records, first: records[0] ?? null, count: found.length } };
};
