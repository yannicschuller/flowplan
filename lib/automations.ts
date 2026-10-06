// Workflow rules and automations: run on the server after a record was
// created or changed, inside the same transaction. A workflow violation
// throws and so undoes the change; automations add their changes in one
// pass (their own changes do not trigger further automations, so rules
// cannot loop). Overdue rules are checked by a background tick.
import { all, id, one, run, transaction } from "./db";
import { HttpError } from "./auth";
import { pageRole } from "./permissions";
import { hiddenRowIds } from "./row-access";
import { cellText } from "./cell-text";
import { computedCells } from "./database";
import { matchesFilterGroup } from "./database-filters";
import { databaseSettings } from "./database-settings";
import { doneRule, isDone, type Automation, type AutomationAction, type DatabaseSettings } from "./database-settings-schema";
import { createsCycle, parentField } from "./subtasks";
import type { Field, Identity, Page, Row } from "./types";

type Cells = Record<string, unknown>;
type Event = "created" | "form" | "updated" | "overdue";

const empty = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length);
const text = (v: unknown) => (typeof v === "boolean" ? String(v) : cellText(v));
const today = () => new Date().toISOString().slice(0, 10);

/* ---------- Workflow ---------- */

// `user` null: a guest (never an owner); "system": the Git connection.
export function checkWorkflow(user: Identity | null | "system", page: Page, fields: Field[], settings: DatabaseSettings, before: Cells, after: Cells) {
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
  if (to && flow.ownersOnly.includes(to) && user !== "system" && (!user || pageRole(user, page) !== "owner"))
    throw new HttpError(403, `„${to}“ dürfen nur Verantwortliche der Datenbank setzen.`);
}

/* ---------- Subtasks ---------- */

// A record cannot sit below itself, directly or further down.
function checkParent(page: Page, rowId: string, fields: Field[], before: Cells, after: Cells) {
  const field = parentField(fields);
  if (!field) return;
  const next = Array.isArray(after[field.id]) ? (after[field.id] as string[])[0] : undefined;
  if (!next || text(before[field.id]) === text(after[field.id])) return;
  const parentOf = (id: string) => {
    const r = one<{ cells: string }>("SELECT cells FROM rows WHERE id=? AND page_id=?", id, page.id);
    const v = r ? JSON.parse(r.cells)[field.id] : null;
    return Array.isArray(v) && typeof v[0] === "string" ? v[0] : null;
  };
  if (next === rowId || createsCycle(rowId, next, parentOf))
    throw new HttpError(400, "Ein Eintrag kann nicht unter sich selbst oder seinen Unteraufgaben stehen.");
}

/* ---------- Automations ---------- */

function triggered(a: Automation, event: Event, before: Cells | null, after: Cells, fields: Field[]) {
  const t = a.trigger;
  if (t.type === "created") return event === "created" || event === "form";
  if (t.type === "form") return event === "form";
  if (t.type === "overdue") return event === "overdue";
  if (event !== "updated" || !before) return false;
  const field = fields.find((f) => f.id === t.field);
  if (!field || text(before[field.id]) === text(after[field.id])) return false;
  return !t.to || text(after[field.id]) === t.to;
}

function actionValue(action: Extract<AutomationAction, { type: "set" }>, field: Field, actor: Identity | null, row: Row) {
  const v = action.value;
  if (v === "@today") return today();
  if (v === "@now") return new Date().toISOString().slice(0, 16) + "Z";
  if (v === "@actor") return actor?.id ?? null;
  if (v === "@creator") return row.created_by || null;
  if (v === "@clear") return field.type === "checkbox" ? false : field.type === "multiselect" ? [] : "";
  return v;
}

function recipients(to: string, actor: Identity | null, row: Row, cells: Cells) {
  if (to === "@creator") return row.created_by ? [row.created_by] : [];
  if (to === "@actor") return actor ? [actor.id] : [];
  if (to.startsWith("field:")) {
    const value = cells[to.slice(6)];
    return (Array.isArray(value) ? value : [value]).filter((v): v is string => typeof v === "string" && !!v);
  }
  return [to];
}

