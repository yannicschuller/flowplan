import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(
  join(tmpdir(), "flowplan-reminders-"),
);
const { one, all, run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");
const {
  processDateReminders,
  reminderTarget,
  reminderLabel,
  listDateReminders,
} = await import("../lib/date-reminders");

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
const owner = await account("reminder-owner"),
  viewer = await account("reminder-viewer"),
  stranger = await account("reminder-stranger");
const wid = await createWorkspace(owner.id, "Reminder workspace");
await run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
const space = (await bootstrap(owner, wid)).spaces[0];
const page = (await command(owner, {
  action: "page.create",
  workspaceId: wid,
  spaceId: space.id,
  title: "Termine",
  kind: "database",
})) as { id: string };
const schema = (await one<{ version: number }>(
  "SELECT version FROM databases WHERE page_id=?",
  page.id,
))!;
await command(owner, {
  action: "database.update",
  pageId: page.id,
  version: schema.version,
  fields: [
    { id: "title", name: "Name", type: "text" },
    { id: "due", name: "Fällig", type: "date" },
    { id: "note", name: "Notiz", type: "text" },
  ],
  views: [{ id: "t", name: "Tabelle", type: "table", filters: [], sorts: [] }],
});
const createRow = async (cells: Record<string, unknown>) =>
  (
    (await command(owner, { action: "row.create", pageId: page.id, cells })) as {
      id: string;
    }
  ).id;
const setCells = async (rowId: string, cells: Record<string, unknown>) =>
  await run(
    "UPDATE rows SET cells=?,version=version+1 WHERE id=?",
    JSON.stringify(cells),
    rowId,
  );
const inbox = async (user: Identity) =>
  await all<{ body: string; row_id: string }>(
    "SELECT body,row_id FROM notifications WHERE user_id=? AND body LIKE 'Erinnerung:%' ORDER BY created_at",
    user.id,
  );
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");

test("reminder targets follow timed offsets, all-day 09:00 and DST", () => {
  assert.equal(
    reminderTarget("2026-03-29T10:00:00Z", 30, "Europe/Berlin")?.toString(),
    "2026-03-29T09:30:00Z",
  );
  // Floating wall time is resolved in the reminder zone.
  assert.equal(
    reminderTarget("2026-07-01T10:00", 60, "Europe/Berlin")?.toString(),
    "2026-07-01T07:00:00Z",
  );
  // All-day: 09:00 local, one day before, across the spring DST switch.
  assert.equal(
    reminderTarget("2026-03-30", 1440, "Europe/Berlin")?.toString(),
    "2026-03-29T07:00:00Z",
  );
  assert.equal(
    reminderTarget("2026-03-30", 0, "America/New_York")?.toString(),
    "2026-03-30T13:00:00Z",
  );
  // Offsets must fit the value kind; nonexistent wall times never fire.
  assert.equal(reminderTarget("2026-03-30", 15, "UTC"), null);
  assert.equal(reminderTarget("2026-03-29T02:30", 0, "Europe/Berlin"), null);
  assert.equal(reminderTarget("", 0, "UTC"), null);
  assert.equal(reminderTarget("2026-03-30", 0, "Mars/Base"), null);
  assert.equal(reminderLabel(60, true), "1 Stunde vorher");
  assert.equal(reminderLabel(2880, false), "2 Tage vorher (09:00)");
  assert.equal(reminderLabel(0, true), "Zum Zeitpunkt des Termins");
});

test("reminders are personal, validated and fire exactly once per date value", async () => {
  const now = Date.now();
  const rowId = await createRow({ title: "Review", due: iso(now + 3600000) });
  await assert.rejects(
    async () =>
      await command(stranger, {
        action: "reminder.set",
        pageId: page.id,
        rowId,
        fieldId: "due",
        offset: 0,
        timeZone: "UTC",
      }),
    /Zugriff|gefunden|Berechtigung/i,
  );
  for (const [input, message] of [
    [{ fieldId: "note", offset: 0, timeZone: "UTC" }, /Datumseigenschaft/],
    [{ fieldId: "due", offset: 7, timeZone: "UTC" }, /passt nicht/],
    [{ fieldId: "due", offset: 0, timeZone: "Nowhere/Zone" }, /Zeitzone/],
  ] as const)
    await assert.rejects(
      async () =>
        await command(viewer, {
          action: "reminder.set",
          pageId: page.id,
          rowId,
          ...input,
        }),
      message,
    );
  // Viewers may set personal reminders without changing the record.
  const before = (await one<{ version: number }>(
    "SELECT version FROM rows WHERE id=?",
    rowId,
  ))!.version;
  await command(viewer, {
    action: "reminder.set",
    pageId: page.id,
    rowId,
    fieldId: "due",
    offset: 30,
    timeZone: "Europe/Berlin",
  });
  assert.equal(
    (await one<{ version: number }>("SELECT version FROM rows WHERE id=?", rowId))!
      .version,
    before,
  );
  assert.deepEqual(await listDateReminders(viewer, page.id), [
    { rowId, fieldId: "due", offset: 30, timeZone: "Europe/Berlin" },
  ]);
  assert.deepEqual(await listDateReminders(owner, page.id), []);
  // Not yet due.
  assert.equal(await processDateReminders(now + 20 * 60000), 0);
  assert.equal(await processDateReminders(now + 31 * 60000), 1);
  assert.equal(await processDateReminders(now + 32 * 60000), 0);
  const [note] = await inbox(viewer);
  assert.equal(note.row_id, rowId);
  assert.match(note.body, /^Erinnerung: „Review“ – Fällig: /);
  assert.equal((await inbox(owner)).length, 0);
  // Push delivery is queued through the existing notification trigger.
  assert.equal(
    (await one<{ n: number }>(
      "SELECT COUNT(*) n FROM notifications WHERE user_id=? AND page_id=? AND row_id=?",
      viewer.id,
      page.id,
      rowId,
    ))!.n,
    1,
  );

  // A changed date re-arms the reminder; the cleared offset removes it.
  await setCells(rowId, { title: "Review", due: iso(now + 2 * 3600000) });
  assert.equal(await processDateReminders(now + 40 * 60000), 0);
  assert.equal(await processDateReminders(now + 91 * 60000), 1);
  await command(viewer, {
    action: "reminder.set",
    pageId: page.id,
    rowId,
    fieldId: "due",
    offset: null,
    timeZone: "UTC",
  });
  assert.deepEqual(await listDateReminders(viewer, page.id), []);
});

test("past moments do not flood, access and schema changes are respected", async () => {
  const now = Date.now();
  const past = await createRow({ title: "Gestern", due: iso(now - 86400000) });
  await command(owner, {
    action: "reminder.set",
    pageId: page.id,
    rowId: past,
    fieldId: "due",
    offset: 0,
    timeZone: "UTC",
  });
  assert.equal(await processDateReminders(now + 1000), 0);

  const hidden = await createRow({ title: "Geheim", due: iso(now + 60000) });
  await command(viewer, {
    action: "reminder.set",
    pageId: page.id,
    rowId: hidden,
    fieldId: "due",
    offset: 0,
    timeZone: "UTC",
  });
  const count = (await inbox(viewer)).length;
  await run("DELETE FROM members WHERE workspace_id=? AND user_id=?", wid, viewer.id);
  assert.equal(await processDateReminders(now + 2 * 60000), 0);
  assert.equal((await inbox(viewer)).length, count);
  // Access returns within the grace window; the reminder is kept and fires.
  await run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
  assert.equal(await processDateReminders(now + 2 * 60000), 1);

  // Deleting the record removes its reminders.
  const doomed = await createRow({ title: "Weg", due: iso(now + 3600000) });
  await command(owner, {
    action: "reminder.set",
    pageId: page.id,
    rowId: doomed,
    fieldId: "due",
    offset: 0,
    timeZone: "UTC",
  });
  await command(owner, { action: "row.delete", pageId: page.id, rowId: doomed });
  assert.equal(
    await one("SELECT 1 FROM date_reminders WHERE row_id=?", doomed),
    undefined,
  );

  // A field that is no longer a date property drops its reminders.
  const later = await createRow({ title: "Später", due: iso(now + 3600000) });
  await command(owner, {
    action: "reminder.set",
    pageId: page.id,
    rowId: later,
    fieldId: "due",
    offset: 0,
    timeZone: "UTC",
  });
  const current = (await one<{ version: number; views: string }>(
    "SELECT version,views FROM databases WHERE page_id=?",
    page.id,
  ))!;
  await command(owner, {
    action: "database.update",
    pageId: page.id,
    version: current.version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "note", name: "Notiz", type: "text" },
    ],
    views: JSON.parse(current.views),
  });
  await processDateReminders(now);
  assert.equal(
    await one("SELECT 1 FROM date_reminders WHERE row_id=?", later),
    undefined,
  );

  // Leaving the workspace clears personal reminders there.
  await run(
    "INSERT INTO date_reminders(user_id,page_id,row_id,field_id,offset_minutes,time_zone,armed_at) VALUES(?,?,?,?,?,?,?)",
    viewer.id,
    page.id,
    past,
    "due",
    0,
    "UTC",
    now,
  );
  await command(viewer, {
    action: "workspace.leave",
    workspaceId: wid,
    confirmName: "Reminder workspace",
  });
  assert.equal(
    await one("SELECT 1 FROM date_reminders WHERE user_id=?", viewer.id),
    undefined,
  );
});
