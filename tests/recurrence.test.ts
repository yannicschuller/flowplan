import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
import {
  occurrenceDates,
  parseRecurrence,
  recurrenceText,
  shiftDateValue,
  recurrenceSchema,
} from "../lib/recurrence";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(
  join(tmpdir(), "flowplan-recurrence-"),
);
const { one, run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap, rows } = await import("../lib/api");
const { exportArchive, importArchive } = await import("../lib/archive");

test("occurrences follow the rule, skip ahead, clamp month ends and stop at limits", () => {
  const weekly = { freq: "weekly" as const, interval: 2 };
  assert.deepEqual(
    occurrenceDates("2026-01-01", weekly, "2026-01-01", "2026-02-01"),
    ["2026-01-15", "2026-01-29"],
  );
  // Far-away windows do not walk from the first date.
  assert.deepEqual(
    occurrenceDates(
      "2000-01-01",
      { freq: "daily", interval: 1 },
      "2026-05-01",
      "2026-05-03",
    ),
    ["2026-05-01", "2026-05-02", "2026-05-03"],
  );
  assert.deepEqual(
    occurrenceDates(
      "2026-01-31",
      { freq: "monthly", interval: 1 },
      "2026-02-01",
      "2026-04-30",
    ),
    ["2026-02-28", "2026-03-31", "2026-04-30"],
  );
  assert.deepEqual(
    occurrenceDates(
      "2024-02-29",
      { freq: "yearly", interval: 1 },
      "2025-01-01",
      "2028-12-31",
    ),
    ["2025-02-28", "2026-02-28", "2027-02-28", "2028-02-29"],
  );
  assert.deepEqual(
    occurrenceDates(
      "2026-01-01",
      { freq: "daily", interval: 1, until: "2026-01-03" },
      "2026-01-01",
      "2026-12-31",
    ),
    ["2026-01-02", "2026-01-03"],
  );
  assert.deepEqual(
    occurrenceDates(
      "2026-01-01",
      { freq: "daily", interval: 1, count: 3 },
      "2026-01-01",
      "2026-12-31",
    ),
    ["2026-01-02", "2026-01-03"],
  );
  assert.equal(
    occurrenceDates(
      "2026-01-01",
      { freq: "daily", interval: 1 },
      "2026-01-01",
      "2030-01-01",
    ).length,
    400,
  );
  assert.equal(
    shiftDateValue("2026-01-30T09:00:00Z", 3),
    "2026-02-02T09:00:00Z",
  );
  assert.equal(
    recurrenceText({ freq: "weekly", interval: 2, count: 5 }),
    "Alle 2 Wochen, 5-mal",
  );
  assert.equal(parseRecurrence("{bad"), null);
  assert.equal(
    parseRecurrence(JSON.stringify({ freq: "hourly", interval: 1 })),
    null,
  );
  assert.equal(
    recurrenceSchema.safeParse({
      freq: "daily",
      interval: 1,
      until: "2026-01-01",
      count: 2,
    }).success,
    false,
  );
});

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

test("rules are versioned record edits and survive copies and archives", async () => {
  const owner = account("rec-owner"),
    viewer = account("rec-viewer");
  const wid = createWorkspace(owner.id, "Wiederholung");
  run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
  const page = (
    command(owner, {
      action: "page.create",
      workspaceId: wid,
      spaceId: bootstrap(owner, wid).spaces[0].id,
      title: "Termine",
      kind: "database",
    }) as { id: string }
  ).id;
  const row = (
    command(owner, {
      action: "row.create",
      pageId: page,
      cells: { title: "Jour fixe" },
    }) as {
      id: string;
    }
  ).id;
  const version = () =>
    one<{ version: number }>("SELECT version FROM rows WHERE id=?", row)!
      .version;
  const set = (recurrence: unknown, as = owner, v = version()) =>
    command(as, {
      action: "row.recurrence",
      pageId: page,
      rowId: row,
      version: v,
      recurrence,
    });
  const rule = { freq: "weekly", interval: 1 };
  assert.throws(() => set(rule, viewer), /Berechtigung/);
  assert.throws(() => set(rule, owner, version() + 1), /geändert/);
  assert.throws(() => set({ freq: "weekly", interval: 0 }));
  const before = version();
  set(rule);
  assert.equal(version(), before + 1);
  assert.deepEqual(parseRecurrence(rows(page)[0].recurrence), rule);
  const copy = (
    command(owner, { action: "page.duplicate", pageId: page }) as { id: string }
  ).id;
  assert.deepEqual(parseRecurrence(rows(copy)[0].recurrence), rule);
  const destination = createWorkspace(owner.id, "Wiederholung Import");
  const imported = await importArchive(
    owner,
    destination,
    await exportArchive(owner, wid),
  );
  assert.deepEqual(
    parseRecurrence(rows(imported.pageIds[page])[0].recurrence),
    rule,
  );
  set(null);
  assert.equal(rows(page)[0].recurrence, "");
});
