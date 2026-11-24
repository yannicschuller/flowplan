import { test, expect } from "@playwright/test";

// Own units of number properties (#522): "12,5 kg" in the table and the sum.
test("a number property with its own unit shows it in cells and the sum", async ({ page }, testInfo) => {
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
    title: `Einheit ${testInfo.project.name} ${Date.now()}`,
    kind: "database",
  });
  try {
    const read = async () => (await page.request.get(`/api/pages/${p.id}`)).json();
    const initial = await read();
    const fields = [
      { id: "title", name: "Name", type: "text" },
      { id: "weight", name: "Gewicht", type: "number" },
    ];
    const views = [{ id: "table", name: "Tabelle", type: "table", filters: [], sorts: [], calculations: { weight: "sum" } }];
    // The server refuses a unit that is too long.
    const tooLong = await page.request.post("/api/command", {
      headers: { origin },
      data: {
        action: "database.update",
        pageId: p.id,
        version: initial.database.version,
        fields: [fields[0], { ...fields[1], unit: "x".repeat(13) }],
        views,
      },
    });
    expect(tooLong.status()).toBe(400);
    await command({ action: "database.update", pageId: p.id, version: initial.database.version, fields, views });
    const box = await command({ action: "row.create", pageId: p.id, cells: { title: "Kiste", weight: 10 } });
    await command({ action: "row.create", pageId: p.id, cells: { title: "Tüte", weight: 2.5 } });
    await page.goto(`/#page=${p.id}`);
    const table = page.locator(".data-table");
    await expect(table).toBeVisible();
    await table.locator("thead").getByRole("button", { name: /^\W*Gewicht$/ }).click();
    const dialog = page.getByRole("dialog", { name: "Eigenschaft bearbeiten" });
    const unit = dialog.getByLabel("Einheit");
    await expect(unit).toHaveAttribute("placeholder", "z. B. kg, m, h");
    await unit.fill("kg");
    // Currencies carry their own sign: no unit field there.
    await dialog.getByLabel("Zahlenformat").selectOption("eur");
    await expect(unit).toBeHidden();
    await dialog.getByLabel("Zahlenformat").selectOption("");
    await expect(unit).toHaveValue("kg");
    await dialog.getByRole("button", { name: "Speichern", exact: true }).click();
    await expect.poll(async () => (await read()).database.fields[1].unit).toBe("kg");
    // The stored values stay numbers.
    expect((await read()).rows.map((r: { cells: { weight: unknown } }) => r.cells.weight).sort()).toEqual([10, 2.5].sort());
    await expect(table.locator("tbody")).toContainText("2,5\u202fkg");
    await expect(table.locator("tbody")).toContainText("10\u202fkg");
    await expect(table.locator("tfoot")).toContainText("Σ 12,5\u202fkg");
    await page.screenshot({ path: `test-results/number-unit-verification/${testInfo.project.name}-table.png` });
    // The record view: the value with its unit (compact rows, #519); a
    // click opens a plain number input with the unit after it.
    await page.goto(`/#page=${p.id}&row=${box.id}`);
    const value = page.getByRole("button", { name: /^Gewicht: 10\s?kg, ändern$/ });
    await expect(value).toBeVisible();
    await value.click();
    const input = page.getByRole("spinbutton", { name: "Gewicht (kg)" });
    await expect(input).toHaveValue("10");
    await expect(page.locator(".number-unit-input .number-unit")).toHaveText("kg");
    await page.screenshot({ path: `test-results/number-unit-verification/${testInfo.project.name}-record.png` });
    expect(errors).toEqual([]);
  } finally {
    await command({ action: "page.delete", pageId: p.id });
  }
});
