// When a scheduled automation is due (lib/automations.ts): the latest
// scheduled time that has passed, but not one from before the rule was set
// up. Missed runs (server down) are not made up one by one; the latest one
// runs once. Client-safe.
import { Temporal } from "./date-values";
import type { ScheduleTrigger } from "./database-settings-schema";

export type Slot = { key: string; date: string; at: number };

export function latestSlot(trigger: ScheduleTrigger, since: string, now: number): Slot | null {
  let zone: string;
  try {
    zone = Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO(trigger.timeZone).timeZoneId;
  } catch {
    return null;
  }
  const sinceMs = Date.parse(since);
  if (!Number.isFinite(sinceMs) || sinceMs > now) return null;
  const local = (ms: number) => Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(zone).toPlainDate();
  const start = local(sinceMs),
    today = local(now);
  const [hour, minute] = trigger.time.split(":").map(Number);
  const at = (date: Temporal.PlainDate) => date.toPlainDateTime({ hour, minute }).toZonedDateTime(zone).epochMilliseconds;
  const n = trigger.interval || 1;
  // The k-th scheduled day after the start (k = 0: the first period).
  let day: (k: number) => Temporal.PlainDate;
  let k: number;
  if (trigger.freq === "daily") {
    day = (i) => start.add({ days: i * n });
    k = Math.floor(start.until(today, { largestUnit: "days" }).days / n);
  } else if (trigger.freq === "weekly") {
    const monday = start.subtract({ days: start.dayOfWeek - 1 });
    day = (i) => monday.add({ weeks: i * n, days: trigger.weekday - 1 });
    k = Math.floor(monday.until(today, { largestUnit: "days" }).days / 7 / n);
  } else {
    const first = start.with({ day: 1 });
    day = (i) => {
      const month = first.add({ months: i * n });
      return month.with({ day: Math.min(trigger.day, month.daysInMonth) });
    };
    k = Math.floor((today.year * 12 + today.month - (start.year * 12 + start.month)) / n);
  }
  // At most two steps back: the slot of this period may still be ahead.
  for (let i = k + 1; i >= Math.max(0, k - 2); i--) {
    const date = day(i),
      time = at(date);
    if (time > now) continue;
    if (time < sinceMs) return null;
    return { key: `${date.toString()}T${trigger.time}`, date: date.toString(), at: time };
  }
  return null;
}
