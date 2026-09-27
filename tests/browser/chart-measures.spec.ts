import { test, expect } from "@playwright/test";

test("charts show further values, and feeds and such charts can be published", async ({ page, browser }, info) => {
  test.skip(info.project.name !== "desktop", "Same rendering on mobile.");
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const r = await page.request.post("/api/command", { headers: { origin }, data });
    expect(r.ok(), await r.text()).toBe(true);
    return r.json();
  };
  const db = (await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, kind: "database", title: `Umsatz ${Date.now()}` })).id;
  await command({
    action: "database.update",
    pageId: db,
    version: 1,
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "month", name: "Monat", type: "select", options: ["Jan", "Feb"] },
      { id: "revenue", name: "Umsatz", type: "number" },
      { id: "cost", name: "Kosten", type: "number" },
    ],
    views: [
      {
        id: "chart",
        name: "Diagramm",
        type: "chart",
        filters: [],
        sorts: [],
        chart: {
          kind: "bar",
          xField: "month",
          yField: "revenue",
          aggregate: "sum",
          dateBucket: "month",
          order: "label_asc",
          includeEmpty: false,
          showValues: true,
          measures: [{ field: "cost", aggregate: "sum" }],
        },
      },
      { id: "feed", name: "Feed", type: "feed", filters: [], sorts: [] },
    ],
  });
  for (const cells of [
    { title: "Januar Nord", month: "Jan", revenue: 100, cost: 40 },
    { title: "Januar Süd", month: "Jan", revenue: 50, cost: 10 },
    { title: "Februar", month: "Feb", revenue: 70, cost: 90 },
  ])
    await command({ action: "row.create", pageId: db, cells });

  // In the app: one series per value, named in the legend.
  await page.goto(`/#page=${db}`);
  const valueTable = page.locator("table", { has: page.locator("th", { hasText: "Summe von Kosten" }) });
  await expect(valueTable.locator("th", { hasText: "Summe von Umsatz" })).toBeVisible();
  await expect(valueTable.locator("th", { hasText: "Gesamt" })).toHaveCount(0);
  await expect(valueTable.locator("tr", { hasText: "Jan" })).toContainText("150");
  // The configuration offers further values.
  await page.getByRole("button", { name: "Diagramm konfigurieren" }).click();
  await expect(page.getByRole("combobox", { name: "Weiterer Wert 1: Eigenschaft" })).toHaveValue("cost");
  await page.keyboard.press("Escape");

  // Published: the chart with both values and the feed.
  await command({ action: "page.publish", pageId: db, enabled: true });
  const token = (await (await page.request.get(`/api/pages/${db}`)).json()).page.public_token;
  const visitor = await (await browser.newContext()).newPage();
  await visitor.goto(`${origin}/share/${token}?view=chart`);
  const table = visitor.locator(".public-chart-table");
  await expect(table.locator("th", { hasText: "Summe von Kosten" })).toBeVisible();
  await expect(table.locator("tr", { hasText: "Jan" })).toContainText("150");
  await expect(table.locator("tr", { hasText: "Jan" })).toContainText("50");
  await expect(visitor.locator(".public-chart-legend")).toContainText("Summe von Umsatz");
  await visitor.goto(`${origin}/share/${token}?view=feed`);
  await expect(visitor.locator(".public-feed-entry")).toHaveCount(3);
  await expect(visitor.locator(".public-feed-entry").first()).toContainText("Umsatz");
});
