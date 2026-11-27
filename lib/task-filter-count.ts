// The filters of My tasks (components/my-tasks.tsx) that differ from the
// default, in the order of their chips below the bar (#612): "Filter (n)"
// shows how many, each chip removes one. The workspaces count while "Alle
// Arbeitsbereiche" is in effect; the database and the search only while
// records take part (not in "Alle Arbeitsbereiche", where their tools are
// not offered).
export type TaskFilterKey = "scope" | "source" | "person" | "range" | "done" | "unassigned" | "database" | "query";

export function activeTaskFilters(f: {
  everywhere: boolean;
  source: "all" | "documents" | "databases";
  person: "mine" | "all" | "own";
  range: string;
  done: boolean;
  unassigned: boolean;
  database: string;
  query: string;
  records: boolean;
}): TaskFilterKey[] {
  const tools = f.records && !f.everywhere;
  const set: [TaskFilterKey, boolean][] = [
    ["scope", f.everywhere],
    ["source", f.source !== "all"],
    ["person", f.person !== "mine"],
    ["range", f.range !== "any"],
    ["done", f.done],
    ["unassigned", f.unassigned],
    ["database", tools && !!f.database],
    ["query", tools && !!f.query.trim()],
  ];
  return set.filter(([, on]) => on).map(([key]) => key);
}
