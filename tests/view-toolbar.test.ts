import { test } from "node:test";
import assert from "node:assert/strict";
import {
  filterChipLabel,
  groupChipLabel,
  hasNestedFilterGroups,
  MAX_VIEW_TABS,
  propertiesChipLabel,
  sortChipLabel,
  viewRecordOpenMode,
  visibleViewTabs,
} from "../lib/view-toolbar";
import { view as viewSchema } from "../lib/database-schema";
import type { Field, FilterGroup, View } from "../lib/types";

const en = (_de: string, en: string) => en;
const de = (de: string) => de;
const fields: Field[] = [
  { id: "title", name: "Name", type: "text" },
  { id: "due", name: "Due", type: "date" },
  { id: "status", name: "Status", type: "select", options: ["Open", "Done"] },
];
const base: View = { id: "v", name: "Table", type: "table", filters: [], sorts: [] };

test("filter chip: action word while empty, count once filters exist", () => {
  assert.deepEqual(filterChipLabel(base, en), { label: "Filter", active: false });
  assert.deepEqual(
    filterChipLabel({ ...base, filters: [{ field: "status", op: "eq", value: "Open" }] }, en),
    { label: "1 filter", active: true },
  );
  const group: FilterGroup = {
    kind: "group",
    join: "or",
    rules: [
      { kind: "condition", field: "status", op: "eq", value: "Open" },
      { kind: "group", join: "and", rules: [{ kind: "condition", field: "due", op: "empty", value: "" }] },
    ],
  };
  assert.deepEqual(filterChipLabel({ ...base, filterGroup: group }, en), { label: "2 filters", active: true });
  assert.equal(filterChipLabel({ ...base, filterGroup: group }, de).label, "2 Filter");
  assert.equal(hasNestedFilterGroups(group), true);
  assert.equal(hasNestedFilterGroups({ kind: "group", join: "and", rules: [group.rules[0]] }), false);
});

test("sort chip names the first property and counts the rest", () => {
  assert.deepEqual(sortChipLabel(base, fields, en), { label: "Sort", active: false });
  assert.equal(sortChipLabel({ ...base, sorts: [{ field: "due", direction: "asc" }] }, fields, en).label, "Sorted by Due");
  assert.equal(
    sortChipLabel({ ...base, sorts: [{ field: "due", direction: "asc" }, { field: "status", direction: "desc" }] }, fields, en).label,
    "Sorted by Due +1",
  );
  assert.equal(sortChipLabel({ ...base, sorts: [{ field: "gone", direction: "asc" }] }, fields, en).label, "Sorted by deleted property");
});

test("group and properties chips summarise the view", () => {
  assert.deepEqual(groupChipLabel(base, fields, en), { label: "Group", active: false });
  assert.deepEqual(groupChipLabel({ ...base, groupBy: "status" }, fields, en), { label: "By Status", active: true });
  assert.deepEqual(propertiesChipLabel(base, fields, en), { label: "Properties", active: false });
  assert.equal(propertiesChipLabel({ ...base, hiddenFields: ["due"] }, fields, en).label, "1 hidden");
  // Hidden ids of deleted properties do not count.
  assert.equal(propertiesChipLabel({ ...base, hiddenFields: ["due", "status", "gone"] }, fields, en).label, "2 hidden");
});

test("view tabs fold beyond the limit, the current view stays visible", () => {
  const views = Array.from({ length: 8 }, (_, i) => ({ id: `v${i}` }));
  assert.deepEqual(visibleViewTabs(views.slice(0, MAX_VIEW_TABS), "v4"), { shown: views.slice(0, MAX_VIEW_TABS), more: [] });
  const folded = visibleViewTabs(views, "v1");
  assert.deepEqual(folded.shown.map((v) => v.id), ["v0", "v1", "v2", "v3", "v4"]);
  assert.deepEqual(folded.more.map((v) => v.id), ["v5", "v6", "v7"]);
  // A view from the menu takes the last visible slot.
  const swapped = visibleViewTabs(views, "v6");
  assert.deepEqual(swapped.shown.map((v) => v.id), ["v0", "v1", "v2", "v3", "v6"]);
  assert.deepEqual(swapped.more.map((v) => v.id), ["v4", "v5", "v7"]);
});

test("records open as the view says, else as the database layout", () => {
  assert.equal(viewRecordOpenMode(base, { open: "side" }), "side");
  assert.equal(viewRecordOpenMode({ ...base, recordOpen: "full" }, { open: "side" }), "full");
  // The view schema accepts the setting and refuses other values.
  assert.equal(viewSchema.safeParse({ ...base, recordOpen: "center" }).success, true);
  assert.equal(viewSchema.safeParse({ ...base, recordOpen: "popup" }).success, false);
});
