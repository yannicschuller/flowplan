import { test, expect } from "@playwright/test";

// US English: the English texts with month-first dates and weeks from
// Sunday. "Automatic" picks it for a US browser; British English ("en")
// stays as it was for everyone who chose it.
test.use({ locale: "en-US", extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" } });

test("a US browser gets US English: month-first dates, weeks from Sunday", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  await command({ action: "profile.onboarded" });
  const p = await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    title: `US dates ${testInfo.project.name} ${Date.now()}`,
    kind: "database",
  });
  const read = async () => (await page.request.get(`/api/pages/${p.id}`)).json();
  await command({
    action: "database.update",
    pageId: p.id,
    version: (await read()).database.version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "date", name: "Date", type: "date" },
    ],
    views: [
      { id: "table", name: "Table", type: "table", filters: [], sorts: [] },
      { id: "cal", name: "Calendar", type: "calendar", filters: [], sorts: [], dateField: "date", calendar: { mode: "month", timeZone: "UTC" } },
    ],
  });
  await command({ action: "row.create", pageId: p.id, cells: { title: "Launch", date: "2026-11-06" } });
  try {
    await page.goto(`/#page=${p.id}`);
    await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
    // 6 November 2026, month first (British English: "6 Nov 2026").
    await expect(page.getByText("Nov 6, 2026", { exact: true }).first()).toBeVisible({ timeout: 60_000 });
    await page.locator(".database-tabs").getByRole("button", { name: "Calendar", exact: true }).click();
    const weekdays = page.locator(".calendar-grid .weekday");
    await expect(weekdays).toHaveText(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);
    const start = page.getByLabel("Calendar: week start");
    await expect(start).toHaveValue("sunday");
    // Nothing is stored until someone chooses; a choice in the view wins.
    expect((await read()).database.views[1].calendar.weekStart).toBeUndefined();
    await start.selectOption("monday");
    await expect(weekdays.first()).toHaveText("Mon");
    await expect.poll(async () => (await read()).database.views[1].calendar.weekStart).toBe("monday");
    await page.screenshot({ path: `test-results/english-us/${testInfo.project.name}-calendar.png` });
    expect(errors).toEqual([]);
  } finally {
    await command({ action: "page.delete", pageId: p.id });
  }
});

test("US English is offered in the language list next to English", async ({ page }) => {
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.onboarded" } });
  await page.goto("/#settings/appearance");
  const select = page.getByRole("combobox", { name: "Language" });
  await expect(select).toBeAttached({ timeout: 60_000 });
  await expect(select.locator("option")).toContainText(["🇬🇧 English", "🇺🇸 English (US)"]);
  // Automatic, and it follows the browser.
  await expect(select).toHaveValue("");
  await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
});
