// Time triggers of workflows (docs/specs/workflows.md §8.13): a tick of the
// leader every minute for schedules (latestSlot(), as the database rules
// use it – missed slots are not made up one by one) and date triggers of
// records. Every hit becomes an event with a dedupe key and an
// automation_runs entry: a leader change may run a tick twice, an event
// still comes once. Retention runs here once a day as well.
import { all, one, run, transaction } from "../db";
import { isLeader } from "../cluster/leader";
import { workersPaused } from "../instance-read-only";
import { latestSlot } from "../automation-schedule";
import { databaseSettings } from "../database-settings";
import { doneRule, isDone } from "../database-settings-schema";
import { Temporal } from "../date-values";
import { emitWorkflowEvent } from "./events";
import { graphOf } from "./engine";
import { databaseFields } from "./nodes/data";
import { workflowRetention } from "./retention";
import { flushNotices } from "./notices";

type TriggerRow = { page_id: string; node_id: string; version_id: string; workspace_id: string; config: string; activated_at: number | null };

const localNow = (now: number, zone: string) => {
  try {
    return Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO(zone);
  } catch {
    return Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO("UTC");
  }
};
// The day of a date cell in the workflow's time zone: a moment ("…T01:00Z")
// on the day it falls on there, as the views read it; a date as written.
function cellDay(value: string, zone: string) {
  if (value.length > 10 && /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return localNow(ms, zone).toPlainDate().toString();
  }
  return value.slice(0, 10);
}
async function once(pageId: string, nodeId: string, rowId: string, key: string, now: number) {
  return !!(await run("INSERT INTO automation_runs(automation_id,row_id,key,at) VALUES(?,?,?,?) ON CONFLICT DO NOTHING", `wf:${pageId}:${nodeId}`, rowId, key, now)).changes;
}

