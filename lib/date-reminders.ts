import { z } from "zod";
import { all, id, lockFor, one, run, transaction } from "./db";
import { HttpError } from "./auth";
import { pageRole } from "./permissions";
import { rowRole } from "./row-access";
import { requireRow } from "./row-documents";
import { cellText } from "./database";
import {
  formatDateValue,
  validDateValue,
  validZone,
} from "./date-values";
import { occurrenceDates, occurrenceValue, parseRecurrence } from "./recurrence";
import {
  ARM_GRACE_MS,
  reminderOffsets,
  reminderTarget,
  type DateReminder,
} from "./date-reminder-options";
import { rememberTaskTarget } from "./notification-targets";
import type { Field, Identity, Page } from "./types";
import { isLeader } from "./cluster/leader";
import { workersPaused } from "./instance-read-only";

export const MAX_REMINDERS_PER_USER = 1000;
export {
  reminderLabel,
  reminderOffsets,
  reminderTarget,
  type DateReminder,
} from "./date-reminder-options";

const setSchema = z.object({
  pageId: z.string().uuid(),
  rowId: z.string().uuid(),
  fieldId: z.string().min(1).max(200),
  offset: z.number().int().min(0).max(10080).nullable(),
  timeZone: z.string().max(100),
});

async function dateField(pageId: string, fieldId: string) {
  const stored = await one<{ fields: string }>(
    "SELECT fields FROM databases WHERE page_id=?",
    pageId,
  );
  const field = stored
    ? (JSON.parse(stored.fields) as Field[]).find((f) => f.id === fieldId)
    : undefined;
  return field?.type === "date" ? field : undefined;
}

// Reminders are personal: anyone who can read the database may set their own,
// including viewers and locked pages, without changing the record itself.
export async function setDateReminder(user: Identity, input: unknown) {
  const parsed = setSchema.parse(input);
  const { row } = await requireRow(user, parsed.pageId, parsed.rowId);
  if (!(await dateField(parsed.pageId, parsed.fieldId)))
    throw new HttpError(400, "Datumseigenschaft fehlt.");
  if (parsed.offset === null) {
    await run(
      "DELETE FROM date_reminders WHERE user_id=? AND row_id=? AND field_id=?",
      user.id,
      row.id,
      parsed.fieldId,
    );
    return { ok: true, reminder: null };
  }
  if (!validZone(parsed.timeZone))
    throw new HttpError(400, "Ungültige Zeitzone.");
  const cells = JSON.parse(row.cells as unknown as string) as Record<
    string,
    unknown
  >;
  const value = cells[parsed.fieldId];
  if (!validDateValue(value))
    throw new HttpError(400, "Bitte zuerst ein Datum eintragen.");
  if (!reminderOffsets(value).includes(parsed.offset))
    throw new HttpError(400, "Diese Erinnerung passt nicht zum Datum.");
  // In the command's transaction: a person's reminders are counted one at a time.
  await lockFor(`date-reminders:${user.id}`);
  const existing = await one(
    "SELECT 1 FROM date_reminders WHERE user_id=? AND row_id=? AND field_id=?",
    user.id,
    row.id,
    parsed.fieldId,
  );
  if (
    !existing &&
    ((await one<{ n: number }>(
      "SELECT COUNT(*) n FROM date_reminders WHERE user_id=?",
      user.id,
    ))?.n ?? 0) >= MAX_REMINDERS_PER_USER
  )
    throw new HttpError(
      400,
      `Maximal ${MAX_REMINDERS_PER_USER.toLocaleString("de-DE")} Erinnerungen je Person.`,
    );
  await run(
    `INSERT INTO date_reminders(user_id,page_id,row_id,field_id,offset_minutes,time_zone,observed_value,armed_at,fired_value)
     VALUES(?,?,?,?,?,?,?,?,NULL)
     ON CONFLICT(user_id,row_id,field_id) DO UPDATE SET offset_minutes=excluded.offset_minutes,
     time_zone=excluded.time_zone,observed_value=excluded.observed_value,armed_at=excluded.armed_at,fired_value=NULL`,
    user.id,
    parsed.pageId,
    row.id,
    parsed.fieldId,
    parsed.offset,
    parsed.timeZone,
    value,
    Date.now(),
  );
  const target = reminderTarget(value, parsed.offset, parsed.timeZone);
  return {
    ok: true,
    reminder: {
      rowId: row.id,
      fieldId: parsed.fieldId,
      offset: parsed.offset,
      timeZone: parsed.timeZone,
    },
    past: !target || target.epochMilliseconds < Date.now() - ARM_GRACE_MS,
  };
}

export async function listDateReminders(
  user: Identity,
  pageId: string,
): Promise<DateReminder[]> {
  return (await all<{
    row_id: string;
    field_id: string;
    offset_minutes: number;
    time_zone: string;
  }>(
    "SELECT row_id,field_id,offset_minutes,time_zone FROM date_reminders WHERE page_id=? AND user_id=?",
    pageId,
    user.id,
  )).map((r) => ({
    rowId: r.row_id,
    fieldId: r.field_id,
    offset: r.offset_minutes,
    timeZone: r.time_zone,
  }));
}

type Due = {
  user_id: string;
  page_id: string;
  row_id: string;
  field_id: string;
  offset_minutes: number;
  time_zone: string;
  observed_value: string | null;
  armed_at: number;
  fired_value: string | null;
  cells: string;
  recurrence: string;
  disabled: number;
};

