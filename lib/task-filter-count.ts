// "Filter (n)" of My tasks on phones (components/my-tasks.tsx): how many of
// the filters in its sheet differ from the default. The source and the date
// range have controls of their own in the row and do not count; the
// database and the search only while records take part.
export function sheetFilterCount(f: {
  person: "mine" | "all" | "own";
  done: boolean;
  unassigned: boolean;
  database: string;
  query: string;
  records: boolean;
}): number {
  return [f.person !== "mine", f.done, f.unassigned, f.records && !!f.database, f.records && !!f.query.trim()].filter(Boolean).length;
}
