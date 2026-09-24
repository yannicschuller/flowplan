import { test, expect } from "@playwright/test";

test("number and date properties show chosen currency, date and time formats", async ({
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
    title: `Formate ${testInfo.project.name} ${Date.now()}`,
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
      { id: "amount", name: "Betrag", type: "number" },
      { id: "due", name: "Fällig", type: "date" },
    ],
    views: [
      {
        id: "table",
        name: "Tabelle",
        type: "table",
        filters: [],
        sorts: [],
        calculations: { amount: "sum" },
      },
    ],
  });
  await command({
    action: "row.create",
    pageId: p.id,
    cells: { title: "Miete", amount: 1234.5, due: "2026-09-04T14:05:00Z" },
  });
  await page.goto(`/#page=${p.id}`);
  const table = page.locator(".data-table");
  await expect(table).toBeVisible();
  const edit = async (name: string) => {
    await table
      .locator("thead")
      .getByRole("button", { name: new RegExp(`^\\W*${name}$`) })
      .click();
    return page.getByRole("dialog", { name: "Eigenschaft bearbeiten" });
  };
  let dialog = await edit("Betrag");
  await dialog.getByLabel("Zahlenformat").selectOption("eur");
  await dialog.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect
    .poll(async () => (await read()).database.fields[1].format)
    .toBe("eur");
  const nbsp = (s: string | null) => (s || "").replace(/ /g, " ");
  await expect
    .poll(async () =>
      nbsp(await table.locator("tbody td").nth(2).textContent()),
    )
    .toContain("1.234,50 €");
  await expect
    .poll(async () => nbsp(await table.locator("tfoot").textContent()))
    .toContain("Σ 1.234,50 €");

  dialog = await edit("Fällig");
  await dialog.getByLabel("Datumsformat").selectOption("iso");
  await dialog.getByLabel("Zeitformat").selectOption("12");
  await dialog.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(table.locator(".date-cell")).toContainText(
    /2026-09-04, \d{1,2}:05 (AM|PM)/,
  );
  await page.screenshot({
    path: `test-results/field-formats-verification/${testInfo.project.name}-table.png`,
  });
  expect(errors).toEqual([]);
  await command({ action: "page.delete", pageId: p.id });
});
