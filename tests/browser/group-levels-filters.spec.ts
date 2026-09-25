import { test, expect } from "@playwright/test";

test("tables and boards nest a third group level and filters match several values and ranges", async ({
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
    title: `Ebenen ${testInfo.project.name} ${Date.now()}`,
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
      {
        id: "status",
        name: "Status",
        type: "select",
        options: ["Open", "Done"],
      },
      {
        id: "prio",
        name: "Priorität",
        type: "select",
        options: ["Hoch", "Niedrig"],
      },
      { id: "team", name: "Team", type: "select", options: ["Nord", "Süd"] },
      { id: "amount", name: "Aufwand", type: "number" },
    ],
    views: [
      {
        id: "table",
        name: "Tabelle",
        type: "table",
        filters: [],
        sorts: [],
        groupBy: "status",
        subGroupBy: "prio",
      },
      {
        id: "board",
        name: "Board",
        type: "board",
        filters: [],
        sorts: [],
        groupBy: "status",
        subGroupBy: "prio",
        groupLevels: ["team"],
      },
    ],
  });
  for (const cells of [
    { title: "Alpha", status: "Open", prio: "Hoch", team: "Nord", amount: 3 },
    { title: "Beta", status: "Open", prio: "Hoch", team: "Süd", amount: 1 },
    {
      title: "Gamma",
      status: "Done",
      prio: "Niedrig",
      team: "Nord",
      amount: 8,
    },
  ])
    await command({ action: "row.create", pageId: p.id, cells });

  await page.goto(`/#page=${p.id}`);
  await page.getByTitle("Ansicht und Eigenschaften", { exact: true }).click();
  const settings = page.getByRole("dialog", {
    name: "Ansicht konfigurieren",
    exact: true,
  });
  const level3 = settings.getByLabel("Gruppenebene 3", { exact: true });
  await expect(level3.locator("option")).toHaveText([
    "Keine weitere Ebene",
    "Name",
    "Team",
    "Aufwand",
  ]);
  await level3.selectOption("team");
  await expect
    .poll(async () => (await read()).database.views[0].groupLevels)
    .toEqual(["team"]);
  // A fourth level becomes available once the third is set.
  await expect(
    settings.getByLabel("Gruppenebene 4", { exact: true }),
  ).toBeVisible();
  await settings
    .getByRole("button", { name: "Schließen", exact: true })
    .click();

  const nord = page.getByRole("group", {
    name: "Gruppe Nord in Open / Hoch",
    exact: true,
  });
  await expect(nord).toBeVisible();
  await expect(nord.locator(".group-summary")).toHaveText("Aufwand: Σ 3");
  await expect(
    page.getByRole("group", { name: "Gruppe Süd in Open / Hoch", exact: true }),
  ).toBeVisible();
  // Collapsing the third level hides its rows and persists.
  await nord
    .getByRole("button", { name: "Gruppe Nord in Open / Hoch einklappen" })
    .click();
  await expect(page.locator(".title-cell", { hasText: "Alpha" })).toHaveCount(
    0,
  );
  await expect(page.locator(".title-cell", { hasText: "Beta" })).toHaveCount(1);
  // New entries in a third-level group take all three values.
  await page
    .getByRole("group", { name: "Gruppe Süd in Open / Hoch", exact: true })
    .getByTitle("Eintrag in Open / Hoch / Süd hinzufügen")
    .click();
  await expect
    .poll(async () =>
      (await read()).rows.some(
        (r: { cells: Record<string, unknown> }) =>
          r.cells.title === "Neue Aufgabe" &&
          r.cells.status === "Open" &&
          r.cells.prio === "Hoch" &&
          r.cells.team === "Süd",
      ),
    )
    .toBe(true);
  const entry = page.getByRole("dialog", { name: "Eintrag", exact: true });
  await entry.getByRole("button", { name: "Schließen", exact: true }).click();
  await expect(entry).toHaveCount(0);

  // Filters: any of several options and a number range.
  await page
    .getByRole("button", { name: /^Filtern/ })
    .first()
    .click();
  const filter = page.getByRole("dialog", {
    name: "Filter bearbeiten",
    exact: true,
  });
  await filter
    .getByRole("button", { name: "Bedingung hinzufügen", exact: true })
    .click();
  await filter
    .getByLabel("Filter-Eigenschaft", { exact: true })
    .selectOption("team");
  await filter
    .getByLabel("Filterbedingung", { exact: true })
    .selectOption("any_of");
  const values = filter.getByRole("group", { name: "Filterwerte" });
  await values.getByRole("checkbox", { name: "Nord" }).check();
  await filter.getByRole("button", { name: "Anwenden", exact: true }).click();
  await expect(filter).not.toBeVisible();
  await expect
    .poll(
      async () =>
        (await read()).database.views[0].filters?.[0]?.values ??
        (await read()).database.views[0].filterGroup?.rules?.[0]?.values,
    )
    .toEqual(["Nord"]);
  await page
    .getByRole("button", { name: /^Filtern/ })
    .first()
    .click();
  await filter
    .getByRole("button", { name: "Bedingung hinzufügen", exact: true })
    .click();
  const second = filter.getByRole("group", {
    name: "Bedingung 2",
    exact: true,
  });
  await second
    .getByLabel("Filter-Eigenschaft", { exact: true })
    .selectOption("amount");
  await second
    .getByLabel("Filterbedingung", { exact: true })
    .selectOption("between");
  await second.getByLabel("Filterwert", { exact: true }).fill("5");
  await second.getByLabel("Filterwert bis", { exact: true }).fill("10");
  await filter.getByRole("button", { name: "Anwenden", exact: true }).click();
  await expect(page.locator(".title-cell")).toHaveText(["Gamma"]);

  // The board shows the third level as sections inside swimlane cells.
  await page.getByRole("button", { name: "Board", exact: true }).click();
  const cell = page.getByRole("group", { name: "Open · Hoch", exact: true });
  await expect(
    cell.getByRole("region", { name: "Abschnitt Nord" }),
  ).toContainText("Alpha");
  await expect(
    cell.getByRole("region", { name: "Abschnitt Süd" }),
  ).toContainText("Beta");
  await page.screenshot({
    path: `test-results/group-levels-filters/${testInfo.project.name}.png`,
    fullPage: true,
  });
  expect(errors).toEqual([]);
  await command({ action: "page.delete", pageId: p.id });
});
