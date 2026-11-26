// "12 MB", "1.5 GB": a size for people, in the page's language (uploads,
// #561, #569).
import { LOCALE_TAG } from "./locale-tag";

export function sizeText(bytes: number) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes,
    unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${new Intl.NumberFormat(LOCALE_TAG, { maximumFractionDigits: unit && value < 10 ? 1 : 0 }).format(value)} ${units[unit]}`;
}
