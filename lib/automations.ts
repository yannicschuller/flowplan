// Workflow rules and automations: run on the server after a record was
// created or changed, inside the same transaction. A workflow violation
// throws and so undoes the change; automations add their changes in one
// pass (their own changes do not trigger further automations, so rules
// cannot loop). Overdue rules are checked by a background tick.
import { assertContactWritable } from "./contacts";
import { all, id, one, run, transaction, nowText } from "./db";
import { HttpError } from "./auth";
import { pageRole } from "./permissions";
import { hiddenRowIds } from "./row-access";
import { cellText } from "./cell-text";
import { Temporal } from "./date-values";
import { computedCells } from "./database";
import { matchesFilterGroup } from "./database-filters";
import { databaseSettings } from "./database-settings";
import { doneRule, isDone, type Automation, type AutomationAction, type DatabaseSettings } from "./database-settings-schema";
import { createsCycle, parentField } from "./subtasks";
import { groupKey, groupingField } from "./database-groups";
import type { Field, Identity, Page, Row, View } from "./types";
import { latestSlot } from "./automation-schedule";
import { spawnNextRecord } from "./repeat-records";
import { emitWebhook } from "./webhooks";
import { runInlineWorkflows, runRuleAutomations, runScheduledRule } from "./workflows/inline";
import { recordWorkflowEvents } from "./workflows/hooks";
import { queueIssuePush } from "./issue-sync-queue";
import { isLeader } from "./cluster/leader";

type Cells = Record<string, unknown>;
type Event = "created" | "form" | "updated" | "overdue";

const empty = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length);
const text = (v: unknown) => (typeof v === "boolean" ? String(v) : cellText(v));
const today = () => new Date().toISOString().slice(0, 10);

/* ---------- Workflow ---------- */

// `user` null: a guest (never an owner); "system": the Git connection.
export async function checkWorkflow(user: Identity | null | "system", page: Page, fields: Field[], settings: DatabaseSettings, before: Cells, after: Cells) {
  const flow = settings.workflow;
  if (!flow) return;
  const field = fields.find((f) => f.id === flow.field);
  if (!field) return;
  const from = text(before[field.id]),
    to = text(after[field.id]);
  if (from === to) return;
  const allowed = flow.transitions[from];
  if (allowed && to && !allowed.includes(to))
    throw new HttpError(400, `Von „${from || "–"}“ nach „${to}“ ist im Workflow nicht vorgesehen.`);
  const missing = (flow.required[to] || [])
    .map((fid) => fields.find((f) => f.id === fid))
    .filter((f): f is Field => !!f && empty(after[f.id]));
  if (missing.length) throw new HttpError(400, `„${to}“ braucht: ${missing.map((f) => f.name).join(", ")}.`);
  if (to && flow.ownersOnly.includes(to) && user !== "system" && (!user || (await pageRole(user, page)) !== "owner"))
    throw new HttpError(403, `„${to}“ dürfen nur Verantwortliche der Datenbank setzen.`);
}

/* ---------- Subtasks ---------- */

// A record cannot sit below itself, directly or further down.
async function checkParent(page: Page, rowId: string, fields: Field[], before: Cells, after: Cells) {
  const field = parentField(fields);
  if (!field) return;
  const next = Array.isArray(after[field.id]) ? (after[field.id] as string[])[0] : undefined;
  if (!next || text(before[field.id]) === text(after[field.id])) return;
  const parentOf = async (id: string) => {
    const r = await one<{ cells: string }>("SELECT cells FROM rows WHERE id=? AND page_id=?", id, page.id);
    const v = r ? JSON.parse(r.cells)[field.id] : null;
    return Array.isArray(v) && typeof v[0] === "string" ? v[0] : null;
  };
  if (next === rowId || await createsCycle(rowId, next, parentOf))
    throw new HttpError(400, "Ein Eintrag kann nicht unter sich selbst oder seinen Unteraufgaben stehen.");
}

/* ---------- WIP limits ---------- */

