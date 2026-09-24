import {
  Temporal,
  instantOf,
  isTimed,
  validDateValue,
  validZone,
} from "./date-values";

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

export function reminderLabel(offset: number, timed: boolean) {
  if (!timed) {
    const suffix = ` (${String(ALL_DAY_HOUR).padStart(2, "0")}:00)`;
    if (offset === 0) return `Am Tag des Termins${suffix}`;
    if (offset === 10080) return `1 Woche vorher${suffix}`;
    return `${offset / 1440} ${offset === 1440 ? "Tag" : "Tage"} vorher${suffix}`;
  }
  if (offset === 0) return "Zum Zeitpunkt des Termins";
  if (offset < 60) return `${offset} Minuten vorher`;
  if (offset < 1440)
    return `${offset / 60} ${offset === 60 ? "Stunde" : "Stunden"} vorher`;
  if (offset === 10080) return "1 Woche vorher";
  return `${offset / 1440} ${offset === 1440 ? "Tag" : "Tage"} vorher`;
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
