// The board of "Meine Aufgaben" (#564, components/my-tasks-board.tsx): its
// columns are the due groups (lib/due-groups.ts), and moving a card to
// another column gives it the date that puts it there:
//
// - "Heute": today.
// - "Nächste 7 Tage": tomorrow – unless its date already lies within the
//   next 7 days (then it stays; this only happens for a card already there).
// - "Später": today + 8, the first day after "Nächste 7 Tage" – unless it is
//   later already.
// - "Ohne Datum": the date is removed.
// - "Überfällig" and "Erledigt" take no cards: nobody sets a date in the
//   past on purpose, and ticking off is the checkbox.
//
// The same column changes nothing (undefined).
import { localToday } from "./task-due";

export const BOARD_COLUMNS = ["Überfällig", "Heute", "Nächste 7 Tage", "Später", "Ohne Datum"] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];
export const DROP_TARGETS: readonly BoardColumn[] = ["Heute", "Nächste 7 Tage", "Später", "Ohne Datum"];

export const shiftDay = (day: string, days: number) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

// The column an open card stands in (as groupByDue sorts it).
export function columnOf(due: string | null, today = localToday()): BoardColumn {
  if (!due) return "Ohne Datum";
  if (due < today) return "Überfällig";
  if (due === today) return "Heute";
  if (due <= shiftDay(today, 7)) return "Nächste 7 Tage";
  return "Später";
}

// The new due date for a card with `due` moved to `column`: a day, null to
// remove it, undefined for no change (same column, or not a drop target).
export function dropDue(column: string, due: string | null, today = localToday()): string | null | undefined {
  if (!DROP_TARGETS.includes(column as BoardColumn)) return undefined;
  if (columnOf(due, today) === column) return undefined;
  switch (column as BoardColumn) {
    case "Heute":
      return today;
    case "Nächste 7 Tage":
      return shiftDay(today, 1);
    case "Später":
      return shiftDay(today, 8);
    default:
      return null;
  }
}
