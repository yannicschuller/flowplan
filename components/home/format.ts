// Small formatting helpers of the start page (also used elsewhere in the
// workspace): the greeting by time of day, edit times, dates.
import { LOCALE_TAG } from "@/lib/locale-tag";
import { translate, type Locale } from "@/lib/i18n";

export function greeting(clock: number | null, t: (de: string, en: string) => string) {
  if (clock === null) return t("Hallo", "Hello");
  const hour = new Date(clock).getHours();
  return hour < 11 ? t("Guten Morgen", "Good morning") : hour < 18 ? t("Hallo", "Hello") : t("Guten Abend", "Good evening");
}

export function relativeTime(value: string, clock: number | null, locale: Locale = "de") {
  const t = translate(locale);
  const date = new Date(/(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? value : value.replace(" ", "T") + "Z");
  if (!Number.isFinite(date.getTime())) return value;
  if (clock === null) return date.toISOString().slice(0, 10);
  const diff = clock - date.getTime();
  if (diff < 60000) return t("gerade eben", "just now");
  if (diff < 3600000) return t(`vor ${Math.floor(diff / 60000)} Min.`, `${Math.floor(diff / 60000)} min ago`);
  if (diff < 86400000) return t(`vor ${Math.floor(diff / 3600000)} Std.`, `${Math.floor(diff / 3600000)} h ago`);
  return date.toLocaleDateString(LOCALE_TAG, { day: "numeric", month: "short" });
}

// The browser's day (YYYY-MM-DD) and time zone: "today" for the widgets.
export function localDay(date = new Date()) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
export function localZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
// "Saturday, 24 October" in the page's language.
export function longDate(clock: number) {
  return new Date(clock).toLocaleDateString(LOCALE_TAG, { weekday: "long", day: "numeric", month: "long" });
}
// A day heading of the agenda: today, tomorrow, else the weekday and date.
export function dayHeading(day: string, today: string, t: (de: string, en: string) => string) {
  const diff = Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 864e5);
  if (diff === 0) return t("Heute", "Today");
  if (diff === 1) return t("Morgen", "Tomorrow");
  return new Date(`${day}T00:00:00Z`).toLocaleDateString(LOCALE_TAG, { weekday: "long", day: "numeric", month: "short", timeZone: "UTC" });
}
export function clockTime(iso: string) {
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) ? date.toLocaleTimeString(LOCALE_TAG, { hour: "2-digit", minute: "2-digit" }) : "";
}
export function hours(value: number) {
  return `${value.toLocaleString(LOCALE_TAG, { maximumFractionDigits: 1 })} h`;
}