// Returns the number of created inbox notifications. Inserting a notification
// queues push deliveries through the existing trigger.
export async function processDateReminders(now = Date.now()) {
  let fired = 0;
  const reminders = await all<Due>(
    `SELECT r.*,w.cells,w.recurrence,u.disabled FROM date_reminders r
     JOIN rows w ON w.id=r.row_id AND w.page_id=r.page_id
     JOIN users u ON u.id=r.user_id`,
  );
  const fields = new Map<string, Field[]>();
  for (const reminder of reminders) {
    if (!fields.has(reminder.page_id)) {
      const stored = await one<{ fields: string }>(
        "SELECT fields FROM databases WHERE page_id=?",
        reminder.page_id,
      );
      fields.set(reminder.page_id, stored ? JSON.parse(stored.fields) : []);
    }
    const field = fields
      .get(reminder.page_id)!
      .find((f) => f.id === reminder.field_id);
    const key = [reminder.user_id, reminder.row_id, reminder.field_id];
    if (field?.type !== "date") {
      await run(
        "DELETE FROM date_reminders WHERE user_id=? AND row_id=? AND field_id=?",
        ...key,
      );
      continue;
    }
    const raw = (JSON.parse(reminder.cells) as Record<string, unknown>)[
      field.id
    ];
    const value = validDateValue(raw) ? raw : null;
    let armed = reminder.armed_at;
    if (value !== reminder.observed_value) {
      // A changed date re-arms the reminder from now on.
      armed = now;
      await run(
        "UPDATE date_reminders SET observed_value=?,armed_at=? WHERE user_id=? AND row_id=? AND field_id=?",
        value,
        now,
        ...key,
      );
    }
    if (!value || reminder.disabled) continue;
    // Repeating entries remind for every occurrence: the latest due one that
    // has not fired yet.
    const rule = parseRecurrence(reminder.recurrence);
    const zone = validZone(reminder.time_zone) ? reminder.time_zone : "UTC";
    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    // Occurrences move in the person's zone (09:00 stays 09:00 after a clock
    // change). Only the last days matter: an offset is at most a week, and a
    // window from `armed` would stop at the occurrence limit of a long daily
    // series. Older ones count only when nothing is due recently.
    const occurrences = (from: number, to: number, limit?: number) =>
      rule
        ? occurrenceDates(value, rule, day(from - 86400000), day(to), limit, zone).map((date) =>
            occurrenceValue(value, value, date, zone),
          )
        : [];
    const recent = Math.max(armed, now - 8 * 86400000);
    let candidates = [value, ...occurrences(recent, now + 8 * 86400000)];
    const isDue = (occurrence: string) => {
      const target = reminderTarget(occurrence, reminder.offset_minutes, reminder.time_zone);
      return !!target && target.epochMilliseconds <= now && target.epochMilliseconds >= armed - ARM_GRACE_MS;
    };
    if (rule && armed < recent && !candidates.slice(1).some(isDue))
      candidates = [value, ...occurrences(armed, recent, 20000), ...candidates.slice(1)];
    const occurrence = candidates.filter(isDue).at(-1);
    if (!occurrence || occurrence === reminder.fired_value) continue;
    const page = await one<Page>(
      "SELECT * FROM pages WHERE id=? AND deleted_at IS NULL",
      reminder.page_id,
    );
    // Missing access keeps the reminder; it may fire after access returns.
    if (!page || !(await pageRole({ id: reminder.user_id } as Identity, page)))
      continue;
    // Likewise while the record is hidden from the person (made private).
    const target = await one<{ id: string; access: string; created_by: string }>(
      "SELECT id,access,created_by FROM rows WHERE id=?",
      reminder.row_id,
    );
    if (!target || !(await rowRole({ id: reminder.user_id } as Identity, page, target))) continue;
    const cells = JSON.parse(reminder.cells) as Record<string, unknown>;
    const titleField = fields.get(reminder.page_id)![0];
    const title =
      (titleField && cellText(cells[titleField.id]).slice(0, 200)) ||
      "Ohne Titel";
    await transaction(async () => {
      if (
        !(await run(
          "UPDATE date_reminders SET fired_value=? WHERE user_id=? AND row_id=? AND field_id=? AND observed_value=? AND fired_value IS DISTINCT FROM ?",
          occurrence,
          ...key,
          value,
          occurrence,
        )).changes
      )
        return;
      const notificationId = id();
      await run(
        "INSERT INTO notifications(id,user_id,body,page_id,row_id,kind) VALUES(?,?,?,?,?,'reminder')",
        notificationId,
        reminder.user_id,
        `Erinnerung: „${title}“ – ${field.name}: ${formatDateValue(occurrence, reminder.time_zone)}`,
        reminder.page_id,
        reminder.row_id,
      );
      // "Done" and "Tomorrow" on the app's notification (lib/notification-actions.ts).
      await rememberTaskTarget(notificationId, { type: "row", pageId: reminder.page_id, rowId: reminder.row_id, fieldId: field.id });
      fired++;
    });
  }
  return fired;
}

const runtime = globalThis as typeof globalThis & {
  flowplanReminderTimer?: ReturnType<typeof setInterval>;
};
export async function startReminderWorker(onFired: () => void) {
  if (runtime.flowplanReminderTimer) return;
  const tick = async () => {
    // Cluster mode: the leader only (lib/cluster/leader.ts).
    if (!isLeader() || (await workersPaused())) return;
    try {
      if (await processDateReminders()) onFired();
    } catch (error) {
      console.error("Date reminders failed", error);
    }
  };
  runtime.flowplanReminderTimer = setInterval(tick, 30000);
  runtime.flowplanReminderTimer.unref();
  await tick();
}
