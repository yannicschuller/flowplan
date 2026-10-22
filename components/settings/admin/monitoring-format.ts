// Numbers, sizes and times as the monitoring shows them (reader's locale).
import { LOCALE_TAG } from "@/lib/locale-tag";

type T = (de: string, en: string) => string;

export const num = (n: number, digits = 0) => n.toLocaleString(LOCALE_TAG, { maximumFractionDigits: digits });
// 1 234 → "1,2 Tsd." / "1.2k"; small numbers as they are.
export const compact = (n: number) => new Intl.NumberFormat(LOCALE_TAG, { notation: "compact", maximumFractionDigits: n >= 1000 && n < 10_000 ? 1 : 0 }).format(n);
export const bytes = (n: number) => {
  if (n >= 1024 ** 4) return `${num(n / 1024 ** 4, 1)} TB`;
  if (n >= 1024 ** 3) return `${num(n / 1024 ** 3, 1)} GB`;
  if (n >= 1024 ** 2) return `${num(n / 1024 ** 2, n < 10 * 1024 ** 2 ? 1 : 0)} MB`;
  if (n >= 1024) return `${num(n / 1024, 0)} kB`;
  return `${num(n)} B`;
};
export const percent = (share: number) => `${num(share * 100, share > 0 && share < 0.1 ? 1 : 0)} %`;
export const ms = (n: number | null) => (n === null ? "–" : n >= 1000 ? `${num(n / 1000, 1)} s` : `${num(n)} ms`);
export const clock = (at: number) => new Date(at).toLocaleTimeString(LOCALE_TAG, { hour: "2-digit", minute: "2-digit" });
export const weekday = (at: number) => new Date(at).toLocaleDateString(LOCALE_TAG, { weekday: "short" });
export const dayMonth = (at: number) => new Date(at).toLocaleDateString(LOCALE_TAG, { day: "numeric", month: "numeric" });
export const dateTime = (at: number) => new Date(at).toLocaleString(LOCALE_TAG, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
// "2026-10-22" (a local day) → a time at its noon.
export const dayAt = (day: string) => new Date(`${day}T12:00:00`).getTime();
export const shortDay = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString(LOCALE_TAG, { day: "numeric", month: "numeric" });
export const longDay = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString(LOCALE_TAG, { weekday: "long", day: "numeric", month: "long" });
// "vor 5 Min." / "5 min ago" – or the time and date when older than a day.
export function ago(at: number, t: T, now = Date.now()) {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return t("gerade eben", "just now");
  if (s < 3600) return t(`vor ${Math.round(s / 60)} Min.`, `${Math.round(s / 60)} min ago`);
  if (s < 86_400) return t(`vor ${Math.round(s / 3600)} Std.`, `${Math.round(s / 3600)} h ago`);
  return dateTime(at);
}
export const uptime = (seconds: number, t: T) =>
  seconds < 3600
    ? t(`${Math.max(1, Math.round(seconds / 60))} Min.`, `${Math.max(1, Math.round(seconds / 60))} min`)
    : seconds < 86_400
      ? t(`${Math.round(seconds / 3600)} Std.`, `${Math.round(seconds / 3600)} h`)
      : t(`${Math.floor(seconds / 86_400)} T ${Math.round((seconds % 86_400) / 3600)} Std.`, `${Math.floor(seconds / 86_400)} d ${Math.round((seconds % 86_400) / 3600)} h`);
