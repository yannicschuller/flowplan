// Folding the properties of a database record (#186), like the property
// bar of ordinary pages (#83, lib/page-properties.ts): a chevron folds them
// into one line – a few values as small chips (status first, then other
// choices, dates and people) and "+N Eigenschaften" – that opens them again.
// The person's choice holds for all records of the database, separately on
// phones and larger screens (lib/page-view-prefs.ts, command
// database.collapseRecordProperties). Without one: open on larger screens;
// on phones folded when the record shows more than COLLAPSE_AFTER
// properties – decided when the record opens, never while one edits it. A
// record just created always opens with its properties shown.
import { COLLAPSE_AFTER } from "./page-properties";
import { isEmptyValue } from "./empty-value";
import type { Field } from "./types";

export type RecordDevice = "phone" | "desktop";
// Phones, upright or on their side (a phone turned sideways is wider than
// 600 px but stays a phone).
export const PHONE_MEDIA = "(max-width: 600px), (pointer: coarse) and (max-height: 500px)";
// Values shown in the folded line (fewer on phones).
export const SUMMARY_VALUES = 3,
  SUMMARY_VALUES_NARROW = 2;

// Folded or not: the person's choice for this kind of device wins,
// otherwise folded only on a phone with more than COLLAPSE_AFTER properties.
export function isRecordFolded(choice: boolean | null | undefined, visibleCount: number, device: RecordDevice): boolean {
  if (typeof choice === "boolean") return choice;
  return device === "phone" && visibleCount > COLLAPSE_AFTER;
}

// Which properties make a good chip, most telling first: the status (the
// database's done rule), other choices, dates, people and the sprint.
const RANK: Partial<Record<Field["type"], number>> = { select: 1, multiselect: 2, date: 3, person: 4, sprint: 5 };

// The properties of the folded line: the first `max` with a value by rank
// (ties keep the record's order), and how many of `fields` are not shown.
export function summaryFields<F extends Pick<Field, "id" | "type">>(
  fields: readonly F[],
  cells: Record<string, unknown>,
  max = SUMMARY_VALUES,
  statusId?: string,
): { shown: F[]; more: number } {
  const rank = (f: F) => (f.id === statusId ? 0 : (RANK[f.type] ?? 99));
  const shown = fields
    .map((f, i) => ({ f, i }))
    .filter(({ f }) => rank(f) < 99 && !isEmptyValue(cells[f.id]))
    .sort((a, b) => rank(a.f) - rank(b.f) || a.i - b.i)
    .slice(0, Math.max(0, Math.floor(max)))
    .map(({ f }) => f);
  return { shown, more: Math.max(0, fields.length - shown.length) };
}
