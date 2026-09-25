// One definition of "empty" for filters, calculations, rollups and the
// record layout: missing values, blank text, empty lists and, for
// checkboxes, unchecked boxes.
export function isEmptyValue(value: unknown, fieldType?: string): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return !value.trim();
  if (Array.isArray(value)) return value.every((v) => isEmptyValue(v));
  if (fieldType === "checkbox") return value !== true;
  return false;
}
