import { LOCALE_TAG } from "./locale-tag";
import { formatDateValue } from "./date-values";
import { cellText } from "./cell-text";
import type { Field } from "./types";

// Display formats of number and date properties. Stored values never change;
// only their presentation does.
export const currencies = {
  eur: ["Euro", "EUR"],
  usd: ["US-Dollar", "USD"],
  gbp: ["Britisches Pfund", "GBP"],
  chf: ["Schweizer Franken", "CHF"],
  jpy: ["Japanischer Yen", "JPY"],
  cny: ["Chinesischer Yuan", "CNY"],
  cad: ["Kanadischer Dollar", "CAD"],
  aud: ["Australischer Dollar", "AUD"],
  nzd: ["Neuseeland-Dollar", "NZD"],
  hkd: ["Hongkong-Dollar", "HKD"],
  sgd: ["Singapur-Dollar", "SGD"],
  sek: ["Schwedische Krone", "SEK"],
  nok: ["Norwegische Krone", "NOK"],
  dkk: ["Dänische Krone", "DKK"],
  pln: ["Polnischer Złoty", "PLN"],
  czk: ["Tschechische Krone", "CZK"],
  huf: ["Ungarischer Forint", "HUF"],
  ron: ["Rumänischer Leu", "RON"],
  try: ["Türkische Lira", "TRY"],
  rub: ["Russischer Rubel", "RUB"],
  inr: ["Indische Rupie", "INR"],
  idr: ["Indonesische Rupiah", "IDR"],
  krw: ["Südkoreanischer Won", "KRW"],
  twd: ["Neuer Taiwan-Dollar", "TWD"],
  thb: ["Thailändischer Baht", "THB"],
  php: ["Philippinischer Peso", "PHP"],
  myr: ["Malaysischer Ringgit", "MYR"],
  brl: ["Brasilianischer Real", "BRL"],
  mxn: ["Mexikanischer Peso", "MXN"],
  ars: ["Argentinischer Peso", "ARS"],
  clp: ["Chilenischer Peso", "CLP"],
  cop: ["Kolumbianischer Peso", "COP"],
  uyu: ["Uruguayischer Peso", "UYU"],
  zar: ["Südafrikanischer Rand", "ZAR"],
  ils: ["Israelischer Schekel", "ILS"],
  aed: ["VAE-Dirham", "AED"],
  sar: ["Saudi-Riyal", "SAR"],
} as const;
export const numberFormats: Record<string, string> = {
  "": "Zahl",
  plain: "Zahl ohne Tausendertrennzeichen",
  decimal2: "Zahl mit 2 Nachkommastellen",
  percent: "Prozent",
  ...Object.fromEntries(
    Object.entries(currencies).map(([key, [name, code]]) => [
      key,
      `${name} (${code})`,
    ]),
  ),
};
export const dateFormats: Record<string, string> = {
  "": "Kurz (24. Sept. 2026)",
  long: "Lang (24. September 2026)",
  eu: "Numerisch (24.09.2026)",
  iso: "ISO (2026-09-24)",
  us: "US (09/24/2026)",
};
export const timeFormats: Record<string, string> = {
  "24": "24 Stunden",
  "12": "12 Stunden",
};

// `decimals` fixes the number of fraction digits for every format.
export function formatNumber(value: number, format = "", decimals?: number) {
  if (!Number.isFinite(value)) return String(value);
  const digits =
    decimals === undefined
      ? {}
      : { minimumFractionDigits: decimals, maximumFractionDigits: decimals };
  const currency = currencies[format as keyof typeof currencies];
  if (currency)
    return new Intl.NumberFormat(LOCALE_TAG, {
      style: "currency",
      currency: currency[1],
      ...digits,
    }).format(value);
  if (format === "percent")
    return new Intl.NumberFormat(LOCALE_TAG, {
      style: "percent",
      maximumFractionDigits: 2,
      ...digits,
    }).format(value);
  if (format === "plain")
    return new Intl.NumberFormat(LOCALE_TAG, {
      useGrouping: false,
      maximumFractionDigits: 10,
      ...digits,
    }).format(value);
  if (format === "decimal2" && decimals === undefined)
    return new Intl.NumberFormat(LOCALE_TAG, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  return new Intl.NumberFormat(LOCALE_TAG, {
    maximumFractionDigits: 10,
    ...digits,
  }).format(value);
}
export function formatFieldDate(
  value: unknown,
  field?: Pick<Field, "format" | "timeFormat">,
  zone?: string,
) {
  return formatDateValue(value, zone, {
    date: field?.format || "",
    time: field?.timeFormat || "24",
  });
}
// Plain text of a cell as people see it (public pages, previews).
export function displayText(
  field: Pick<Field, "type" | "format" | "timeFormat" | "decimals">,
  value: unknown,
  zone?: string,
) {
  if ((field.type === "number" || (field.type === "formula" && field.format)) && typeof value === "number")
    return formatNumber(value, field.format, field.decimals);
  if (field.type === "date" && typeof value === "string" && value)
    return formatFieldDate(value, field, zone);
  return cellText(value);
}

// Number properties shown as stars store whole ratings from 0 to the maximum
// (default 5, at most 10).
export const ratingMax = (f: Partial<Field>) =>
  Math.min(10, Math.max(1, Math.round(f.rollupMax || 5)));
export function numberCell(f: Field, value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error("Ungültige Zahl.");
  if (
    f.rollupDisplay === "rating" &&
    (!Number.isInteger(value) || value < 0 || value > ratingMax(f))
  )
    throw new Error(`Bewertung zwischen 0 und ${ratingMax(f)} Sternen.`);
  return value;
}
