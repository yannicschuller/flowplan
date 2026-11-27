import { test, expect } from "@playwright/test";

// #638: "Zellen umbrechen" in "Configure view" of a table. Off, a long note
// is one line with "…"; on, the row grows and the note shows in full, top
// aligned, the chips of a multi-select on several lines – one huge note at
// most 10 lines – and the setting is kept with the view after a reload.
test("#638: wrap cells shows the whole note and stays after a reload", async ({ page }, info) => {
  test.setTimeout(120_000);
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
  const db = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Umbruch ${info.project.name}`, kind: "database" });
  const first = await (await page.request.get(`/api/pages/${db.id}`)).json();
  await command({
    action: "database.update",
    pageId: db.id,
    version: first.database.version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "notes", name: "Notizen", type: "text" },
      { id: "tags", name: "Tags", type: "multiselect", options: ["Design", "Produkt", "Entwicklung", "Dokumentation"] },
    ],
    views: [{ id: "table", name: "Tabelle", type: "table", filters: [], sorts: [], columnWidths: { notes: 240, tags: 160 } }],
  });
  const note = "Erst die Migration auf einer Kopie der Daten prüfen, dann jeden Schritt aufschreiben, der von Hand nachgebessert werden musste. Ende der Notiz.";
  await command({ action: "row.create", pageId: db.id, cells: { title: "Plan A", notes: note, tags: ["Design", "Produkt", "Entwicklung", "Dokumentation"] } });
  await command({ action: "row.create", pageId: db.id, cells: { title: "Riesig", notes: `${note} `.repeat(20) } });
  const stored = async () => (await (await page.request.get(`/api/pages/${db.id}`)).json()).database.views[0];

  await page.goto(`/#page=${db.id}`);
  const table = page.locator(".data-table");
  await expect(table).toBeVisible({ timeout: 30_000 });
  const row = table.locator("tbody tr[data-row-id]").filter({ hasText: "Plan A" });
  const cell = row.getByRole("gridcell").filter({ hasText: "Erst die Migration" });
  await expect(cell).toBeVisible();
  // The huge note's row has no chips (which wrapped before already).
  const hugeRow = table.locator("tbody tr[data-row-id]").filter({ hasText: "Riesig" });
  const hugeCell = hugeRow.getByRole("gridcell").filter({ hasText: "Erst die Migration" });
  // Off (the default): one line, cut with an ellipsis.
  await expect(table).not.toHaveClass(/wrap-cells/);
  const oneLine = (await hugeRow.boundingBox())!.height;
  expect(oneLine).toBeLessThan(60);
  expect(await cell.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  expect(await hugeCell.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);

  // Switched on in "Configure view".
  const settings = page.getByRole("dialog", { name: "Ansicht konfigurieren", exact: true });
  await page.getByTitle("Ansicht und Eigenschaften", { exact: true }).click();
  await expect(settings).toBeVisible();
  const wrap = settings.getByRole("checkbox", { name: "Zellen umbrechen", exact: true });
  await expect(wrap).not.toBeChecked();
  await wrap.check();
  await expect.poll(async () => (await stored()).wrapCells, { timeout: 15_000 }).toBe(true);
  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();

  const wrapped = async () => {
    await expect(table).toHaveClass(/wrap-cells/);
    // The rows grew; the note shows in full – nothing cut sideways or below.
    await expect.poll(async () => (await hugeRow.boundingBox())!.height).toBeGreaterThan(oneLine * 3);
    const noteHeight = (await cell.boundingBox())!.height;
    expect(noteHeight).toBeGreaterThan(oneLine);
    const value = cell.locator(".cell-wrap");
    expect(await value.evaluate((el) => el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1)).toBe(true);
    expect(await cell.evaluate((el) => getComputedStyle(el).verticalAlign)).toBe("top");
    // Every cell of the row is as tall as the row, the pinned title too,
    // and its text starts at the top like the note's.
    const rowBox = (await row.boundingBox())!;
    for (const box of await row.getByRole("gridcell").evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height)))
      expect(Math.abs(box - rowBox.height)).toBeLessThanOrEqual(2);
    const top = async (locator: typeof cell) => (await locator.boundingBox())!.y;
    expect(Math.abs((await top(row.locator(".row-title-text"))) - (await top(value)))).toBeLessThanOrEqual(4);
    // The four chips of the multi-select run onto more than one line.
    const chipTops = await row.locator(".tags .tag").evaluateAll((els) => new Set(els.map((el) => Math.round(el.getBoundingClientRect().top))).size);
    expect(chipTops).toBeGreaterThan(1);
    // A huge note stops at 10 lines (1.5 × 13–14 px each) with "…".
    const huge = hugeCell.locator(".cell-wrap");
    const clamp = await huge.evaluate((el) => ({ height: el.clientHeight, full: el.scrollHeight, line: parseFloat(getComputedStyle(el).lineHeight) }));
    expect(clamp.full).toBeGreaterThan(clamp.height);
    expect(clamp.height).toBeLessThanOrEqual(clamp.line * 10 + 1);
    expect(clamp.height).toBeGreaterThanOrEqual(clamp.line * 9);
  };
  await wrapped();
  if (process.env.WRAP_SCREENSHOT_DIR)
    await page.screenshot({ path: `${process.env.WRAP_SCREENSHOT_DIR}/wrap-cells-${info.project.name}.png` });

  // A cell still opens its editor in a tall row, at the top of the cell.
  await cell.click();
  const editor = row.locator(".inline-cell");
  await expect(editor).toBeVisible();
  expect(Math.abs((await editor.boundingBox())!.y - (await cell.boundingBox())!.y)).toBeLessThanOrEqual(14);

  // Kept with the view: after a reload the table still wraps.
  await page.reload();
  await expect(table).toBeVisible({ timeout: 30_000 });
  await wrapped();

  // Off again: one line as before, and the view forgets the setting.
  await page.getByTitle("Ansicht und Eigenschaften", { exact: true }).click();
  await settings.getByRole("checkbox", { name: "Zellen umbrechen", exact: true }).uncheck();
  await expect.poll(async () => (await stored()).wrapCells, { timeout: 15_000 }).toBeUndefined();
  await page.keyboard.press("Escape");
  await expect(table).not.toHaveClass(/wrap-cells/);
  await expect.poll(async () => (await hugeRow.boundingBox())!.height).toBeLessThan(60);
  expect(errors).toEqual([]);
});
