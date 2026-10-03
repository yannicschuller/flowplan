import { LOCALE_TAG } from "./locale-tag";
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
    return `${date}, ${time} (Zeitzone prüfen)`;
  }
}
export function dateInZone(zone: string) {
  return Temporal.Now.zonedDateTimeISO(zone).toPlainDate().toString();
}
export { Temporal };
