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
const recurrenceModule = await import("../lib/recurrence");

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

async function account(name: string) {
  const uid = id();
  await run(
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
  const owner = await account("rec-owner"),
    viewer = await account("rec-viewer");
  const wid = await createWorkspace(owner.id, "Wiederholung");
  await run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
  const page = (
    (await command(owner, {
      action: "page.create",
      workspaceId: wid,
      spaceId: (await bootstrap(owner, wid)).spaces[0].id,
      title: "Termine",
      kind: "database",
    })) as { id: string }
  ).id;
  const row = (
    (await command(owner, {
      action: "row.create",
      pageId: page,
      cells: { title: "Jour fixe" },
    })) as {
      id: string;
    }
  ).id;
  const version = async () =>
    (await one<{ version: number }>("SELECT version FROM rows WHERE id=?", row))!
      .version;
  const set = async (recurrence: unknown, as = owner, v?: number) =>
    await command(as, {
      action: "row.recurrence",
      pageId: page,
      rowId: row,
      version: v ?? (await version()),
      recurrence,
    });
  const rule = { freq: "weekly", interval: 1 };
  await assert.rejects(async () => await set(rule, viewer), /Berechtigung/);
  await assert.rejects(async () => await set(rule, owner, (await version()) + 1), /geändert/);
  await assert.rejects(async () => await set({ freq: "weekly", interval: 0 }));
  const before = await version();
  await set(rule);
  assert.equal(await version(), before + 1);
  assert.deepEqual(parseRecurrence((await rows(page))[0].recurrence), rule);
  const copy = (
    (await command(owner, { action: "page.duplicate", pageId: page })) as { id: string }
  ).id;
  assert.deepEqual(parseRecurrence((await rows(copy))[0].recurrence), rule);
  const destination = await createWorkspace(owner.id, "Wiederholung Import");
  const imported = await importArchive(
    owner,
    destination,
    await exportArchive(owner, wid),
  );
  assert.deepEqual(
    parseRecurrence((await rows(imported.pageIds[page]))[0].recurrence),
    rule,
  );
  await set(null);
  assert.equal((await rows(page))[0].recurrence, "");
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
  const owner = await account("rec-reminder");
  const wid = await createWorkspace(owner.id, "Serienerinnerung");
  const page = (
    (await command(owner, {
      action: "page.create",
      workspaceId: wid,
      spaceId: (await bootstrap(owner, wid)).spaces[0].id,
      title: "Serie",
      kind: "database",
    })) as { id: string }
  ).id;
  const d = await (await import("../lib/api")).database(page);
  await command(owner, {
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
    (await command(owner, {
      action: "row.create",
      pageId: page,
      cells: { title: "Stand-up", due: iso(start) },
    })) as { id: string }
  ).id;
  await command(owner, {
    action: "row.recurrence",
    pageId: page,
    rowId: row,
    version: (await one<{ version: number }>(
      "SELECT version FROM rows WHERE id=?",
      row,
    ))!.version,
    recurrence: {
      freq: "daily",
      interval: 1,
      exclude: [iso(start + 2 * 86400000).slice(0, 10)],
    },
  });
  await command(owner, {
    action: "reminder.set",
    pageId: page,
    rowId: row,
    fieldId: "due",
    offset: 0,
    timeZone: "UTC",
  });
  const count = async () =>
    (await one<{ n: number }>(
      "SELECT COUNT(*) n FROM notifications WHERE user_id=? AND body LIKE 'Erinnerung:%'",
      owner.id,
    ))!.n;
  assert.equal(await processDateReminders(start + 60000), 1);
  assert.equal(await processDateReminders(start + 120000), 0);
  // The next day's occurrence fires once more.
  assert.equal(await processDateReminders(start + 86400000 + 60000), 1);
  // The skipped day stays silent.
  assert.equal(await processDateReminders(start + 2 * 86400000 + 60000), 0);
  assert.equal(await processDateReminders(start + 3 * 86400000 + 60000), 1);
  assert.equal(await count(), 3);
});

test("a single occurrence can be detached into its own record", async () => {
  const owner = await account("rec-detach"),
    viewer = await account("rec-detach-viewer");
  const wid = await createWorkspace(owner.id, "Einzeltermin");
  await run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
  const page = (
    (await command(owner, {
      action: "page.create",
      workspaceId: wid,
      spaceId: (await bootstrap(owner, wid)).spaces[0].id,
      title: "Serie",
      kind: "database",
    })) as { id: string }
  ).id;
  await command(owner, {
    action: "database.update",
    pageId: page,
    version: (await database(page)).version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "start", name: "Beginn", type: "date" },
      { id: "end", name: "Ende", type: "date" },
    ],
    views: (await database(page)).views,
  });
  const row = (
    (await command(owner, {
      action: "row.create",
      pageId: page,
      cells: {
        title: "Team-Termin",
        start: "2026-03-02T09:00",
        end: "2026-03-02T10:00",
      },
    })) as { id: string }
  ).id;
  const version = async () =>
    (await one<{ version: number }>("SELECT version FROM rows WHERE id=?", row))!
      .version;
  await command(owner, {
    action: "row.recurrence",
    pageId: page,
    rowId: row,
    version: await version(),
    recurrence: { freq: "weekly", interval: 1 },
  });
  await run(
    "INSERT INTO row_documents(row_id,state,html,generation) VALUES(?,?,?,?) ON CONFLICT(row_id) DO UPDATE SET html=excluded.html",
    row,
    new Uint8Array(),
    "<p>Agenda</p>",
    id(),
  );
  const detach = async (date: string, as = owner, v?: number) =>
    (await command(as, {
      action: "row.detachOccurrence",
      pageId: page,
      rowId: row,
      version: v ?? (await version()),
      date,
      startField: "start",
      endField: "end",
    })) as { id: string };
  await assert.rejects(async () => await detach("2026-03-16", viewer), /Berechtigung/);
  await assert.rejects(async () => await detach("2026-03-16", owner, (await version()) + 1), /geändert/);
  // Not an occurrence: wrong weekday, or the first (stored) date.
  await assert.rejects(async () => await detach("2026-03-17"), /gibt es/);
  await assert.rejects(async () => await detach("2026-03-02"), /gibt es/);
  const single = (await detach("2026-03-16")).id;
  const created = (await rows(page)).find((r) => r.id === single)!;
  assert.deepEqual(
    [created.cells.title, created.cells.start, created.cells.end],
    ["Team-Termin", "2026-03-16T09:00", "2026-03-16T10:00"],
  );
  assert.equal(created.recurrence, "");
  assert.match(
    (await one<{ html: string }>(
      "SELECT html FROM row_documents WHERE row_id=?",
      single,
    ))!.html,
    /Agenda/,
  );
  // The series skips that date and cannot detach it twice.
  assert.deepEqual(
    parseRecurrence((await rows(page)).find((r) => r.id === row)!.recurrence)?.exclude,
    ["2026-03-16"],
  );
  await assert.rejects(async () => await detach("2026-03-16"), /gibt es/);
  // Editing the detached record leaves the series unchanged.
  await command(owner, {
    action: "row.update",
    pageId: page,
    rowId: single,
    version: created.version,
    cells: { start: "2026-03-17T14:00", end: "2026-03-17T15:00" },
  });
  assert.equal(
    (await rows(page)).find((r) => r.id === row)!.cells.start,
    "2026-03-02T09:00",
  );
});

