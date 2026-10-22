// Numbers and times as the administration shows them.
import { LOCALE_TAG } from "@/lib/locale-tag";

export const mb = (bytes: number) => `${(bytes / 1024 / 1024).toLocaleString(LOCALE_TAG, { maximumFractionDigits: 1 })} MB`;
export const mbText = (bytes: number) => `${(bytes / 1024 / 1024).toLocaleString(LOCALE_TAG, { maximumFractionDigits: bytes < 10 * 1024 * 1024 ? 1 : 0 })} MB`;
export const duration = (seconds: number, t: (de: string, en: string) => string) =>
  seconds < 3600
    ? t(`${Math.round(seconds / 60)} Min.`, `${Math.round(seconds / 60)} min`)
    : seconds < 86400
      ? t(`${Math.round(seconds / 3600)} Std.`, `${Math.round(seconds / 3600)} h`)
      : t(`${Math.round(seconds / 86400)} Tage`, `${Math.round(seconds / 86400)} days`);
// "gerade eben", "vor 3 Std.", "gestern", "vor 41 Tagen".
export const ago = (ms: number, t: (de: string, en: string) => string, now = Date.now()) => {
  const minutes = Math.round((now - ms) / 60_000);
  if (minutes < 2) return t("gerade eben", "just now");
  if (minutes < 60) return t(`vor ${minutes} Min.`, `${minutes} min ago`);
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t(`vor ${hours} Std.`, `${hours} h ago`);
  const days = Math.round(hours / 24);
  if (days === 1) return t("gestern", "yesterday");
  return t(`vor ${days} Tagen`, `${days} days ago`);
};
// Date and time, short.
export const when = (ms: number | null | undefined) =>
  ms ? new Date(ms).toLocaleString(LOCALE_TAG, { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "–";
export const auditTime = (value: string) => {
  const date = new Date(/[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : value.replace(" ", "T") + "Z");
  return Number.isFinite(date.getTime())
    ? date.toLocaleString(LOCALE_TAG, { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })
    : value;
};
