export function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(cellText).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

// CSV exports: values that a spreadsheet would run as a formula (=, +, @, a
// "-" that is not a number) get a leading apostrophe; negative numbers stay.
export const CSV_FORMULA = /^[=+@\t\r]|^-(?!\d[\d.,]*$)/;
