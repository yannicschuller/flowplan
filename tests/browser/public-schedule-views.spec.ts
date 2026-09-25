import { test, expect } from "@playwright/test";

test("published databases show calendar, timeline and chart views", async ({
  page,
  browser,
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
    title: `Plan öffentlich ${testInfo.project.name} ${Date.now()}`,
    kind: "database",
  });
  const read = async () =>
    (await page.request.get(`/api/pages/${p.id}`)).json();
  const month = new Date().toISOString().slice(0, 7);
  await command({
    action: "database.update",
    pageId: p.id,
    version: (await read()).database.version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      {
        id: "status",
        name: "Status",
        type: "select",
        options: ["Offen", "Fertig"],
      },
      { id: "start", name: "Beginn", type: "date" },
      { id: "end", name: "Ende", type: "date" },
      { id: "owner", name: "Zuständig", type: "person" },
    ],
    views: [
      {
        id: "calendar",
        name: "Kalender",
        type: "calendar",
        filters: [],
        sorts: [],
        dateField: "start",
        endDateField: "end",
      },
      {
        id: "timeline",
        name: "Zeitplan",
        type: "timeline",
        filters: [],
        sorts: [],
        dateField: "start",
        endDateField: "end",
      },
      {
        id: "chart",
        name: "Diagramm",
        type: "chart",
        filters: [],
        sorts: [],
        chart: {
          kind: "bar",
          xField: "status",
          aggregate: "count",
          dateBucket: "month",
          order: "label_asc",
          includeEmpty: false,
          showValues: true,
        },
      },
      {
        id: "people",
        name: "Nach Person",
        type: "chart",
        filters: [],
        sorts: [],
        chart: {
          kind: "bar",
          xField: "owner",
          aggregate: "count",
          dateBucket: "month",
          order: "label_asc",
          includeEmpty: false,
          showValues: true,
        },
      },
    ],
  });
  const weekly = await command({
    action: "row.create",
    pageId: p.id,
    cells: {
      title: "Jour fixe",
      status: "Offen",
      start: `${month}-02`,
      owner: boot.user.id,
    },
  });
  await command({
    action: "row.recurrence",
    pageId: p.id,
    rowId: weekly.id,
    version: 1,
    recurrence: { freq: "weekly", interval: 1 },
  });
  await command({
    action: "row.create",
    pageId: p.id,
    cells: {
      title: "Umsetzung",
      status: "Fertig",
      start: `${month}-12`,
      end: `${month}-14`,
    },
  });
  await command({ action: "page.publish", pageId: p.id, enabled: true });
  const token = (await read()).page.public_token;

  const visitorContext = await browser.newContext();
  const visitor = await visitorContext.newPage();
  visitor.on("pageerror", (e) => errors.push(e.message));
  await visitor.goto(`${origin}/share/${token}`);
  const views = visitor.getByRole("navigation", { name: "Ansichten" });
  // Grouping by people would reveal them, so that chart is not published.
  await expect(views.getByRole("link")).toHaveText([
    "Kalender",
    "Zeitplan",
    "Diagramm",
  ]);
  await expect(visitor.locator("body")).not.toContainText(boot.user.name);
  const day = (d: string) =>
    visitor.locator(`.public-calendar-day[data-day="${month}-${d}"]`);
  await expect(day("02")).toContainText("Jour fixe");
  await expect(day("09").locator(".occurrence")).toHaveText("Jour fixe");
  for (const d of ["12", "13", "14"])
    await expect(day(d)).toContainText("Umsetzung");
  await expect(day("15")).not.toContainText("Umsetzung");
  await visitor.screenshot({
    path: `test-results/public-schedule-verification/${testInfo.project.name}-calendar.png`,
    fullPage: true,
  });
  await visitor.getByRole("link", { name: "Nächster Monat" }).click();
  await expect(visitor).toHaveURL(/month=\d{4}-\d{2}/);
  await expect(visitor.locator(".public-calendar")).not.toContainText(
    "Umsetzung",
  );
  await visitor.getByRole("link", { name: "Vorheriger Monat" }).click();
  await day("12").getByRole("link", { name: "Umsetzung" }).click();
  await expect(
    visitor.getByRole("heading", { name: "Umsetzung" }),
  ).toBeVisible();

  await visitor.goto(`${origin}/share/${token}?view=timeline&month=${month}`);
  const timeline = visitor.getByRole("region", { name: "Timeline" });
  await expect(timeline.getByRole("link", { name: "Umsetzung" })).toBeVisible();
  await expect(timeline).toContainText(`${month}-12 – ${month}-14`);
  await expect(timeline.locator(".public-timeline-bar").first()).toBeVisible();

  await views.getByRole("link", { name: "Diagramm" }).click();
  const table = visitor.locator(".public-chart-table tbody tr");
  await expect(table).toHaveText([/Fertig\s*1/, /Offen\s*1/]);
  await expect(visitor.locator(".public-bar")).toHaveCount(2);
  await visitor.screenshot({
    path: `test-results/public-schedule-verification/${testInfo.project.name}-chart.png`,
    fullPage: true,
  });
  // The unpublished chart falls back to the first public view.
  await visitor.goto(`${origin}/share/${token}?view=people`);
  await expect(visitor.locator(".public-calendar")).toBeVisible();
  await visitorContext.close();
  expect(errors).toEqual([]);
  await command({ action: "page.delete", pageId: p.id });
});
