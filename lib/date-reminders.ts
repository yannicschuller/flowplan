import { z } from "zod";
import { all, id, one, run, transaction } from "./db";
import { HttpError } from "./auth";
import { pageRole } from "./permissions";
import { requireRow } from "./row-documents";
import { cellText } from "./database";
import {
  Temporal,
  formatDateValue,
  validDateValue,
  validZone,
} from "./date-values";
import { occurrenceDates, parseRecurrence, shiftDateValue } from "./recurrence";
import {
  ARM_GRACE_MS,
  reminderOffsets,
  reminderTarget,
  type DateReminder,
} from "./date-reminder-options";
import type { Field, Identity, Page } from "./types";

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

function dateField(pageId: string, fieldId: string) {
  const stored = one<{ fields: string }>(
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
export function setDateReminder(user: Identity, input: unknown) {
  const parsed = setSchema.parse(input);
  const { row } = requireRow(user, parsed.pageId, parsed.rowId);
  if (!dateField(parsed.pageId, parsed.fieldId))
    throw new HttpError(400, "Datumseigenschaft fehlt.");
  if (parsed.offset === null) {
    run(
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
  const existing = one(
    "SELECT 1 FROM date_reminders WHERE user_id=? AND row_id=? AND field_id=?",
    user.id,
    row.id,
    parsed.fieldId,
  );
  if (
    !existing &&
    (one<{ n: number }>(
      "SELECT COUNT(*) n FROM date_reminders WHERE user_id=?",
      user.id,
    )?.n ?? 0) >= MAX_REMINDERS_PER_USER
  )
    throw new HttpError(
      400,
      `Maximal ${MAX_REMINDERS_PER_USER.toLocaleString("de-DE")} Erinnerungen je Person.`,
    );
  run(
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

export function listDateReminders(
  user: Identity,
  pageId: string,
): DateReminder[] {
  return all<{
    row_id: string;
    field_id: string;
    offset_minutes: number;
    time_zone: string;
  }>(
    "SELECT row_id,field_id,offset_minutes,time_zone FROM date_reminders WHERE page_id=? AND user_id=?",
    pageId,
    user.id,
  ).map((r) => ({
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
export function processDateReminders(now = Date.now()) {
  let fired = 0;
  const reminders = all<Due>(
    `SELECT r.*,w.cells,w.recurrence,u.disabled FROM date_reminders r
     JOIN rows w ON w.id=r.row_id AND w.page_id=r.page_id
     JOIN users u ON u.id=r.user_id`,
  );
  const fields = new Map<string, Field[]>();
  for (const reminder of reminders) {
    if (!fields.has(reminder.page_id)) {
      const stored = one<{ fields: string }>(
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
      run(
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
      run(
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
    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const candidates = [
      value,
      ...(rule
        ? occurrenceDates(
            value,
            rule,
            day(armed - 86400000),
            day(now + 8 * 86400000),
          ).map((date) =>
            shiftDateValue(
              value,
              Temporal.PlainDate.from(value.slice(0, 10)).until(
                Temporal.PlainDate.from(date),
              ).days,
            ),
          )
        : []),
    ];
    const due = candidates
      .map((occurrence) => ({
        occurrence,
        target: reminderTarget(
          occurrence,
          reminder.offset_minutes,
          reminder.time_zone,
        ),
      }))
      .filter(
        (c) =>
          c.target &&
          c.target.epochMilliseconds <= now &&
          c.target.epochMilliseconds >= armed - ARM_GRACE_MS,
      )
      .at(-1);
    if (!due || due.occurrence === reminder.fired_value) continue;
    const occurrence = due.occurrence;
    const page = one<Page>(
      "SELECT * FROM pages WHERE id=? AND deleted_at IS NULL",
      reminder.page_id,
    );
    // Missing access keeps the reminder; it may fire after access returns.
    if (!page || !pageRole({ id: reminder.user_id } as Identity, page))
      continue;
    const cells = JSON.parse(reminder.cells) as Record<string, unknown>;
    const titleField = fields.get(reminder.page_id)![0];
    const title =
      (titleField && cellText(cells[titleField.id]).slice(0, 200)) ||
      "Ohne Titel";
    transaction(() => {
      if (
        !run(
          "UPDATE date_reminders SET fired_value=? WHERE user_id=? AND row_id=? AND field_id=? AND observed_value=? AND fired_value IS NOT ?",
          occurrence,
          ...key,
          value,
          occurrence,
        ).changes
      )
        return;
      run(
        "INSERT INTO notifications(id,user_id,body,page_id,row_id,kind) VALUES(?,?,?,?,?,'reminder')",
        id(),
        reminder.user_id,
        `Erinnerung: „${title}“ – ${field.name}: ${formatDateValue(occurrence, reminder.time_zone)}`,
        reminder.page_id,
        reminder.row_id,
      );
      fired++;
    });
  }
  return fired;
}

const runtime = globalThis as typeof globalThis & {
  flowplanReminderTimer?: ReturnType<typeof setInterval>;
};
export function startReminderWorker(onFired: () => void) {
  if (runtime.flowplanReminderTimer) return;
  const tick = () => {
    try {
      if (processDateReminders()) onFired();
    } catch (error) {
      console.error("Date reminders failed", error);
    }
  };
  runtime.flowplanReminderTimer = setInterval(tick, 30000);
  runtime.flowplanReminderTimer.unref();
  tick();
}
