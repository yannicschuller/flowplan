import { test, expect } from "@playwright/test";

test("charts split groups into data series with legend, stacking, drill-down and CSV", async ({
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
    title: `Reihen ${testInfo.project.name} ${Date.now()}`,
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
      {
        id: "status",
        name: "Status",
        type: "select",
        options: ["Open", "Done"],
      },
      { id: "team", name: "Team", type: "select", options: ["Web", "App"] },
      { id: "amount", name: "Aufwand", type: "number" },
    ],
    views: [
      {
        id: "chart",
        name: "Auswertung",
        type: "chart",
        filters: [],
        sorts: [],
        chart: {
          kind: "bar",
          xField: "status",
          aggregate: "sum",
          yField: "amount",
          dateBucket: "month",
          order: "label_asc",
          includeEmpty: false,
          showValues: true,
        },
      },
    ],
  });
  for (const cells of [
    { title: "A", status: "Open", team: "Web", amount: 3 },
    { title: "B", status: "Open", team: "App", amount: 5 },
    { title: "C", status: "Done", team: "Web", amount: 2 },
  ])
    await command({ action: "row.create", pageId: p.id, cells });
  await page.goto(`/#page=${p.id}`);
  await expect(
    page.getByLabel("Säulendiagramm", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Diagramm konfigurieren" }).click();
  const dialog = page.getByRole("dialog", {
    name: "Diagramm konfigurieren",
    exact: true,
  });
  await dialog.getByLabel("Datenreihen", { exact: true }).selectOption("team");
  await dialog
    .getByLabel("Darstellung der Reihen", { exact: true })
    .selectOption("stacked");
  await dialog.getByRole("button", { name: "Anwenden", exact: true }).click();
  await expect
    .poll(async () => (await read()).database.views[0].chart)
    .toMatchObject({ seriesField: "team", seriesMode: "stacked" });
  await expect(
    page.getByLabel("Säulendiagramm mit Datenreihen", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("list", { name: "Legende" }).getByRole("listitem"),
  ).toHaveText(["App", "Web"]);
  // Stacks show the group total.
  await expect(
    page
      .getByLabel("Säulendiagramm mit Datenreihen", { exact: true })
      .locator('text[text-anchor="middle"]')
      .filter({ hasText: /^8$/ }),
  ).toBeVisible();
  await expect(page.locator(".chart-data thead th")).toHaveText([
    "Gruppe",
    "App",
    "Web",
    "Gesamt",
    "Einträge",
  ]);
  await page.screenshot({
    path: `test-results/chart-series-verification/${testInfo.project.name}-stacked.png`,
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Open · App: 5 · 1 Einträge", exact: true })
    .click();
  const entries = page.getByRole("dialog", {
    name: "Einträge · Open · App",
    exact: true,
  });
  await expect(entries.getByRole("button")).toContainText(["B"]);
  await entries.getByRole("button", { name: "Schließen", exact: true }).click();

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Auswertung als CSV" }).click();
  const csv = await (await downloadPromise).createReadStream();
  const text = await new Promise<string>((resolve) => {
    let data = "";
    csv.on("data", (chunk) => (data += chunk));
    csv.on("end", () => resolve(data));
  });
  expect(text.replace(/^﻿/, "").split(/\r?\n/)[0]).toBe(
    "Gruppe,App,Web,Gesamt,Einträge",
  );
  // Palettes and grid lines are view options.
  await page.getByRole("button", { name: "Diagramm konfigurieren" }).click();
  await dialog.getByLabel("Farbpalette").selectOption("warm");
  await dialog.getByLabel("Gitterlinien anzeigen").uncheck();
  await dialog.getByRole("button", { name: "Anwenden", exact: true }).click();
  await expect
    .poll(async () => (await read()).database.views[0].chart)
    .toMatchObject({ palette: "warm", showGrid: false });
  await expect(
    page
      .getByRole("list", { name: "Legende" })
      .locator(".chart-swatch")
      .first(),
  ).toHaveCSS("background-color", "rgb(194, 85, 58)");
  await expect(page.locator(".chart-scroll .chart-grid").first()).toBeHidden();
  // Line charts draw one line per series.
  await page.getByRole("button", { name: "Diagramm konfigurieren" }).click();
  await dialog.getByLabel("Diagrammtyp").selectOption("line");
  await dialog.getByRole("button", { name: "Anwenden", exact: true }).click();
  await expect(
    page
      .getByLabel("Liniendiagramm mit Datenreihen", { exact: true })
      .locator("polyline"),
  ).toHaveCount(2);
  expect(errors).toEqual([]);
  await command({ action: "page.delete", pageId: p.id });
});
