import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-saved-"));
const { run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");
const { MAX_SAVED_SEARCHES } = await import("../lib/saved-searches");

function account(name: string) {
  const uid = id();
  run(
    "INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)",
    uid,
    uid,
    name,
    `${name}@example.test`,
  );
  return {
    id: uid,
    name,
    email: `${name}@example.test`,
    groups: [],
    isAdmin: false,
    disabled: 0,
    created_at: "",
  } as Identity;
}
const owner = account("search-owner"),
  stranger = account("search-stranger");
const wid = createWorkspace(owner.id, "Suchen"),
  other = createWorkspace(stranger.id, "Fremd");

test("saved searches are personal, validated and bounded", () => {
  const space = bootstrap(owner, wid).spaces[0].id;
  const saved = command(owner, {
    action: "search.save",
    workspaceId: wid,
    name: "Offene Rechnungen",
    query: "Rechnung offen",
    kind: "row",
    spaceId: space,
  }) as { id: string };
  assert.deepEqual(bootstrap(owner, wid).savedSearches, [
    {
      id: saved.id,
      name: "Offene Rechnungen",
      query: "Rechnung offen",
      kind: "row",
      spaceId: space,
    },
  ]);
  // Not visible in other workspaces or to other people.
  assert.deepEqual(bootstrap(stranger, other).savedSearches, []);
  assert.throws(
    () =>
      command(stranger, {
        action: "search.save",
        workspaceId: wid,
        name: "x",
        query: "x",
        kind: "all",
      }),
    /Mitglied|Berechtigung|Zugriff/i,
  );
  assert.throws(
    () =>
      command(owner, {
        action: "search.save",
        workspaceId: wid,
        name: "Fremder Bereich",
        query: "x",
        kind: "all",
        spaceId: bootstrap(stranger, other).spaces[0].id,
      }),
    /Bereich nicht gefunden/,
  );
  for (const bad of [
    { name: " ", query: "x", kind: "all" },
    { name: "x", query: "", kind: "all" },
    { name: "x", query: "x", kind: "everything" },
    { name: "x".repeat(121), query: "x", kind: "all" },
  ])
    assert.throws(() =>
      command(owner, { action: "search.save", workspaceId: wid, ...bad }),
    );
  assert.throws(
    () => command(stranger, { action: "search.delete", searchId: saved.id }),
    /nicht gefunden/,
  );
  command(owner, { action: "search.delete", searchId: saved.id });
  assert.deepEqual(bootstrap(owner, wid).savedSearches, []);
  for (let i = 0; i < MAX_SAVED_SEARCHES; i++)
    command(owner, {
      action: "search.save",
      workspaceId: wid,
      name: `S${i}`,
      query: `q${i}`,
      kind: "all",
    });
  assert.throws(
    () =>
      command(owner, {
        action: "search.save",
        workspaceId: wid,
        name: "zu viel",
        query: "x",
        kind: "all",
      }),
    /Höchstens/,
  );
  assert.deepEqual(
    bootstrap(owner, wid)
      .savedSearches!.slice(0, 3)
      .map((s) => s.name),
    ["S0", "S1", "S2"],
  );
});
