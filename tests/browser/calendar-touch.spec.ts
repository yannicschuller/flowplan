import { test, expect } from "@playwright/test";

test("touch devices move whole-day calendar entries with a drag handle", async ({
  page,
}, testInfo) => {
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
    title: `Kalender ${testInfo.project.name} ${Date.now()}`,
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
      { id: "date", name: "Datum", type: "date" },
    ],
    views: [
      {
        id: "cal",
        name: "Kalender",
        type: "calendar",
        filters: [],
        sorts: [],
        dateField: "date",
      },
    ],
  });
  const month = new Date().toISOString().slice(0, 7);
  await command({
    action: "row.create",
    pageId: p.id,
    cells: { title: "Workshop", date: `${month}-10` },
  });
  await page.goto(`/#page=${p.id}`);
  const handle = page.getByRole("button", { name: "Workshop verschieben" });
  if (testInfo.project.name !== "mobile") {
    // Mouse users drag the entry itself; the handle is only shown for touch.
    await expect(handle).toBeHidden();
    return command({ action: "page.delete", pageId: p.id });
  }
  const target = page.locator(`.calendar-day[data-day="${month}-12"]`);
  await target.scrollIntoViewIfNeeded();
  await handle.scrollIntoViewIfNeeded();
  const from = (await handle.boundingBox())!,
    to = (await target.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, {
    steps: 8,
  });
  await expect(target).toHaveClass(/touch-target/);
  await page.mouse.up();
  await expect
    .poll(async () => (await read()).rows[0].cells.date)
    .toBe(`${month}-12`);
  await page.screenshot({
    path: `test-results/calendar-touch-verification/mobile-month.png`,
  });
  expect(errors).toEqual([]);
  await command({ action: "page.delete", pageId: p.id });
});

test("weekly repeating entries show occurrences that open the original record", async ({
  page,
}, testInfo) => {
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
    title: `Serie ${testInfo.project.name} ${Date.now()}`,
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
      { id: "date", name: "Datum", type: "date" },
    ],
    views: [
      {
        id: "cal",
        name: "Kalender",
        type: "calendar",
        filters: [],
        sorts: [],
        dateField: "date",
      },
    ],
  });
  const month = new Date().toISOString().slice(0, 7);
  const row = await command({
    action: "row.create",
    pageId: p.id,
    cells: { title: "Jour fixe", date: `${month}-03` },
  });
  await page.goto(`/#page=${p.id}&row=${row.id}`);
  const entry = page.getByRole("dialog", { name: "Eintrag", exact: true });
  await entry
    .getByLabel("Wiederholung", { exact: true })
    .selectOption("weekly");
  await expect
    .poll(async () => (await read()).rows[0].recurrence)
    .toContain('"weekly"');
  await expect(
    entry.getByText("Wöchentlich", { exact: true }).last(),
  ).toBeVisible();
  await entry.getByRole("button", { name: "Schließen", exact: true }).click();
  for (const day of ["03", "10", "17", "24"])
    await expect(
      page
        .locator(`.calendar-day[data-day="${month}-${day}"] .calendar-event`)
        .filter({ hasText: "Jour fixe" }),
    ).toBeVisible();
  const occurrence = page.locator(
    `.calendar-day[data-day="${month}-17"] .calendar-chip.occurrence`,
  );
  await expect(occurrence.locator(".calendar-event")).toHaveAttribute(
    "draggable",
    "false",
  );
  await page.screenshot({
    path: `test-results/calendar-touch-verification/${testInfo.project.name}-series.png`,
  });
  await occurrence.locator(".calendar-event").click();
  await expect(entry).toBeVisible();
  expect(page.url()).toContain(`row=${row.id}`);
  expect(errors).toEqual([]);
  await command({ action: "page.delete", pageId: p.id });
});
