import {
  Temporal,
  instantOf,
  isTimed,
  validDateValue,
  validZone,
} from "./date-values";
import { tr } from "./locale-tag";

// Mirrors AppFlowy's reminder choices: offsets before a timed value, or days
// before an all-day value at 09:00 in the reminder's time zone.
export const TIMED_OFFSETS = [0, 5, 10, 15, 30, 60, 120, 1440, 2880, 10080];
export const ALL_DAY_OFFSETS = [0, 1440, 2880, 10080];
export const ALL_DAY_HOUR = 9;
// Reminders whose moment passed shortly before arming still fire once.
export const ARM_GRACE_MS = 60000;

export type DateReminder = {
  rowId: string;
  fieldId: string;
  offset: number;
  timeZone: string;
};

// In the reader's language in the browser; German on the server.
export function reminderLabel(offset: number, timed: boolean) {
  if (!timed) {
    const suffix = ` (${String(ALL_DAY_HOUR).padStart(2, "0")}:00)`;
    if (offset === 0) return tr(`Am Tag des Termins${suffix}`, `On the day of the event${suffix}`);
    if (offset === 10080) return tr(`1 Woche vorher${suffix}`, `1 week before${suffix}`);
    if (offset === 1440) return tr(`1 Tag vorher${suffix}`, `1 day before${suffix}`);
    return tr(`${offset / 1440} Tage vorher${suffix}`, `${offset / 1440} days before${suffix}`);
  }
  if (offset === 0) return tr("Zum Zeitpunkt des Termins", "At the time of the event");
  if (offset < 60) return tr(`${offset} Minuten vorher`, `${offset} minutes before`);
  if (offset === 60) return tr("1 Stunde vorher", "1 hour before");
  if (offset < 1440) return tr(`${offset / 60} Stunden vorher`, `${offset / 60} hours before`);
  if (offset === 10080) return tr("1 Woche vorher", "1 week before");
  if (offset === 1440) return tr("1 Tag vorher", "1 day before");
  return tr(`${offset / 1440} Tage vorher`, `${offset / 1440} days before`);
}

export function reminderOffsets(value: unknown) {
  return isTimed(value) ? TIMED_OFFSETS : ALL_DAY_OFFSETS;
}

// Returns null when the value cannot produce an unambiguous moment, e.g. a
// cleared cell, an offset that does not fit the value kind, or a wall time
// that does not exist in the zone.
export function reminderTarget(
  value: unknown,
  offset: number,
  zone: string,
): Temporal.Instant | null {
  if (!validDateValue(value) || !validZone(zone)) return null;
  if (!reminderOffsets(value).includes(offset)) return null;
  try {
    const base = isTimed(value)
      ? instantOf(value, zone)
      : Temporal.PlainDate.from(value.slice(0, 10))
          .toPlainDateTime({ hour: ALL_DAY_HOUR })
          .toZonedDateTime(zone, { disambiguation: "later" })
          .toInstant();
    return base.subtract({ minutes: offset });
  } catch {
    return null;
  }
}