// Runs the automations of a database for one record.
export function runAutomations(input: { page: Page; rowId: string; actor: Identity | null; event: Event; before?: Cells | null; only?: string }) {
  const settings = databaseSettings(input.page.id);
  const automations = (settings.automations || []).filter((a) => a.enabled && (!input.only || a.id === input.only));
  if (!automations.length) return 0;
  const raw = one<Row & { cells: string }>("SELECT * FROM rows WHERE id=? AND page_id=?", input.rowId, input.page.id);
  if (!raw) return 0;
  const row: Row = { ...raw, cells: JSON.parse(raw.cells) };
  const fields = JSON.parse(one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", input.page.id)!.fields) as Field[];
  const cells = computedCells(row, fields);
  const patch: Cells = {};
  let fired = 0;
  for (const a of automations) {
    if (!triggered(a, input.event, input.before ?? null, row.cells, fields)) continue;
    const group = { kind: "group" as const, join: "and" as const, rules: a.conditions.map((c) => ({ ...c, kind: "condition" as const })) };
    if (a.conditions.length && !matchesFilterGroup(cells, group, fields)) continue;
    fired++;
    for (const action of a.actions) {
      if (action.type === "set") {
        const field = fields.find((f) => f.id === action.field);
        if (field) patch[field.id] = actionValue(action, field, input.actor, row);
      } else notify(action, a, input, row, { ...cells, ...patch }, fields);
    }
  }
  if (Object.keys(patch).length) {
    run(
      "UPDATE rows SET cells=?,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=?",
      JSON.stringify({ ...row.cells, ...patch }),
      row.id,
    );
    recordStatusChange(input.page.id, row.id, fields, settings, row.cells, { ...row.cells, ...patch });
  }
  return fired;
}

function notify(action: Extract<AutomationAction, { type: "notify" }>, a: Automation, input: { page: Page; actor: Identity | null }, row: Row, cells: Cells, fields: Field[]) {
  const title = cellText(cells[fields[0]?.id || "title"]) || "Ohne Titel";
  const body = action.message
    ? `${action.message} – „${title}“`
    : `${a.name || "Automation"}: „${title}“ in „${input.page.title}“`;
  for (const uid of new Set(recipients(action.to, input.actor, row, cells))) {
    const member = one<Identity>("SELECT * FROM users WHERE id=? AND disabled=0", uid);
    if (!member) continue;
    const who = { ...member, groups: [], isAdmin: false } as Identity;
    if (!pageRole(who, input.page) || hiddenRowIds(who, input.page).has(row.id)) continue;
    run(
      "INSERT INTO notifications(id,user_id,body,page_id,row_id,kind) VALUES(?,?,?,?,?,'automation')",
      id(),
      uid,
      body.slice(0, 500),
      input.page.id,
      row.id,
    );
  }
}

/* ---------- Status history (burndown, velocity) ---------- */

// When a record became done or open again, for sprint charts.
export function recordStatusChange(pageId: string, rowId: string, fields: Field[], settings: DatabaseSettings, before: Cells, after: Cells) {
  const rule = doneRule(fields, settings);
  if (!rule) return;
  const was = isDone(rule, before),
    now = isDone(rule, after);
  if (was !== now)
    run("INSERT INTO row_status_log(id,page_id,row_id,done,at) VALUES(?,?,?,?,?)", id(), pageId, rowId, now ? 1 : 0, Date.now());
}

/* ---------- Hooks for every write path ---------- */

// After a record's properties changed: workflow first (throws), then
// automations. `user` is null for guests and the Git connection.
export function rowChanged(user: Identity | null | "system", page: Page, rowId: string, before: Cells, after: Cells, fields?: Field[]) {
  const settings = databaseSettings(page.id);
  const props = fields || (JSON.parse(one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", page.id)!.fields) as Field[]);
  checkParent(page, rowId, props, before, after);
  checkWorkflow(user, page, props, settings, before, after);
  recordStatusChange(page.id, rowId, props, settings, before, after);
  runAutomations({ page, rowId, actor: user === "system" ? null : user, event: "updated", before });
}
export function rowCreated(user: Identity | null, page: Page, rowId: string, viaForm = false) {
  runAutomations({ page, rowId, actor: user, event: viaForm ? "form" : "created" });
}

/* ---------- Overdue ---------- */

// Fires overdue rules once per record and due date.
export function processOverdueAutomations() {
  const databases = all<{ page_id: string }>(
    "SELECT d.page_id FROM databases d JOIN pages p ON p.id=d.page_id WHERE p.deleted_at IS NULL AND d.settings LIKE '%\"overdue\"%'",
  );
  let fired = 0;
  const day = today();
  for (const { page_id } of databases) {
    const page = one<Page>("SELECT * FROM pages WHERE id=?", page_id)!;
    const settings = databaseSettings(page_id);
    const fields = JSON.parse(one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", page_id)!.fields) as Field[];
    const rule = doneRule(fields, settings);
    for (const a of settings.automations || []) {
      if (!a.enabled || a.trigger.type !== "overdue") continue;
      const fieldId = a.trigger.field;
      for (const raw of all<{ id: string; cells: string }>("SELECT id,cells FROM rows WHERE page_id=?", page_id)) {
        const cells = JSON.parse(raw.cells) as Cells;
        const due = cells[fieldId];
        if (typeof due !== "string" || due.slice(0, 10) >= day || isDone(rule, cells)) continue;
        const key = due.slice(0, 10);
        const fresh = run(
          "INSERT OR IGNORE INTO automation_runs(automation_id,row_id,key,at) VALUES(?,?,?,?)",
          a.id,
          raw.id,
          key,
          Date.now(),
        );
        if (!fresh.changes) continue;
        fired += runAutomations({ page, rowId: raw.id, actor: null, event: "overdue", only: a.id });
      }
    }
  }
  return fired;
}

const runtime = globalThis as typeof globalThis & { flowplanAutomationTimer?: ReturnType<typeof setInterval> };
export function startAutomationWorker(onFired: () => void) {
  if (runtime.flowplanAutomationTimer) return;
  const tick = () => {
    try {
      if (transactionalOverdue()) onFired();
    } catch (error) {
      console.error("Automations failed", error);
    }
  };
  runtime.flowplanAutomationTimer = setInterval(tick, 5 * 60_000);
  runtime.flowplanAutomationTimer.unref();
  setTimeout(tick, 20_000).unref();
}
const transactionalOverdue = () => transaction(() => processOverdueAutomations());
