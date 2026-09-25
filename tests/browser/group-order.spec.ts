import { test, expect, type Page } from "@playwright/test";

async function setup(page: Page, title: string) {
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
    title,
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
        options: ["Open", "Doing", "Done"],
      },
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
      {
        id: "table",
        name: "Tabelle",
        type: "table",
        filters: [],
        sorts: [],
        groupBy: "status",
      },
    ],
  });
  for (const cells of [
    { title: "Alpha", status: "Open" },
    { title: "Beta", status: "Doing" },
    { title: "Gamma", status: "Done" },
  ])
    await command({ action: "row.create", pageId: p.id, cells });
  return { p, read, command };
}

const boardLabels = (page: Page) =>
  page
    .locator(".board-column")
    .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("aria-label")));

test("board and table groups reorder, collapse and reset with persistence", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { p, read, command } = await setup(
    page,
    `Group order ${testInfo.project.name} ${Date.now()}`,
  );
  await page.goto(`/#page=${p.id}`);
  await expect(page.locator(".board")).toBeVisible();
  await expect
    .poll(() => boardLabels(page))
    .toEqual([
      "Gruppe Open",
      "Gruppe Doing",
      "Gruppe Done",
      "Gruppe Ohne Gruppe",
    ]);
  const board = page.locator(".board");
  await expect(
    board.getByRole("button", {
      name: "Gruppe Open nach links verschieben",
      exact: true,
    }),
  ).toBeDisabled();
  await board
    .getByRole("button", {
      name: "Gruppe Open nach rechts verschieben",
      exact: true,
    })
    .click();
  await expect
    .poll(() => boardLabels(page))
    .toEqual([
      "Gruppe Doing",
      "Gruppe Open",
      "Gruppe Done",
      "Gruppe Ohne Gruppe",
    ]);
  await expect
    .poll(async () => (await read()).database.views[0].groupSettings?.order)
    .toEqual(['"Doing"', '"Open"', '"Done"', "empty"]);

  if (testInfo.project.name === "desktop") {
    await page
      .locator('.board-column[aria-label="Gruppe Done"] > header')
      .dragTo(page.locator('.board-column[aria-label="Gruppe Doing"]'));
    await expect(
      board.getByRole("button", { name: "Gruppe Done ziehen" }),
    ).toBeHidden();
  } else {
    // Touch: drag the column handle onto another column; the board scrolls
    // sideways when the target is off-screen.
    const handle = board.getByRole("button", { name: "Gruppe Done ziehen" });
    const target = page.locator('.board-column[aria-label="Gruppe Doing"]');
    await target.scrollIntoViewIfNeeded();
    await handle.scrollIntoViewIfNeeded();
    const from = (await handle.boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    const width = page.viewportSize()!.width;
    // Rest at the left edge until the first column is reachable.
    await page.mouse.move(4, from.y + from.height / 2, { steps: 6 });
    await expect
      .poll(async () => (await target.boundingBox())?.x ?? -1000)
      .toBeGreaterThanOrEqual(0);
    await page.waitForTimeout(300);
    const to = (await target.boundingBox())!;
    await page.mouse.move(
      Math.min(to.x + to.width / 2, width - 60),
      to.y + 40,
      { steps: 4 },
    );
    await expect(target).toHaveClass(/group-drop/);
    await page.mouse.up();
  }
  await expect
    .poll(() => boardLabels(page))
    .toEqual([
      "Gruppe Done",
      "Gruppe Doing",
      "Gruppe Open",
      "Gruppe Ohne Gruppe",
    ]);

  const doing = page.locator('.board-column[aria-label="Gruppe Doing"]');
  await expect(doing.locator(".record-card")).toHaveCount(1);
  await doing
    .getByRole("button", { name: "Gruppe Doing einklappen", exact: true })
    .click();
  await expect(doing).toHaveClass(/collapsed/);
  await expect(doing.locator(".record-card")).toHaveCount(0);
  await expect(doing.locator(".muted")).toHaveText("1");
  await page.screenshot({
    path: `test-results/group-order-verification/${testInfo.project.name}-board.png`,
  });
  // A new option appears in its property slot without losing the saved order.
  const current = await read();
  await command({
    action: "database.update",
    pageId: p.id,
    version: current.database.version,
    fields: current.database.fields.map((f: { id: string }) =>
      f.id === "status"
        ? { ...f, options: ["Open", "Review", "Doing", "Done"] }
        : f,
    ),
    views: current.database.views,
  });
  await page.reload();
  // Both platforms moved "Done" to the front by dragging.
  const expected = ["Done", "Review", "Doing", "Open", "Ohne Gruppe"];
  await expect
    .poll(() => boardLabels(page))
    .toEqual(expected.map((l) => `Gruppe ${l}`));
  await expect(doing).toHaveClass(/collapsed/);
  await doing
    .getByRole("button", { name: "Gruppe Doing ausklappen", exact: true })
    .click();
  await expect(doing.locator(".record-card")).toHaveCount(1);

  // Table groups have their own order; buttons work with keyboard focus.
  await page.getByRole("button", { name: "Tabelle", exact: true }).click();
  const tableLabels = () =>
    page
      .locator(".data-table tbody")
      .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("aria-label")));
  await expect
    .poll(tableLabels)
    .toEqual(["Gruppe Open", "Gruppe Doing", "Gruppe Done"]);
  const down = page.getByRole("button", {
    name: "Gruppe Open nach unten verschieben",
    exact: true,
  });
  await down.focus();
  await page.keyboard.press("Enter");
  await expect
    .poll(tableLabels)
    .toEqual(["Gruppe Doing", "Gruppe Open", "Gruppe Done"]);
  await page.reload();
  await page.getByRole("button", { name: "Tabelle", exact: true }).click();
  await expect
    .poll(tableLabels)
    .toEqual(["Gruppe Doing", "Gruppe Open", "Gruppe Done"]);
  await page.getByTitle("Ansicht und Eigenschaften", { exact: true }).click();
  const settings = page.getByRole("dialog", {
    name: "Ansicht konfigurieren",
    exact: true,
  });
  await expect(
    settings.getByLabel("Gruppen sortieren", { exact: true }),
  ).toContainText("Eigene Reihenfolge");
  await settings
    .getByRole("button", {
      name: "Gruppenreihenfolge zurücksetzen",
      exact: true,
    })
    .click();
  await expect
    .poll(async () => (await read()).database.views[1].groupSettings?.order)
    .toEqual([]);
  await settings
    .getByRole("button", { name: "Schließen", exact: true })
    .click();
  await expect
    .poll(tableLabels)
    .toEqual(["Gruppe Open", "Gruppe Doing", "Gruppe Done"]);
  // The board keeps its own saved order.
  expect((await read()).database.views[0].groupSettings.order.length).toBe(4);
  expect(errors).toEqual([]);
  await command({ action: "page.delete", pageId: p.id });
});
