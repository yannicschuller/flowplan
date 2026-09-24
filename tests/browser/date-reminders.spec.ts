import { test, expect } from "@playwright/test";

test("date reminders are chosen per entry, persist and reach the inbox", async ({
  page,
}, testInfo) => {
  test.setTimeout(150000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", {
      headers: { origin },
      data,
    });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const p = await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    title: `Reminders ${testInfo.project.name} ${Date.now()}`,
    kind: "database",
  });
  const read = async () =>
    (await page.request.get(`/api/pages/${p.id}`)).json();
  const initial = await read();
  await command({
    action: "database.update",
    pageId: p.id,
    version: initial.database.version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "due", name: "Fällig", type: "date" },
      { id: "day", name: "Tag", type: "date" },
    ],
    views: [
      { id: "table", name: "Tabelle", type: "table", filters: [], sorts: [] },
    ],
  });
  const soon = new Date(Date.now() + 3 * 3600000)
    .toISOString()
    .replace(/\.\d+Z$/, "Z");
  const row = await command({
    action: "row.create",
    pageId: p.id,
    cells: { title: "Planung", due: soon },
  });
  await page.goto(`/#page=${p.id}&row=${row.id}`);
  const dialog = page.getByRole("dialog", { name: "Eintrag", exact: true });
  await expect(dialog).toBeVisible();
  const timed = dialog.getByLabel("Erinnerung für Fällig", { exact: true });
  await expect(timed).toHaveValue("");
  // Empty date properties offer no reminder.
  await expect(
    dialog.getByLabel("Erinnerung für Tag", { exact: true }),
  ).toHaveCount(0);
  await timed.selectOption({ label: "30 Minuten vorher" });
  await expect
    .poll(async () => (await read()).reminders)
    .toEqual([
      expect.objectContaining({ rowId: row.id, fieldId: "due", offset: 30 }),
    ]);
  await expect(dialog.getByText(/^Erinnerung am /)).toBeVisible();
  await page.screenshot({
    path: `test-results/date-reminders-verification/${testInfo.project.name}-dialog.png`,
  });
  // The record itself stays unchanged.
  expect((await read()).rows[0].version).toBe(row.version ?? 1);

  // All-day values offer day-based choices at 09:00.
  await command({
    action: "row.update",
    pageId: p.id,
    rowId: row.id,
    version: (await read()).rows[0].version,
    cells: { title: "Planung", due: soon, day: "2031-05-20" },
  });
  await page.reload();
  const day = dialog.getByLabel("Erinnerung für Tag", { exact: true });
  await expect(day.locator("option")).toHaveText([
    "Keine Erinnerung",
    "Am Tag des Termins (09:00)",
    "1 Tag vorher (09:00)",
    "2 Tage vorher (09:00)",
    "1 Woche vorher (09:00)",
  ]);
  await day.selectOption({ label: "1 Tag vorher (09:00)" });
  await expect.poll(async () => (await read()).reminders.length).toBe(2);
  await page.reload();
  await expect(timed).toHaveValue("30");
  await expect(day).toHaveValue("1440");
  await day.selectOption({ label: "Keine Erinnerung" });
  await expect.poll(async () => (await read()).reminders.length).toBe(1);

  if (testInfo.project.name === "desktop") {
    // End to end: the server worker files a due reminder in the inbox.
    const near = new Date(Date.now() + 15000)
      .toISOString()
      .replace(/\.\d+Z$/, "Z");
    const current = (await read()).rows[0];
    await command({
      action: "row.update",
      pageId: p.id,
      rowId: row.id,
      version: current.version,
      cells: { ...current.cells, due: near, day: "" },
    });
    await page.reload();
    await timed.selectOption({ label: "Zum Zeitpunkt des Termins" });
    await expect
      .poll(
        async () =>
          (await (await page.request.get("/api/bootstrap")).json())
            .notifications as { body: string; row_id: string }[],
        { timeout: 90000, intervals: [3000] },
      )
      .toContainEqual(
        expect.objectContaining({
          row_id: row.id,
          body: expect.stringMatching(/^Erinnerung: „Planung“ – Fällig: /),
        }),
      );
  }
  expect(errors).toEqual([]);
  await command({ action: "page.delete", pageId: p.id });
});