test("a series splits at an occurrence into two series", async () => {
  const owner = await account("rec-split");
  const wid = await createWorkspace(owner.id, "Serienteilung");
  const page = (
    (await command(owner, {
      action: "page.create",
      workspaceId: wid,
      spaceId: (await bootstrap(owner, wid)).spaces[0].id,
      title: "Serie",
      kind: "database",
    })) as { id: string }
  ).id;
  await command(owner, {
    action: "database.update",
    pageId: page,
    version: (await database(page)).version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "start", name: "Beginn", type: "date" },
    ],
    views: (await database(page)).views,
  });
  const create = async (recurrence: Record<string, unknown>) => {
    const rid = (
      (await command(owner, {
        action: "row.create",
        pageId: page,
        cells: { title: "Sprint", start: "2026-01-05" },
      })) as { id: string }
    ).id;
    await command(owner, {
      action: "row.recurrence",
      pageId: page,
      rowId: rid,
      version: 1,
      recurrence,
    });
    return rid;
  };
  const split = async (rid: string, date: string) =>
    (
      (await command(owner, {
        action: "row.detachOccurrence",
        pageId: page,
        rowId: rid,
        version: (await one<{ version: number }>(
          "SELECT version FROM rows WHERE id=?",
          rid,
        ))!.version,
        date,
        startField: "start",
        mode: "following",
      })) as { id: string }
    ).id;
  const rule = async (rid: string) =>
    parseRecurrence((await rows(page)).find((r) => r.id === rid)!.recurrence);
  // Open-ended weekly series with exclusions on both sides.
  const open = await create({
    freq: "weekly",
    interval: 1,
    exclude: ["2026-01-12", "2026-02-09"],
  });
  const tail = await split(open, "2026-01-26");
  assert.deepEqual(await rule(open), {
    freq: "weekly",
    interval: 1,
    until: "2026-01-25",
    exclude: ["2026-01-12"],
  });
  assert.deepEqual(await rule(tail), {
    freq: "weekly",
    interval: 1,
    exclude: ["2026-02-09"],
  });
  assert.equal(
    (await rows(page)).find((r) => r.id === tail)!.cells.start,
    "2026-01-26",
  );
  // Counted series: 5 occurrences split after the second one → 2 + 3.
  const counted = await create({ freq: "weekly", interval: 1, count: 5 });
  const rest = await split(counted, "2026-01-19");
  assert.equal((await rule(counted))?.count, 2);
  assert.equal((await rule(rest))?.count, 3);
  // Splitting at the last occurrence leaves a single record without rule.
  const last = await split(rest, "2026-02-02");
  assert.equal(await rule(last), null);
  assert.equal((await rule(rest))?.count, 2);
  // Splitting at the second occurrence leaves the first alone.
  const pair = await create({ freq: "daily", interval: 1 });
  const after = await split(pair, "2026-01-06");
  assert.equal((await rows(page)).find((r) => r.id === pair)!.recurrence, "");
  assert.deepEqual(await rule(after), { freq: "daily", interval: 1 });
});

