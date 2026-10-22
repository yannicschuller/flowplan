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
export const auditTime = (value: string) => {
  const date = new Date(/[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : value.replace(" ", "T") + "Z");
  return Number.isFinite(date.getTime())
    ? date.toLocaleString(LOCALE_TAG, { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })
    : value;
};
