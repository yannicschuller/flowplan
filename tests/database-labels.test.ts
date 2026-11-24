import { test } from "node:test";
import assert from "node:assert/strict";
import { databaseLabel, databaseList, groupDatabases } from "../lib/database-labels";

const spaces = [
  { id: "s-me", name: "Privat" },
  { id: "s-family", name: "Familie" },
];
const pages = [
  { id: "areas", title: "Bereiche", space_id: "s-family", parent_id: null },
  { id: "archive", title: "Archiv", space_id: "s-family", parent_id: null },
  { id: "old", title: "Bereiche", space_id: "s-family", parent_id: "archive" },
];

test("groups by space in the sidebar's order and sorts by title", () => {
  const groups = groupDatabases(
    [
      { id: "b", title: "To do", space_id: "s-family", parent_id: null },
      { id: "a", title: "notes", space_id: "s-family", parent_id: null },
      { id: "c", title: "Notes", space_id: "s-me", parent_id: null },
      { id: "d", title: "", space_id: "s-me", parent_id: null },
    ],
    { pages, spaces, untitled: "Ohne Titel" },
  );
  assert.deepEqual(
    groups.map((g) => [g.space, g.databases.map((d) => d.label)]),
    [
      ["Privat", ["Notes", "Ohne Titel"]],
      ["Familie", ["notes", "To do"]],
    ],
  );
  // Named apart from a list: space added where the title repeats.
  const list = databaseList(groups);
  assert.equal(list.find((d) => d.id === "c")?.fullLabel, "Notes · Privat");
  assert.equal(list.find((d) => d.id === "a")?.fullLabel, "notes · Familie");
  assert.equal(list.find((d) => d.id === "b")?.fullLabel, "To do");
});

test("same title twice in a space: the parent page, as deep as needed", () => {
  const list = databaseList(
    groupDatabases(
      [
        { id: "n1", title: "Notes", space_id: "s-family", parent_id: "areas" },
        { id: "n2", title: "Notes", space_id: "s-family", parent_id: null },
        { id: "n3", title: "Notes", space_id: "s-family", parent_id: "old" },
      ],
      { pages, spaces },
    ),
  );
  const label = (id: string) => list.find((d) => d.id === id);
  assert.equal(label("n1")?.label, "Notes · Bereiche");
  assert.equal(label("n2")?.label, "Notes");
  assert.equal(label("n3")?.label, "Notes · Archiv › Bereiche");
  assert.equal(label("n1")?.fullLabel, "Notes · Familie › Bereiche");
  assert.equal(new Set(list.map((d) => d.label)).size, 3);
});

test("twins nothing tells apart get a number", () => {
  const list = databaseList(
    groupDatabases(
      [
        { id: "x1", title: "Tasks", space_id: "s-me" },
        { id: "x2", title: "Tasks", space_id: "s-me" },
      ],
      { spaces },
    ),
  );
  assert.deepEqual(list.map((d) => d.label), ["Tasks", "Tasks (2)"]);
});

test("space and parent from the known pages, or the server's space name", () => {
  const groups = groupDatabases(
    [
      { id: "areas-db", title: "Notes" },
      { id: "far", title: "Notes", space: "Team" },
    ],
    { pages: [{ id: "areas-db", title: "Notes", space_id: "s-family", parent_id: "areas" }, ...pages], spaces },
  );
  assert.deepEqual(
    groups.map((g) => [g.space, g.databases.map((d) => d.fullLabel)]),
    [
      ["Familie", ["Notes · Familie"]],
      ["Team", ["Notes · Team"]],
    ],
  );
  assert.equal(databaseLabel("areas-db", [{ id: "areas-db", title: "Notes" }], { pages, spaces }), "Notes");
});

test("without spaces: one unnamed group", () => {
  const groups = groupDatabases([
    { id: "1", title: "B" },
    { id: "2", title: "A" },
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].space, "");
  assert.deepEqual(groups[0].databases.map((d) => d.fullLabel), ["A", "B"]);
});
