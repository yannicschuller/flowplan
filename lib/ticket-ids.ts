// Ticket numbers: an "ID" property shows the record's running number with
// the database's prefix (WEB-123). Client-safe.
import type { Field } from "./types";

export const TICKET_REF = /\b([A-Z][A-Z0-9]{0,9})-(\d{1,7})\b/g;

export function ticketId(field: Pick<Field, "prefix">, number: number | null | undefined) {
  if (!number) return "";
  return field.prefix ? `${field.prefix}-${number}` : String(number);
}
// A prefix suggested from the database's name: "Website" → "WEB".
export function suggestedPrefix(title: string) {
  const letters = title
    .normalize("NFD")
    .replace(/[^A-Za-z0-9 ]/g, "")
    .trim()
    .toUpperCase();
  const words = letters.split(/\s+/).filter(Boolean);
  const guess = words.length > 1 ? words.map((w) => w[0]).join("") : letters.replace(/\s/g, "");
  const clean = guess.replace(/^[0-9]+/, "").slice(0, 4);
  return clean || "ID";
}