test("next occurrence of a repeating record: intervals, weekdays, month ends, leap years", () => {
  const { nextOccurrence } = recurrenceModule;
  assert.equal(nextOccurrence("2026-01-30", { freq: "daily", interval: 3 }), "2026-02-02");
  assert.equal(nextOccurrence("2026-12-30T09:30", { freq: "daily", interval: 2 }), "2027-01-01");
  assert.equal(nextOccurrence("2026-10-19", { freq: "weekly", interval: 2 }), "2026-11-02");
  // Mo/We/Fr: later in the same week, then Monday of the next (or n-th) week.
  const mwf = { freq: "weekly" as const, interval: 1, weekdays: [5, 1, 3] };
  assert.equal(nextOccurrence("2026-10-19", mwf), "2026-10-21");
  assert.equal(nextOccurrence("2026-10-21", mwf), "2026-10-23");
  assert.equal(nextOccurrence("2026-10-23", mwf), "2026-10-26");
  assert.equal(nextOccurrence("2026-10-25", mwf), "2026-10-26");
  assert.equal(nextOccurrence("2026-10-23", { ...mwf, interval: 2 }), "2026-11-02");
  // Month ends are clamped but the day of the month is kept.
  const monthly = { freq: "monthly" as const, interval: 1, day: 31 };
  assert.equal(nextOccurrence("2026-01-31", monthly), "2026-02-28");
  assert.equal(nextOccurrence("2026-02-28", monthly), "2026-03-31");
  assert.equal(nextOccurrence("2026-03-31", monthly), "2026-04-30");
  assert.equal(nextOccurrence("2024-01-31", monthly), "2024-02-29");
  assert.equal(nextOccurrence("2026-01-31", { freq: "monthly", interval: 1 }), "2026-02-28");
  assert.equal(nextOccurrence("2026-11-15", { freq: "monthly", interval: 3 }), "2027-02-15");
  // 29 February: 28 February in common years, back to the 29th in leap years.
  const yearly = { freq: "yearly" as const, interval: 1, day: 29 };
  assert.equal(nextOccurrence("2024-02-29", yearly), "2025-02-28");
  assert.equal(nextOccurrence("2027-02-28", yearly), "2028-02-29");
  assert.equal(nextOccurrence("2024-02-29", { freq: "yearly", interval: 4 }), "2028-02-29");
});

