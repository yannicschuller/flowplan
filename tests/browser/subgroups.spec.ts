import { test, expect } from "@playwright/test";

test("tables and lists nest subgroups that collapse, create and move entries on both levels", async ({
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
    title: `Subgroups ${testInfo.project.name} ${Date.now()}`,
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
      {
        id: "prio",
        name: "Priorität",
        type: "select",
        options: ["Hoch", "Niedrig"],
      },
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
      },
      {
        id: "list",
        name: "Liste",
        type: "list",
        filters: [],
        sorts: [],
        groupBy: "status",
        subGroupBy: "prio",
      },
    ],
  });
  const ids: string[] = [];
  for (const cells of [
    { title: "Alpha", status: "Open", prio: "Hoch", amount: 3 },
    { title: "Beta", status: "Open", prio: "Niedrig", amount: 1 },
    { title: "Gamma", status: "Done", prio: "Hoch", amount: 5 },
  ])
    ids.push((await command({ action: "row.create", pageId: p.id, cells })).id);
  const find = async (id: string) =>
    (await read()).rows.find((r: { id: string }) => r.id === id);

  await page.goto(`/#page=${p.id}`);
  await page.getByTitle("Ansicht und Eigenschaften", { exact: true }).click();
  const settings = page.getByRole("dialog", {
    name: "Ansicht konfigurieren",
    exact: true,
  });
  const subSelect = settings.getByLabel("Untergruppen nach", { exact: true });
  // The primary field is not offered as its own subgroup.
  await expect(subSelect.locator("option")).toHaveText([
    "Keine Untergruppen",
    "Name",
    "Priorität",
    "Aufwand",
  ]);
  await subSelect.selectOption("prio");
  await expect
    .poll(async () => (await read()).database.views[0].subGroupBy)
    .toBe("prio");
  await settings
    .getByRole("button", { name: "Schließen", exact: true })
    .click();

  const open = page.getByRole("rowgroup", { name: "Gruppe Open", exact: true });
  const openHigh = page.getByRole("group", {
    name: "Untergruppe Hoch in Open",
    exact: true,
  });
  await expect(openHigh).toBeVisible();
  await expect(
    page.getByRole("group", {
      name: "Untergruppe Niedrig in Open",
      exact: true,
    }),
  ).toBeVisible();
  // Empty subgroups are not shown.
  await expect(
    page.getByRole("group", {
      name: "Untergruppe Niedrig in Done",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(openHigh.locator(".group-summary")).toHaveText("Aufwand: Σ 3");
  await expect(open.locator(".title-cell")).toHaveText(["Alpha", "Beta"]);

  await openHigh
    .getByRole("button", {
      name: "Untergruppe Hoch in Open einklappen",
      exact: true,
    })
    .click();
  await expect(open.locator(".title-cell")).toHaveText(["Beta"]);
  await page.reload();
  await expect(open.locator(".title-cell")).toHaveText(["Beta"]);
  await openHigh
    .getByRole("button", {
      name: "Untergruppe Hoch in Open ausklappen",
      exact: true,
    })
    .click();
  await expect(open.locator(".title-cell")).toHaveText(["Alpha", "Beta"]);

  // Adding from a subgroup presets both properties.
  await page
    .getByTitle("Eintrag in Done / Hoch hinzufügen", { exact: true })
    .click();
  const entry = page.getByRole("dialog", { name: "Eintrag", exact: true });
  await expect(entry).toBeVisible();
  await entry.getByRole("button", { name: "Schließen", exact: true }).click();
  await expect
    .poll(async () =>
      (await read()).rows
        .filter((r: { id: string }) => !ids.includes(r.id))
        .map((r: { cells: Record<string, unknown> }) => [
          r.cells.status,
          r.cells.prio,
        ]),
    )
    .toEqual([["Done", "Hoch"]]);

  if (testInfo.project.name === "desktop") {
    // Dragging onto another group's subgroup changes both properties at once.
    await open
      .getByRole("button", { name: "Eintrag verschieben: Beta", exact: true })
      .dragTo(
        page.getByRole("group", {
          name: "Untergruppe Hoch in Done",
          exact: true,
        }),
      );
    await expect
      .poll(async () => {
        const row = await find(ids[1]);
        return [row.cells.status, row.cells.prio];
      })
      .toEqual(["Done", "Hoch"]);
    expect((await find(ids[1])).version).toBe(2);
  } else {
    await open.locator(".title-cell").filter({ hasText: "Beta" }).tap();
    await entry
      .getByRole("combobox", { name: "Priorität", exact: true })
      .selectOption("Hoch");
    await expect.poll(async () => (await find(ids[1])).cells.prio).toBe("Hoch");
    await entry.getByRole("button", { name: "Schließen", exact: true }).click();
  }
  await page.screenshot({
    path: `test-results/subgroups-verification/${testInfo.project.name}-table.png`,
    fullPage: true,
    animations: "disabled",
  });

  await page.getByRole("button", { name: "Liste", exact: true }).click();
  const list = page.getByRole("region", { name: "Gruppe Open", exact: true });
  await expect(
    list.getByRole("group", { name: "Untergruppe Hoch in Open", exact: true }),
  ).toBeVisible();
  await expect(list.locator(".record-list-item")).toHaveCount(
    testInfo.project.name === "desktop" ? 1 : 2,
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await page.screenshot({
    path: `test-results/subgroups-verification/${testInfo.project.name}-list.png`,
    fullPage: true,
    animations: "disabled",
  });

  // Removing the primary grouping clears the subgroup setting.
  await page.getByTitle("Ansicht und Eigenschaften", { exact: true }).click();
  await settings
    .getByLabel("Gruppieren nach", { exact: true })
    .selectOption("");
  await expect
    .poll(async () => (await read()).database.views[1].subGroupBy)
    .toBeUndefined();
  expect(errors).toEqual([]);
  await command({ action: "page.delete", pageId: p.id });
});

test("board swimlanes group cards by a second property and move them across both levels", async ({
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
    title: `Swimlanes ${testInfo.project.name} ${Date.now()}`,
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
    ],
    views: [
      {
        id: "board",
        name: "Board",
        type: "board",
        filters: [],
        sorts: [],
        groupBy: "status",
      },
    ],
  });
  const ids: string[] = [];
  for (const cells of [
    { title: "Login", status: "Open", team: "Web" },
    { title: "Push", status: "Open", team: "App" },
    { title: "Export", status: "Done", team: "Web" },
  ])
    ids.push((await command({ action: "row.create", pageId: p.id, cells })).id);
  await page.goto(`/#page=${p.id}`);
  await expect(page.locator(".board")).toBeVisible();
  await expect(page.locator(".board-lane")).toHaveCount(0);
  await page.getByTitle("Ansicht und Eigenschaften", { exact: true }).click();
  const settings = page.getByRole("dialog", {
    name: "Ansicht konfigurieren",
    exact: true,
  });
  await settings
    .getByLabel("Swimlanes nach", { exact: true })
    .selectOption("team");
  await expect
    .poll(async () => (await read()).database.views[0].subGroupBy)
    .toBe("team");
  await settings
    .getByRole("button", { name: "Schließen", exact: true })
    .click();
  const web = page.getByRole("region", { name: "Swimlane Web", exact: true }),
    app = page.getByRole("region", { name: "Swimlane App", exact: true });
  await expect(web).toBeVisible();
  await expect(app).toBeVisible();
  const cell = (group: string, lane: string) =>
    page.getByRole("group", { name: `${group} · ${lane}`, exact: true });
  await expect(cell("Open", "Web").locator(".record-card strong")).toHaveText([
    "Login",
  ]);
  await expect(cell("Done", "App").locator(".record-card")).toHaveCount(0);
  await page.screenshot({
    path: `test-results/subgroups-verification/${testInfo.project.name}-swimlanes.png`,
    fullPage: true,
  });

  if (testInfo.project.name === "desktop") {
    await cell("Open", "App")
      .locator(".record-card")
      .dragTo(cell("Done", "Web"));
    await expect
      .poll(async () => {
        const row = (await read()).rows.find(
          (r: { id: string }) => r.id === ids[1],
        );
        return [row.cells.status, row.cells.team];
      })
      .toEqual(["Done", "Web"]);
    // The App lane has no cards left and disappears.
    await expect(app).toHaveCount(0);
  }
  await cell("Done", "Web")
    .getByTitle("Eintrag in Done / Web hinzufügen", { exact: true })
    .click();
  const entry = page.getByRole("dialog", { name: "Eintrag", exact: true });
  await expect(entry).toBeVisible();
  await entry.getByRole("button", { name: "Schließen", exact: true }).click();
  await expect
    .poll(async () =>
      (await read()).rows
        .filter((r: { id: string }) => !ids.includes(r.id))
        .map((r: { cells: Record<string, unknown> }) => [
          r.cells.status,
          r.cells.team,
        ]),
    )
    .toEqual([["Done", "Web"]]);

  await web
    .getByRole("button", { name: "Swimlane Web einklappen", exact: true })
    .click();
  await expect(web.locator(".record-card")).toHaveCount(0);
  await page.reload();
  await expect(
    web.getByRole("button", { name: "Swimlane Web ausklappen", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Gruppe Done einklappen", exact: true })
    .click();
  await expect(page.locator(".board-lane-column.collapsed")).toHaveCount(1);
  expect(errors).toEqual([]);
  await command({ action: "page.delete", pageId: p.id });
});
