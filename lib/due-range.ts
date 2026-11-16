// The date ranges of "Meine Aufgaben" (#314), shared by the records'
// server filter (lib/cross-records.ts) and the tasks from documents, which
// the client filters itself (components/my-tasks.tsx) – so both sources
// answer "Heute" or "Nächste 7 Tage" the same way. No dependencies: it runs
// in the browser and on the server.
//
// The ranges nest, so a narrower choice never shows something a wider one
// hides: overdue ⊂ today ⊂ week ⊂ dated. "Heute" and "Nächste 7 Tage"
// keep what is overdue, as that is due by then too.
export const DUE_RANGES = ["any", "overdue", "today", "week", "dated", "undated"] as const;
export type DueRange = (typeof DUE_RANGES)[number];

export const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export function addDays(day: string, days: number) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Whether something due on `due` (a day or none), done or not, lies in the
// range as seen on `today`. Overdue means open: a completed task is no
// longer late.
export function inDueRange(due: string | null, done: boolean, range: DueRange, today: string) {
  const overdue = !!due && due < today && !done;
  switch (range) {
    case "any":
      return true;
    case "overdue":
      return overdue;
    case "today":
      return overdue || due === today;
    case "week":
      return overdue || (!!due && due >= today && due <= addDays(today, 7));
    case "dated":
      return !!due;
    case "undated":
      return !due;
  }
}
