import { LOCALE_TAG, tr } from "./locale-tag";
import { Temporal } from "@js-temporal/polyfill";

const shape =
  /^\d{4}-\d{2}-\d{2}(?:T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;
export function isTimed(value: unknown): value is `${string}T${string}` {
  return typeof value === "string" && value.includes("T");
}
export function validDateValue(value: unknown): value is string {
  if (typeof value !== "string" || !shape.test(value) || value < "0001-01-01")
    return false;
  try {
    Temporal.PlainDate.from(value.slice(0, 10));
    if (isTimed(value)) {
      Temporal.PlainDateTime.from(value.replace(/(?:Z|[+-]\d{2}:\d{2})$/, ""));
      if (hasOffset(value)) Temporal.Instant.from(value);
    }
    return true;
  } catch {
    return false;
  }
}
export function validZone(value: string) {
  if (!value || value.length > 100 || /^[+-]/.test(value)) return false;
  try {
    Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO(value);
    return true;
  } catch {
    return false;
  }
}
export function browserZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}
// Records keep "Created time" and "Edited time" as SQLite CURRENT_TIMESTAMP
// text ("2026-11-05 17:39:02", UTC without a zone). Formulas and rollups read
// them as ISO instants ("2026-11-05T17:39:02Z", issue #129); other values
// pass unchanged.
export function sqlTimestampToIso<T>(value: T): T | string {
  if (typeof value !== "string") return value;
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?)$/.exec(value);
  return m ? `${m[1]}T${m[2]}Z` : value;
}
export function hasOffset(value: string) {
  return /(?:Z|[+-]\d{2}:\d{2})$/.test(value);
}
export type TimeChoice = "reject" | "earlier" | "later";
export function localToInstant(
  local: string,
  zone: string,
  choice: TimeChoice = "reject",
) {
  if (
    !validDateValue(local) ||
    !isTimed(local) ||
    hasOffset(local) ||
    !validZone(zone)
  )
    throw new Error("Bitte Datum, Uhrzeit und Zeitzone prüfen.");
  const plain = Temporal.PlainDateTime.from(local);
  const earlier = plain.toZonedDateTime(zone, { disambiguation: "earlier" }),
    later = plain.toZonedDateTime(zone, { disambiguation: "later" });
  // Both Temporal choices shift nonexistent wall times. Never accept that silently.
  if (
    !earlier.toPlainDateTime().equals(plain) ||
    !later.toPlainDateTime().equals(plain)
  )
    throw new Error(
      "Diese Uhrzeit existiert wegen der Zeitumstellung nicht. Bitte eine andere Uhrzeit wählen.",
    );
  if (
    earlier.epochMilliseconds !== later.epochMilliseconds &&
    choice === "reject"
  )
    throw new Error(
      "Diese Uhrzeit kommt zweimal vor. Bitte erstes oder zweites Vorkommen wählen.",
    );
  return (choice === "later" ? later : earlier).toInstant().toString();
}
// Whether a local wall time occurs twice in `zone` (the hour repeated when
// the clocks go back), so the field has to ask which occurrence is meant.
export function repeatedLocalTime(local: string, zone: string) {
  if (!validDateValue(local) || !isTimed(local) || hasOffset(local) || !validZone(zone)) return false;
  const plain = Temporal.PlainDateTime.from(local);
  const earlier = plain.toZonedDateTime(zone, { disambiguation: "earlier" }),
    later = plain.toZonedDateTime(zone, { disambiguation: "later" });
  return earlier.toPlainDateTime().equals(plain) && earlier.epochMilliseconds !== later.epochMilliseconds;
}
export function instantOf(value: string, zone: string) {
  if (!validDateValue(value) || !isTimed(value) || !validZone(zone))
    throw new Error("Ungültiger Zeitpunkt.");
  return Temporal.Instant.from(
    hasOffset(value) ? value : localToInstant(value, zone),
  );
}
export function localValue(value: unknown, zone: string) {
  if (!validDateValue(value)) return "";
  if (!isTimed(value)) return value;
  if (!hasOffset(value)) return value;
  return instantOf(value, zone)
    .toZonedDateTimeISO(zone)
    .toPlainDateTime()
    .toString({ smallestUnit: "millisecond" });
}
// The value of a date field (components/date-input.tsx): whole minutes
// without seconds, so the field shows "08:30", not "08:30:00.000".
export function fieldValue(value: unknown, zone: string) {
  const local = localValue(value, zone);
  return isTimed(local) ? local.replace(/(T\d{2}:\d{2}):00(?:\.0+)?$/, "$1") : local;
}
export function formatDateValue(
  value: unknown,
  zone = browserZone(),
  style: { date?: string; time?: string } = {},
) {
  if (!validDateValue(value)) return String(value ?? "");
  const local = localValue(value, zone);
  const day = Temporal.PlainDate.from(local.slice(0, 10));
  const pad = (n: number, size = 2) => String(n).padStart(size, "0");
  const date =
    style.date === "iso"
      ? day.toString()
      : style.date === "eu"
        ? `${pad(day.day)}.${pad(day.month)}.${pad(day.year, 4)}`
        : style.date === "us"
          ? `${pad(day.month)}/${pad(day.day)}/${pad(day.year, 4)}`
          : day.toLocaleString(LOCALE_TAG, {
              day: "numeric",
              month: style.date === "long" ? "long" : "short",
              year: "numeric",
            });
  if (!isTimed(value)) return date;
  const hours = Number(local.slice(11, 13)),
    minutes = local.slice(14, 16);
  const time =
    style.time === "12"
      ? `${hours % 12 || 12}:${minutes} ${hours < 12 ? "AM" : "PM"}`
      : local.slice(11, 16);
  try {
    const offset = instantOf(value, zone).toZonedDateTimeISO(zone).offset;
    return `${date}, ${time} (UTC${offset})`;
  } catch {
    // Old imports can contain a floating, ambiguous or nonexistent wall time.
    return `${date}, ${time} (${tr("Zeitzone prüfen", "check time zone")})`;
  }
}
export function dateInZone(zone: string) {
  return Temporal.Now.zonedDateTimeISO(zone).toPlainDate().toString();
}
export { Temporal };