export async function processWorkflowSchedules(now = Date.now()) {
  let emitted = 0;
  const schedules = await all<TriggerRow>(
    "SELECT t.page_id,t.node_id,t.version_id,t.workspace_id,t.config,w.activated_at FROM workflow_triggers t JOIN workflows w ON w.page_id=t.page_id AND w.status='active' WHERE t.kind='schedule'",
  );
  for (const t of schedules) {
    const graph = await graphOf({ id: "", version_id: t.version_id });
    const c = JSON.parse(t.config) as Record<string, unknown>;
    const trigger = {
      type: "schedule" as const,
      freq: (c.freq as "daily" | "weekly" | "monthly") || "daily",
      interval: Number(c.interval || 1),
      weekday: Number(c.weekday || 1),
      day: Number(c.day || 1),
      time: String(c.time || "09:00"),
      timeZone: String(c.timeZone || graph?.settings.timeZone || "UTC"),
    };
    // The rhythm ("every 2 weeks") counts from the last slot that fired, so
    // republishing or resuming keeps it; slots from before the activation
    // (while paused) are not made up.
    const activated = t.activated_at || now;
    const last = await one<{ key: string }>("SELECT key FROM automation_runs WHERE automation_id=? AND row_id='@schedule' ORDER BY key DESC LIMIT 1", `wf:${t.page_id}:${t.node_id}`);
    let since = activated;
    if (last && /^\d{4}-\d{2}-\d{2}T/.test(last.key)) {
      try {
        // The start of that day in the schedule's time zone.
        const start = Temporal.PlainDate.from(last.key.slice(0, 10)).toZonedDateTime(trigger.timeZone).epochMilliseconds;
        if (start <= now) since = start;
      } catch {
        // An unknown time zone: latestSlot() finds no slot either.
      }
    }
    const anchor = new Date(since).toISOString();
    const slot = latestSlot(trigger, anchor, now);
    if (!slot || slot.at < activated) continue;
    await transaction(async () => {
      if (!(await once(t.page_id, t.node_id, "@schedule", slot.key, now))) return;
      await emitWorkflowEvent("schedule", {
        workspaceId: t.workspace_id,
        payload: { workflow: t.page_id, node: t.node_id, slot: { date: slot.date, time: trigger.time, key: slot.key } },
        dedupeKey: `wf:${t.page_id}:${t.node_id}:${slot.key}`,
        checked: true,
      });
      emitted++;
    });
  }
  // Date triggers: "date reached" (with an offset and an optional time) or
  // "overdue and open", once per record, date and node.
  const dates = await all<TriggerRow>(
    "SELECT t.page_id,t.node_id,t.version_id,t.workspace_id,t.config,w.activated_at FROM workflow_triggers t JOIN workflows w ON w.page_id=t.page_id AND w.status='active' WHERE t.kind='record.date'",
  );
  for (const t of dates) {
    const graph = await graphOf({ id: "", version_id: t.version_id });
    const c = JSON.parse(t.config) as { database: string; field: string; offsetDays?: number; time?: string; mode?: string };
    const db = await one<{ id: string; deleted_at: string | null }>("SELECT id,deleted_at FROM pages WHERE id=?", c.database);
    if (!db || db.deleted_at) continue;
    const zone = graph?.settings.timeZone || "UTC";
    const local = localNow(now, zone);
    const today = local.toPlainDate().toString();
    const clock = `${String(local.hour).padStart(2, "0")}:${String(local.minute).padStart(2, "0")}`;
    const activatedDay = localNow(t.activated_at || now, zone).toPlainDate().toString();
    const fields = await databaseFields(db.id);
    const rule = doneRule(fields, await databaseSettings(db.id));
    for (const row of await all<{ id: string; cells: string }>("SELECT id,cells FROM rows WHERE page_id=?", db.id)) {
      const cells = JSON.parse(row.cells) as Record<string, unknown>;
      const value = cells[c.field];
      if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(value)) continue;
      const due = cellDay(value, zone);
      const keyOf = (day: string) => (c.mode === "overdue" ? day : `${day}${c.offsetDays ? `${c.offsetDays > 0 ? "+" : ""}${c.offsetDays}` : ""}`);
      let key: string | null = null;
      if (c.mode === "overdue") {
        if (due < today && !isDone(rule, cells)) key = keyOf(due);
      } else {
        const target = Temporal.PlainDate.from(due).add({ days: c.offsetDays || 0 }).toString();
        // Reached today (or since activation), at the time if one is set.
        if (target <= today && target >= activatedDay && (!c.time || target < today || clock >= c.time)) key = keyOf(due);
      }
      if (!key) continue;
      const k = key;
      // Fired before under the UTC day of the moment (before it was read in the zone): not again.
      const utcKey = keyOf(value.slice(0, 10));
      if (utcKey !== k && (await one("SELECT 1 FROM automation_runs WHERE automation_id=? AND row_id=? AND key=?", `wf:${t.page_id}:${t.node_id}`, row.id, utcKey))) continue;
      await transaction(async () => {
        if (!(await once(t.page_id, t.node_id, row.id, k, now))) return;
        await emitWorkflowEvent("record.date", {
          workspaceId: t.workspace_id,
          scopeId: db.id,
          pageId: db.id,
          rowId: row.id,
          payload: { workflow: t.page_id, node: t.node_id, date: due },
          dedupeKey: `wf:${t.page_id}:${t.node_id}:${row.id}:${k}`,
          checked: true,
        });
        emitted++;
      });
    }
  }
  return emitted;
}

const holder = globalThis as { flowplanWorkflowSchedule?: ReturnType<typeof setInterval>; flowplanWorkflowRetentionDay?: string };
export function startWorkflowSchedules() {
  if (holder.flowplanWorkflowSchedule) return;
  const tick = async () => {
    // Cluster mode: the leader only (lib/cluster/leader.ts).
    if (!isLeader() || (await workersPaused())) return;
    try {
      await processWorkflowSchedules();
      await flushNotices();
      const day = new Date().toISOString().slice(0, 10);
      if (holder.flowplanWorkflowRetentionDay !== day) {
        holder.flowplanWorkflowRetentionDay = day;
        await workflowRetention();
      }
    } catch (error) {
      console.error("Workflow schedules failed", error);
    }
  };
  holder.flowplanWorkflowSchedule = setInterval(tick, 60_000);
  holder.flowplanWorkflowSchedule.unref?.();
  setTimeout(tick, 15_000).unref?.();
}
