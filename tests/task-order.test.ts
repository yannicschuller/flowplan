import { test } from "node:test";
import assert from "node:assert/strict";
import { compareTasks, dueGroup, priorityField, priorityRank, sortTasks, type OrderedTask } from "../lib/task-order";
import type { Field } from "../lib/types";

const TODAY = "2026-10-24";
type Named = OrderedTask & { name: string };
const names = (tasks: Named[]) => tasks.map((t) => t.name);

test("overdue (oldest first), today, upcoming by date, then undated", () => {
  const tasks: Named[] = [
    { name: "undated", due: null },
    { name: "next week", due: "2026-10-31" },
    { name: "today", due: TODAY },
    { name: "tomorrow", due: "2026-10-25" },
    { name: "yesterday", due: "2026-10-23" },
    { name: "last month", due: "2026-09-30" },
  ];
  assert.deepEqual(names(sortTasks(tasks, TODAY)), ["last month", "yesterday", "today", "tomorrow", "next week", "undated"]);
  assert.deepEqual([null, "2026-10-01", TODAY, "2026-12-01"].map((due) => dueGroup(due, TODAY)), [3, 0, 1, 2]);
});

test("equal dates go by priority, then page, record and position", () => {
  const tasks: Named[] = [
    { name: "B 2", due: null, page: "Beta", pageId: "b", index: 2 },
    { name: "A 1", due: null, page: "alpha", pageId: "a", index: 1 },
    { name: "B 0", due: null, page: "Beta", pageId: "b", index: 0 },
    { name: "A 0", due: null, page: "Alpha", pageId: "a", index: 0 },
    { name: "low", due: TODAY, priority: 3, index: 0 },
    { name: "none", due: TODAY, index: 1 },
    { name: "high", due: TODAY, priority: 1, index: 2 },
    { name: "record 2", due: null, page: "Beta", pageId: "b", rowId: "r2", index: 0 },
    { name: "record 1", due: null, page: "Beta", pageId: "b", rowId: "r1", index: 5 },
  ];
  assert.deepEqual(names(sortTasks(tasks, TODAY)), ["high", "low", "none", "A 0", "A 1", "B 0", "B 2", "record 1", "record 2"]);
  // The same answer whatever order the tasks come in.
  const reversed = sortTasks([...tasks].reverse(), TODAY);
  assert.deepEqual(names(reversed), names(sortTasks(tasks, TODAY)));
  assert.equal(compareTasks(TODAY)(tasks[1], tasks[1]), 0);
});

test("priority: a select called Priority, by its words or its order", () => {
  const fields: Field[] = [
    { id: "title", name: "Title", type: "text" },
    { id: "prio", name: "Priorität", type: "select", options: ["Niedrig", "Hoch", "Mittel"] },
  ];
  const field = priorityField(fields)!;
  assert.equal(field.id, "prio");
  assert.deepEqual(["Hoch", "Mittel", "Niedrig", "", undefined, "Andere"].map((v) => priorityRank(field, v)), [1, 2, 3, null, null, null]);
  const french: Field = { id: "p", name: "Priorité", type: "select", options: ["Élevée", "Moyenne", "Basse"] };
  assert.deepEqual(french.options!.map((v) => priorityRank(french, v)), [1, 2, 3]);
  // Options without such words: the first is the most urgent.
  const custom: Field = { id: "p", name: "Priority", type: "select", options: ["Now", "Soon", "Someday"] };
  assert.deepEqual(["Someday", "Now", ["Soon"]].map((v) => priorityRank(custom, v)), [2, 0, 1]);
  assert.equal(priorityField([{ id: "p", name: "Priority", type: "text" }]), undefined);
  assert.equal(priorityRank(undefined, "High"), null);
});
