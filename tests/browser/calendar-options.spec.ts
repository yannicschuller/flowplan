import { test, expect } from "@playwright/test";

test("calendar weeks start on Sunday and hide weekends", async ({
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
    title: `Kalenderoptionen ${testInfo.project.name} ${Date.now()}`,
    kind: "database",
  });
  const read = async () =>
    (await page.request.get(`/api/pages/${p.id}`)).json();
  await command({
    action: "database.update",
    pageId: p.id,
    version: (await read()).database.version,
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
        calendar: { mode: "month", timeZone: "UTC" },
      },
    ],
  });
  await page.goto(`/#page=${p.id}`);
  const weekdays = page.locator(".calendar-grid .weekday");
  await expect(weekdays.first()).toHaveText("Mo");
  await page.getByLabel("Kalender: Wochenbeginn").selectOption("sunday");
  await expect(weekdays.first()).toHaveText("So");
  await page.getByLabel("Kalender: Wochenenden anzeigen").uncheck();
  await expect(weekdays).toHaveText(["Mo", "Di", "Mi", "Do", "Fr"]);
  // Only weekdays remain in the month grid.
  const dates = await page
    .locator(".calendar-grid .calendar-day")
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-day")!));
  expect(
    dates.every(
      (d) => ![0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay()),
    ),
  ).toBe(true);
  await expect
    .poll(async () => (await read()).database.views[0].calendar)
    .toMatchObject({ weekStart: "sunday", showWeekends: false });
  await page.reload();
  await expect(weekdays).toHaveText(["Mo", "Di", "Mi", "Do", "Fr"]);
  expect(errors).toEqual([]);
  await command({ action: "page.delete", pageId: p.id });
});
