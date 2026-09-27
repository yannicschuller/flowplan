import { test, expect } from "@playwright/test";

test("large databases draw rows in steps and keep search over all records", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Same logic on mobile.");
  test.setTimeout(120_000);
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const r = await page.request.post("/api/command", { headers: { origin }, data });
    expect(r.ok(), await r.text()).toBe(true);
    return r.json();
  };
  const db = (await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, kind: "database", title: `Viele ${Date.now()}` })).id;
  for (let i = 0; i < 230; i++) await command({ action: "row.create", pageId: db, cells: { title: `Zeile ${String(i).padStart(3, "0")}` } });
  // The database's own rows are sent once, not again as related data.
  const data = await (await page.request.get(`/api/pages/${db}`)).json();
  expect(data.rows).toHaveLength(230);
  expect(data.related[db]).toEqual([]);

  await page.goto(`/#page=${db}`);
  const rows = page.locator(".data-table tbody tr:not(.more-rows-row)");
  await expect(rows).toHaveCount(100);
  await expect(page.getByRole("button", { name: "Weitere 100 von 130 anzeigen" })).toBeAttached();
  // Scrolling loads the next step; the rest comes with the button.
  await page.locator(".more-rows").scrollIntoViewIfNeeded();
  await expect(rows).toHaveCount(200);
  await page.getByRole("button", { name: /Weitere 30 von 30/ }).click();
  await expect(rows).toHaveCount(230);
  await expect(page.locator(".more-rows")).toHaveCount(0);
  // Search still covers all records.
  await page.getByLabel("Datenbank durchsuchen").fill("Zeile 229");
  await expect(rows).toHaveCount(1);
});