// ---- The value handling of a date field (components/date-input.tsx) ----

// An all-day draft that is not a date ("2026-02-30").
export class InvalidDateDraft extends Error {}
const emptyDate = (value: unknown) => value === undefined || value === null || value === "";
// The stored value a draft stands for. An empty draft is "" – the date is
// removed, never ignored. An unchanged local time keeps the exact offset of
// the stored value (the repeated hour of a clock change).
export function draftDateValue(
  text: string,
  timed: boolean,
  occurrence: TimeChoice,
  current: unknown,
  zone: string,
): string {
  if (!text) return "";
  if (!timed) {
    if (!validDateValue(text) || isTimed(text)) throw new InvalidDateDraft("invalid date");
    return text;
  }
  if (isTimed(current) && (text === localValue(current, zone) || text === fieldValue(current, zone)) && occurrence === "reject")
    return instantOf(current, zone).toString();
  return localToInstant(text, zone, occurrence);
}
// What a field has to save: the new value, or null when it equals the
// stored one (an empty draft on an empty field saves nothing).
export function dateToSave(next: string, current: unknown): string | null {
  if (emptyDate(next) && emptyDate(current)) return null;
  return next === current ? null : next;
}

// ---- Date properties without a time of day ("Mit Uhrzeit" off, #327) ----

// The refusal when a time would be added to such a property (German, as
// the server answers; lib/i18n-errors.ts has the English).
export const NO_TIME_MESSAGE = "Diese Eigenschaft hat keine Uhrzeit. Bitte nur ein Datum angeben.";
// Whether `value` would add a new time to a date property without time:
// a value that already had a time (`before`) may keep one (it can be
// moved or removed); an all-day or empty one gets none.
export function newTimeRefused(
  field: { type: string; noTime?: boolean } | undefined,
  value: unknown,
  before: unknown,
) {
  return !!field && field.type === "date" && !!field.noTime && isTimed(value) && !isTimed(before);
}
// The day of a value, for writes that take the date only (imports,
// automations, quick capture): "2026-05-04T09:30Z" → "2026-05-04" in `zone`.
// Other values pass unchanged.
export function dateOnly(value: unknown, zone = "UTC"): unknown {
  if (!isTimed(value) || !validDateValue(value)) return value;
  try {
    return localValue(value, validZone(zone) ? zone : "UTC").slice(0, 10);
  } catch {
    return value.slice(0, 10);
  }
}
// The cells with a time taken off for date properties without time.
export function withoutNewTimes<T extends Record<string, unknown>>(
  fields: { id: string; type: string; noTime?: boolean }[],
  cells: T,
  zone?: string,
  before: Record<string, unknown> = {},
): T {
  let next: T | null = null;
  for (const f of fields)
    if (f.id in cells && newTimeRefused(f, cells[f.id], before[f.id])) {
      next ??= { ...cells };
      (next as Record<string, unknown>)[f.id] = dateOnly(cells[f.id], zone);
    }
  return next || cells;
}
// The setting is stored only where it means something: `noTime: true` on a
// date property (unset is the default, with time).
export function cleanNoTime(fields: { type: string; noTime?: boolean }[]) {
  for (const f of fields) if (f.type !== "date" || !f.noTime) delete f.noTime;
}
