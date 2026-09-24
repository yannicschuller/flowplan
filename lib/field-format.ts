import { formatDateValue } from "./date-values";
import { cellText } from "./cell-text";
import type { Field } from "./types";

// Display formats of number and date properties. Stored values never change;
// only their presentation does.
const currencies = {
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
    return new Intl.NumberFormat("de-DE", {
      style: "currency",
      currency: currency[1],
      ...digits,
    }).format(value);
  if (format === "percent")
    return new Intl.NumberFormat("de-DE", {
      style: "percent",
      maximumFractionDigits: 2,
      ...digits,
    }).format(value);
  if (format === "plain")
    return new Intl.NumberFormat("de-DE", {
      useGrouping: false,
      maximumFractionDigits: 10,
      ...digits,
    }).format(value);
  if (format === "decimal2" && decimals === undefined)
    return new Intl.NumberFormat("de-DE", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  return new Intl.NumberFormat("de-DE", {
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
  if (field.type === "number" && typeof value === "number")
    return formatNumber(value, field.format, field.decimals);
  if (field.type === "date" && typeof value === "string" && value)
    return formatFieldDate(value, field, zone);
  return cellText(value);
}
