import { test, expect } from "@playwright/test";

// Published databases (#393): the light/dark button in the header (kept on
// the device across reloads), "← Back to <view>" from a record opened in a
// view to the same view, month and scroll position, and the record's title
// as the path's last item.
test("published databases: theme button, back to the view, record title in the path", async ({ page, browser }, testInfo) => {
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
  const p = await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    title: `Navigation öffentlich ${testInfo.project.name} ${Date.now()}`,
    kind: "database",
  });
  const read = async () => (await page.request.get(`/api/pages/${p.id}`)).json();
  // A month that is not the current one: the back link has to keep it.
  const month = "2025-03";
  await command({
    action: "database.update",
    pageId: p.id,
    version: (await read()).database.version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "start", name: "Beginn", type: "date" },
    ],
    views: [
      { id: "table", name: "Tabelle", type: "table", filters: [], sorts: [{ field: "title", direction: "asc" }] },
      { id: "calendar", name: "Kalender", type: "calendar", filters: [], sorts: [], dateField: "start" },
    ],
  });
  for (let i = 1; i <= 60; i++)
    await command({ action: "row.create", pageId: p.id, cells: { title: `Eintrag ${String(i).padStart(2, "0")}`, ...(i <= 5 ? { start: `${month}-0${i}` } : {}) } });
  const long = "Umsetzung mit einem sehr langen Titel, der im Pfad abgeschnitten wird und trotzdem ganz lesbar bleibt";
  await command({ action: "row.create", pageId: p.id, cells: { title: long, start: `${month}-12` } });
  await command({ action: "page.publish", pageId: p.id, enabled: true });
  const token = (await read()).page.public_token;
  const shot = (name: string) => `test-results/public-navigation/${testInfo.project.name}-${name}.png`;

  const visitorContext = await browser.newContext();
  const visitor = await visitorContext.newPage();
  visitor.on("pageerror", (e) => errors.push(e.message));
  await visitor.goto(`${origin}/share/${token}`);
  const theme = () => visitor.evaluate(() => document.documentElement.dataset.theme);

  // Theme: automatic → light → dark, kept across a reload, back to automatic.
  const toggle = visitor.locator(".public-header .public-theme-toggle");
  await expect(toggle).toHaveAttribute("aria-label", /automatisch/);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-label", /^Farbschema: hell/);
  expect(await theme()).toBe("light");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-label", /^Farbschema: dunkel/);
  expect(await theme()).toBe("dark");
  await visitor.screenshot({ path: shot("dark-table") });
  await visitor.reload();
  expect(await theme()).toBe("dark");
  await expect(toggle).toHaveAttribute("aria-label", /^Farbschema: dunkel/);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-label", /automatisch/);
  expect(await visitor.evaluate(() => localStorage.getItem("flowplan-theme"))).toBeNull();

  // The calendar of another month: the record keeps view and month.
  await visitor.goto(`${origin}/share/${token}?view=calendar&month=${month}`);
  await visitor.locator(`.public-calendar-day[data-day="${month}-12"]`).getByRole("link", { name: long }).first().click();
  await expect(visitor).toHaveURL(new RegExp(`row=.+&view=calendar&month=${month}`));
  await expect(visitor.getByRole("heading", { name: long })).toBeVisible();
  const crumb = visitor.getByRole("navigation", { name: "Pfad" }).locator(".public-breadcrumb-current");
  await expect(crumb).toHaveText(/^Umsetzung mit einem sehr langen Titel.*…$/);
  await expect(crumb).toHaveAttribute("title", long);
  await expect(crumb).toHaveAttribute("aria-current", "page");
  await visitor.screenshot({ path: shot("record") });
  await visitor.getByRole("link", { name: "Zurück zu Kalender" }).click();
  await expect(visitor).toHaveURL(new RegExp(`/share/${token}\\?view=calendar&month=${month}$`));
  await expect(visitor.locator(".public-calendar")).toContainText(long.slice(0, 20));

  // The table, scrolled down: back to the same place.
  await visitor.goto(`${origin}/share/${token}?view=table`);
  const target = visitor.getByRole("link", { name: "Eintrag 55" });
  await target.scrollIntoViewIfNeeded();
  await visitor.evaluate(() => window.scrollBy(0, 40));
  const before = await visitor.evaluate(() => Math.round(window.scrollY));
  expect(before).toBeGreaterThan(300);
  await target.click();
  await expect(visitor.getByRole("heading", { name: "Eintrag 55" })).toBeVisible();
  await expect(crumb).toHaveText("Eintrag 55");
  await visitor.getByRole("link", { name: "Zurück zu Tabelle" }).click();
  await expect(visitor).toHaveURL(new RegExp(`\\?view=table$`));
  await expect.poll(() => visitor.evaluate(() => Math.round(window.scrollY))).toBeGreaterThan(before - 5);
  expect(Math.abs((await visitor.evaluate(() => Math.round(window.scrollY))) - before)).toBeLessThanOrEqual(5);
  // An ordinary visit of the view starts at the top.
  await visitor.goto(`${origin}/share/${token}?view=table`);
  expect(await visitor.evaluate(() => window.scrollY)).toBe(0);

  // A record not opened from a view: the path, no back link.
  const row = (await visitor.getByRole("link", { name: "Eintrag 01" }).getAttribute("href"))!.match(/row=([^&]+)/)![1];
  await visitor.goto(`${origin}/share/${token}?row=${row}`);
  await expect(visitor.locator(".public-back")).toHaveCount(0);
  await expect(crumb).toHaveText(/\S/);
  await visitorContext.close();
  expect(errors).toEqual([]);
  await command({ action: "page.delete", pageId: p.id });
});