// A board column with a locked limit takes no further records, however the
// record gets there (board, table, record view, automations of others).
async function checkWipLimits(page: Page, fields: Field[], before: Cells, after: Cells) {
  const raw = await one<{ views: string }>("SELECT views FROM databases WHERE page_id=?", page.id);
  const views = JSON.parse(raw?.views || "[]") as View[];
  for (const view of views) {
    if (view.type !== "board" || !view.wip) continue;
    const field = groupingField(fields, view);
    if (!field || text(before[field.id]) === text(after[field.id])) continue;
    const values = Array.isArray(after[field.id]) ? (after[field.id] as unknown[]) : [after[field.id]];
    const old = new Set((Array.isArray(before[field.id]) ? (before[field.id] as unknown[]) : [before[field.id]]).map(groupKey));
    for (const value of values) {
      const key = groupKey(value);
      const limit = view.wip[key];
      if (!limit?.lock || old.has(key)) continue;
      const count = (await all<{ cells: string }>("SELECT cells FROM rows WHERE page_id=?", page.id)).filter((r) => {
        const v = JSON.parse(r.cells)[field.id];
        return (Array.isArray(v) ? v : [v]).some((x) => groupKey(x) === key);
      }).length;
      if (count > limit.max) throw new HttpError(409, `„${text(value)}“ ist voll (höchstens ${limit.max}).`);
    }
  }
}

/* ---------- Automations ---------- */

// Runs the automations of a database for one record. Each rule is a small
// workflow graph run by the workflow engine's immediate part
// (lib/workflows/inline.ts, docs/specs/workflows.md §2) – with the same
// results as always: the "set" values of all rules in one update, their
// own changes trigger no further rules, templates last.
export async function runAutomations(input: { page: Page; rowId: string; actor: Identity | null; event: Event; before?: Cells | null; only?: string }) {
  return await runRuleAutomations(input);
}

/* ---------- Status history (burndown, velocity) ---------- */

// When a record became done or open again, for sprint charts, and who did
// it (schema 96, "Nur meine" below a journal day, lib/journal-completed.ts):
// the acting person; for an automation the person who set the rule up;
// null for share links, the Git connection and rules nobody set up. An
// account that no longer exists counts as nobody.
export async function recordStatusChange(pageId: string, rowId: string, fields: Field[], settings: DatabaseSettings, before: Cells, after: Cells, userId: string | null = null) {
  const rule = doneRule(fields, settings);
  if (!rule) return;
  const was = isDone(rule, before),
    now = isDone(rule, after);
  if (was === now) return;
  const by = userId && (await one<{ id: string }>("SELECT id FROM users WHERE id=?", userId)) ? userId : null;
  await run("INSERT INTO row_status_log(id,page_id,row_id,done,at,user_id) VALUES(?,?,?,?,?,?)", id(), pageId, rowId, now ? 1 : 0, Date.now(), by);
}

/* ---------- Hooks for every write path ---------- */

