import { test, expect, type Locator, type Page } from "@playwright/test";

// #607: a date in a table cell is edited in a popover anchored to the cell
// – the date, "+ Uhrzeit", the time, "Datum entfernen" and the time zone
// have room there; inside the cell (overflow hidden, 44 px high) they were
// clipped by a narrow column and spilled out of the row. Enter saves and
// closes, Escape closes without saving, Tab goes on from the cell, a click
// elsewhere saves.
test.use({ timezoneId: "UTC" });
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";

async function setup(page: Page, name: string) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const db = await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    title: `${name} ${Date.now()}`,
    kind: "database",
  });
  const read = async () => (await page.request.get(`/api/pages/${db.id}`)).json();
  const initial = await read();
  await command({
    action: "database.update",
    pageId: db.id,
    version: initial.database.version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "due", name: "Fällig", type: "date" },
      { id: "note", name: "Notiz", type: "text" },
    ],
    // A narrow date column: the editor used to be cut off at its border.
    views: [{ id: "table", name: "Tabelle", type: "table", filters: [], sorts: [], columnWidths: { due: 110 } }],
  });
  const row = await command({ action: "row.create", pageId: db.id, cells: { title: "Steuer", due: "2026-11-03" } });
  const due = async () => (await read()).rows.find((r: { id: string }) => r.id === row.id).cells.due ?? "";
  await page.goto(`/#page=${db.id}`);
  const skip = page.getByRole("dialog").getByRole("button", { name: "Überspringen" });
  if (await skip.waitFor({ timeout: 5000 }).then(() => true, () => false)) await skip.click();
  const tr = page.locator(`tr[data-row-id="${row.id}"]`);
  await expect(tr).toBeVisible({ timeout: 30_000 });
  return { tr, cell: tr.locator("td").nth(2), due };
}

// The popover is whole on screen, below or above its cell.
async function fullyShown(page: Page, popover: Locator, cell: Locator) {
  const box = (await popover.boundingBox())!;
  const at = (await cell.boundingBox())!;
  const view = page.viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(view.width);
  expect(box.y >= at.y + at.height - 1 || box.y + box.height <= at.y + 1).toBe(true);
  // Every control has its full width inside the popover.
  for (const control of await popover.locator("input, button").all()) {
    const c = (await control.boundingBox())!;
    expect(c.x).toBeGreaterThanOrEqual(box.x);
    expect(c.x + c.width).toBeLessThanOrEqual(box.x + box.width + 0.5);
  }
}

test("#607: a table's date opens in a popover beside the cell, keys as in the other cells", async ({ page }, info) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { tr, cell, due } = await setup(page, "Datumszelle");
  const editor = page.getByRole("dialog", { name: "Fällig", exact: true });
  const date = editor.getByLabel("Fällig", { exact: true });

  await cell.click();
  await expect(editor).toBeVisible();
  await expect(date).toBeFocused();
  await expect(date).toHaveValue("2026-11-03");
  // Not inside the cell: it is cut off there.
  expect(await editor.evaluate((el) => !!el.closest("td"))).toBe(false);
  // The cell still shows its value.
  await expect(cell).toContainText("2026");
  await fullyShown(page, editor, cell);

  // "+ Uhrzeit": the time, the buttons and the time zone fit as well.
  await editor.getByRole("button", { name: "Uhrzeit hinzufügen: Fällig", exact: true }).click();
  const time = editor.getByLabel("Fällig: Uhrzeit", { exact: true });
  await expect(time).toBeFocused();
  await expect(editor.getByText("Zeitzone: UTC")).toBeVisible();
  await fullyShown(page, editor, cell);
  await page.screenshot({ path: info.outputPath(`date-cell-time-${info.project.name}.png`) });
  // Enter saves and closes; the row keeps the focus.
  await time.fill("10:30");
  await time.press("Enter");
  await expect(editor).toHaveCount(0);
  await expect(tr).toBeFocused();
  await expect.poll(due).toBe("2026-11-03T10:30:00Z");
  await expect(cell).toContainText("10:30");

  // Escape closes without saving.
  await cell.click();
  await expect(date).toBeFocused();
  await date.fill("2026-12-24");
  await date.press("Escape");
  await expect(editor).toHaveCount(0);
  await expect(tr).toBeFocused();
  await page.waitForTimeout(400);
  expect(await due()).toBe("2026-11-03T10:30:00Z");

  if (info.project.name === "desktop") {
    // Tab past the last control saves and goes on from the cell.
    await cell.click();
    await date.fill("2026-12-24");
    const controls = editor.locator("input, button");
    await controls.last().focus();
    await page.keyboard.press("Tab");
    await expect(editor).toHaveCount(0);
    await expect.poll(due).toBe("2026-12-24T10:30:00Z");
    // Shift+Tab before the first one goes back from the cell.
    await cell.click();
    await expect(date).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(editor).toHaveCount(0);
    await expect(page.locator("body")).not.toBeFocused();
  }

  // A click elsewhere saves and closes: "Datum entfernen" empties it.
  await cell.click();
  await editor.getByRole("button", { name: "Datum entfernen: Fällig", exact: true }).click();
  await expect.poll(due).toBe("");
  await page.locator("h1, .page-title").first().click();
  await expect(editor).toHaveCount(0);
  expect(errors).toEqual([]);
});
