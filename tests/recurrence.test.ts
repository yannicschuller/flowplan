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
const { command, bootstrap, rows, database } = await import("../lib/api");
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

test("skipped occurrences disappear and repeating reminders fire once per occurrence", async () => {
  assert.deepEqual(
    occurrenceDates(
      "2026-01-01",
      { freq: "weekly", interval: 1, exclude: ["2026-01-15"] },
      "2026-01-01",
      "2026-01-31",
    ),
    ["2026-01-08", "2026-01-22", "2026-01-29"],
  );
  const { processDateReminders } = await import("../lib/date-reminders");
  const owner = account("rec-reminder");
  const wid = createWorkspace(owner.id, "Serienerinnerung");
  const page = (
    command(owner, {
      action: "page.create",
      workspaceId: wid,
      spaceId: bootstrap(owner, wid).spaces[0].id,
      title: "Serie",
      kind: "database",
    }) as { id: string }
  ).id;
  const d = (await import("../lib/api")).database(page);
  command(owner, {
    action: "database.update",
    pageId: page,
    version: d.version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "due", name: "Termin", type: "date" },
    ],
    views: d.views,
  });
  const start = Date.now() + 3600000;
  const iso = (ms: number) =>
    new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
  const row = (
    command(owner, {
      action: "row.create",
      pageId: page,
      cells: { title: "Stand-up", due: iso(start) },
    }) as { id: string }
  ).id;
  command(owner, {
    action: "row.recurrence",
    pageId: page,
    rowId: row,
    version: one<{ version: number }>(
      "SELECT version FROM rows WHERE id=?",
      row,
    )!.version,
    recurrence: {
      freq: "daily",
      interval: 1,
      exclude: [iso(start + 2 * 86400000).slice(0, 10)],
    },
  });
  command(owner, {
    action: "reminder.set",
    pageId: page,
    rowId: row,
    fieldId: "due",
    offset: 0,
    timeZone: "UTC",
  });
  const count = () =>
    one<{ n: number }>(
      "SELECT COUNT(*) n FROM notifications WHERE user_id=? AND body LIKE 'Erinnerung:%'",
      owner.id,
    )!.n;
  assert.equal(processDateReminders(start + 60000), 1);
  assert.equal(processDateReminders(start + 120000), 0);
  // The next day's occurrence fires once more.
  assert.equal(processDateReminders(start + 86400000 + 60000), 1);
  // The skipped day stays silent.
  assert.equal(processDateReminders(start + 2 * 86400000 + 60000), 0);
  assert.equal(processDateReminders(start + 3 * 86400000 + 60000), 1);
  assert.equal(count(), 3);
});

test("a single occurrence can be detached into its own record", () => {
  const owner = account("rec-detach"),
    viewer = account("rec-detach-viewer");
  const wid = createWorkspace(owner.id, "Einzeltermin");
  run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
  const page = (
    command(owner, {
      action: "page.create",
      workspaceId: wid,
      spaceId: bootstrap(owner, wid).spaces[0].id,
      title: "Serie",
      kind: "database",
    }) as { id: string }
  ).id;
  command(owner, {
    action: "database.update",
    pageId: page,
    version: database(page).version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "start", name: "Beginn", type: "date" },
      { id: "end", name: "Ende", type: "date" },
    ],
    views: database(page).views,
  });
  const row = (
    command(owner, {
      action: "row.create",
      pageId: page,
      cells: {
        title: "Team-Termin",
        start: "2026-03-02T09:00",
        end: "2026-03-02T10:00",
      },
    }) as { id: string }
  ).id;
  const version = () =>
    one<{ version: number }>("SELECT version FROM rows WHERE id=?", row)!
      .version;
  command(owner, {
    action: "row.recurrence",
    pageId: page,
    rowId: row,
    version: version(),
    recurrence: { freq: "weekly", interval: 1 },
  });
  run(
    "INSERT INTO row_documents(row_id,state,html,generation) VALUES(?,?,?,?) ON CONFLICT(row_id) DO UPDATE SET html=excluded.html",
    row,
    new Uint8Array(),
    "<p>Agenda</p>",
    id(),
  );
  const detach = (date: string, as = owner, v = version()) =>
    command(as, {
      action: "row.detachOccurrence",
      pageId: page,
      rowId: row,
      version: v,
      date,
      startField: "start",
      endField: "end",
    }) as { id: string };
  assert.throws(() => detach("2026-03-16", viewer), /Berechtigung/);
  assert.throws(() => detach("2026-03-16", owner, version() + 1), /geändert/);
  // Not an occurrence: wrong weekday, or the first (stored) date.
  assert.throws(() => detach("2026-03-17"), /gibt es/);
  assert.throws(() => detach("2026-03-02"), /gibt es/);
  const single = detach("2026-03-16").id;
  const created = rows(page).find((r) => r.id === single)!;
  assert.deepEqual(
    [created.cells.title, created.cells.start, created.cells.end],
    ["Team-Termin", "2026-03-16T09:00", "2026-03-16T10:00"],
  );
  assert.equal(created.recurrence, "");
  assert.match(
    one<{ html: string }>(
      "SELECT html FROM row_documents WHERE row_id=?",
      single,
    )!.html,
    /Agenda/,
  );
  // The series skips that date and cannot detach it twice.
  assert.deepEqual(
    parseRecurrence(rows(page).find((r) => r.id === row)!.recurrence)?.exclude,
    ["2026-03-16"],
  );
  assert.throws(() => detach("2026-03-16"), /gibt es/);
  // Editing the detached record leaves the series unchanged.
  command(owner, {
    action: "row.update",
    pageId: page,
    rowId: single,
    version: created.version,
    cells: { start: "2026-03-17T14:00", end: "2026-03-17T15:00" },
  });
  assert.equal(
    rows(page).find((r) => r.id === row)!.cells.start,
    "2026-03-02T09:00",
  );
});