// After a record's properties changed: workflow first (throws), then
// automations. `user` is null for guests and the Git connection.
export async function rowChanged(user: Identity | null | "system", page: Page, rowId: string, before: Cells, after: Cells, fields?: Field[]) {
  const settings = await databaseSettings(page.id);
  const props = fields || (JSON.parse((await one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", page.id))!.fields) as Field[]);
  // Properties an LDAP directory keeps stay as it says (lib/contacts.ts).
  if (user !== "system") await assertContactWritable(page.id, rowId, before, after);
  await checkParent(page, rowId, props, before, after);
  await checkWipLimits(page, props, before, after);
  await checkWorkflow(user, page, props, settings, before, after);
  await recordStatusChange(page.id, rowId, props, settings, before, after, user && user !== "system" ? user.id : null);
  // Webhooks: "record done" when it just became done.
  const rule = doneRule(props, settings);
  const done = !!rule && isDone(rule, after) && !isDone(rule, before);
  if (done)
    await emitWebhook(page.workspace_id, "row.done", { pageId: page.id, rowId, cells: after }, user && user !== "system" ? user.name : null);
  // Workflows (#168): the event into the outbox, then the immediate parts.
  await recordWorkflowEvents({ page, rowId, actor: user === "system" ? null : user, event: "updated", before, after, done });
  await runAutomations({ page, rowId, actor: user === "system" ? null : user, event: "updated", before });
  await runInlineWorkflows({ page, rowId, actor: user === "system" ? null : user, event: "updated", before, after, done });
  // A repeating record that became done gets its successor.
  const actor = user === "system" ? null : user;
  const next = await spawnNextRecord(actor, page.id, rowId, props, settings, before, after);
  if (next) await rowCreatedRules(actor, page, next);
  // The issue sync (lib/issue-sync.ts) pushes the change.
  await queueIssuePush(page.id, rowId);
}
export async function rowCreated(user: Identity | null, page: Page, rowId: string, viaForm = false) {
  await recordWorkflowEvents({ page, rowId, actor: user, event: viaForm ? "form" : "created" });
  await runAutomations({ page, rowId, actor: user, event: viaForm ? "form" : "created" });
  await runInlineWorkflows({ page, rowId, actor: user, event: viaForm ? "form" : "created" });
  await queueIssuePush(page.id, rowId);
}

// A follow-up record (repeating records): rules and workflows as for a new one.
async function rowCreatedRules(actor: Identity | null, page: Page, rowId: string) {
  await recordWorkflowEvents({ page, rowId, actor, event: "created" });
  await runAutomations({ page, rowId, actor, event: "created" });
  await runInlineWorkflows({ page, rowId, actor, event: "created" });
}

/* ---------- Overdue ---------- */

// Fires overdue rules once per record and due date.
export async function processOverdueAutomations() {
  const databases = await all<{ page_id: string }>(
    "SELECT d.page_id FROM databases d JOIN pages p ON p.id=d.page_id WHERE p.deleted_at IS NULL AND d.settings LIKE '%\"overdue\"%'",
  );
  let fired = 0;
  const day = today();
  for (const { page_id } of databases) {
    const page = (await one<Page>("SELECT * FROM pages WHERE id=?", page_id))!;
    const settings = await databaseSettings(page_id);
    const fields = JSON.parse((await one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", page_id))!.fields) as Field[];
    const rule = doneRule(fields, settings);
    for (const a of settings.automations || []) {
      if (!a.enabled || a.trigger.type !== "overdue") continue;
      const fieldId = a.trigger.field;
      for (const raw of await all<{ id: string; cells: string }>("SELECT id,cells FROM rows WHERE page_id=?", page_id)) {
        const cells = JSON.parse(raw.cells) as Cells;
        const due = cells[fieldId];
        if (typeof due !== "string" || due.slice(0, 10) >= day || isDone(rule, cells)) continue;
        const key = due.slice(0, 10);
        const fresh = await run(
          "INSERT INTO automation_runs(automation_id,row_id,key,at) VALUES(?,?,?,?) ON CONFLICT DO NOTHING",
          a.id,
          raw.id,
          key,
          Date.now(),
        );
        if (!fresh.changes) continue;
        fired += (await runAutomations({ page, rowId: raw.id, actor: null, event: "overdue", only: a.id }));
      }
    }
  }
  return fired;
}

/* ---------- Scheduled rules ---------- */

// Creates the records of scheduled rules whose time has come, once per
// rule and scheduled time (automation_runs). A rule acts for the person who
// set it up and only while they may still edit the database.
export async function processScheduledAutomations(now = Date.now()) {
  const databases = await all<{ page_id: string }>(
    "SELECT d.page_id FROM databases d JOIN pages p ON p.id=d.page_id WHERE p.deleted_at IS NULL AND d.settings LIKE '%\"schedule\"%'",
  );
  let created = 0;
  for (const { page_id } of databases) {
    const page = (await one<Page>("SELECT * FROM pages WHERE id=?", page_id))!;
    const settings = await databaseSettings(page_id);
    for (const a of settings.automations || []) {
      if (!a.enabled || a.trigger.type !== "schedule" || !a.createdBy || !a.since) continue;
      const slot = latestSlot(a.trigger, a.since, now);
      if (!slot) continue;
      const member = await one<Identity>("SELECT * FROM users WHERE id=? AND disabled=0", a.createdBy);
      const who = member ? ({ ...member, groups: [], isAdmin: false } as Identity) : null;
      const role = who && await pageRole(who, page);
      if (!who || !role || role === "viewer" || page.locked) continue;
      const fresh = await run(
        "INSERT INTO automation_runs(automation_id,row_id,key,at) VALUES(?,?,?,?) ON CONFLICT DO NOTHING",
        a.id,
        "@schedule",
        slot.key,
        now,
      );
      if (!fresh.changes) continue;
      // The rule's graph, run for its creator (lib/workflows/inline.ts).
      const counter = { n: created, ids: [] as string[] };
      for (const rid of await runScheduledRule(a, page, who, slot, counter)) {
        await runAutomations({ page, rowId: rid, actor: who, event: "created" });
        created++;
      }
    }
  }
  return created;
}

const runtime = globalThis as typeof globalThis & { flowplanAutomationTimer?: ReturnType<typeof setInterval> };
export function startAutomationWorker(onFired: () => void) {
  if (runtime.flowplanAutomationTimer) return;
  const tick = async () => {
    // Cluster mode: the leader only (lib/cluster/leader.ts).
    if (!isLeader()) return;
    try {
      if (await transactionalOverdue()) onFired();
      if (await transaction(async () => await processScheduledAutomations())) onFired();
    } catch (error) {
      console.error("Automations failed", error);
    }
  };
  runtime.flowplanAutomationTimer = setInterval(tick, 5 * 60_000);
  runtime.flowplanAutomationTimer.unref();
  setTimeout(tick, 20_000).unref();
}
const transactionalOverdue = async () => await transaction(async () => await processOverdueAutomations());