test("a repeating record creates its successor once it is done", async () => {
  const owner = await account("repeat-owner"),
    viewer = await account("repeat-viewer");
  const wid = await createWorkspace(owner.id, "Wiederkehrend");
  await run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
  const page = (
    (await command(owner, {
      action: "page.create",
      workspaceId: wid,
      spaceId: (await bootstrap(owner, wid)).spaces[0].id,
      title: "Aufgaben",
      kind: "database",
      databaseKind: "empty",
    })) as { id: string }
  ).id;
  await command(owner, {
    action: "database.update",
    pageId: page,
    version: (await database(page)).version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "status", name: "Status", type: "select", options: ["Offen", "Erledigt"] },
      { id: "due", name: "Fällig", type: "date" },
      { id: "start", name: "Beginn", type: "date" },
    ],
    views: (await database(page)).views,
  });
  const rid = (
    (await command(owner, {
      action: "row.create",
      pageId: page,
      cells: { title: "Miete", status: "Offen", due: "2026-01-31", start: "2026-01-29" },
    })) as { id: string }
  ).id;
  const stored = async (r: string) => (await one<{ version: number; cells: string; repeat: string }>("SELECT version,cells,repeat FROM rows WHERE id=?", r))!;
  const setRepeat = async (repeat: unknown, as = owner) =>
    await command(as, { action: "row.repeat", pageId: page, rowId: rid, version: (await stored(rid)).version, repeat });
  await assert.rejects(async () => await setRepeat({ freq: "monthly", interval: 1, field: "due" }, viewer), /Berechtigung/);
  await assert.rejects(async () => await setRepeat({ freq: "monthly", interval: 1, field: "title" }), /Datumseigenschaft/);
  await setRepeat({ freq: "monthly", interval: 1, field: "due" });
  // The day of the month is taken from the date.
  assert.equal(recurrenceModule.parseRepeat((await stored(rid)).repeat)?.day, 31);
  const count = async () => (await one<{ n: number }>("SELECT COUNT(*) n FROM rows WHERE page_id=?", page))!.n;
  const done = async (r: string, status = "Erledigt") =>
    await command(owner, { action: "row.update", pageId: page, rowId: r, version: (await stored(r)).version, cells: { status } });
  await done(rid);
  assert.equal(await count(), 2);
  assert.equal((await stored(rid)).repeat, "");
  const next = (await one<{ id: string }>("SELECT id FROM rows WHERE page_id=? AND id!=?", page, rid))!.id;
  assert.deepEqual(JSON.parse((await stored(next)).cells), { title: "Miete", status: "Offen", due: "2026-02-28", start: "2026-02-26" });
  assert.equal(recurrenceModule.parseRepeat((await stored(next)).repeat)?.freq, "monthly");
  // Reopening and closing the old record again creates nothing more.
  await done(rid, "Offen");
  await done(rid);
  assert.equal(await count(), 2);
  // The successor keeps the day: 28 Feb → 31 Mar.
  await done(next);
  const third = (await one<{ cells: string }>("SELECT cells FROM rows WHERE page_id=? AND id NOT IN (?,?)", page, rid, next))!;
  assert.equal(JSON.parse(third.cells).due, "2026-03-31");
});
