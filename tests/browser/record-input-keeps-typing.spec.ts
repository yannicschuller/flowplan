import { test, expect, type Page } from "@playwright/test";

// What was typed stays: Escape in a record's title or a property closes the
// dialog and keeps the text, and Enter in a number cell saves it.
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";

async function setup(page: Page, name: string) {
  // The introduction of a first account closes when it shows.
  await page.addLocatorHandler(page.getByRole("dialog", { name: "Willkommen bei Flowplan" }), (intro) =>
    intro.getByRole("button", { name: "Überspringen" }).click(),
  );
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const db = (await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    title: `${name} ${Date.now()}`,
    kind: "database",
  })) as { id: string };
  const read = async () => (await page.request.get(`/api/pages/${db.id}`)).json();
  await command({
    action: "database.update",
    pageId: db.id,
    version: (await read()).database.version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "amount", name: "Menge", type: "number" },
      { id: "tags", name: "Etiketten", type: "multiselect", options: ["Rot", "Grün"] },
    ],
    views: [{ id: "table", name: "Tabelle", type: "table", filters: [], sorts: [] }],
  });
  const rows = async () => (await read()).rows as { id: string; cells: Record<string, unknown> }[];
  return { db, command, rows };
}

test("Escape on a record's title keeps what was typed", async ({ page }, info) => {
  const { db, rows } = await setup(page, `Titel ${info.project.name}`);
  await page.goto(`/#page=${db.id}`);
  await expect(page.locator(".database")).toBeVisible();

  // A new record: the title is focused, typed, and Escape closes.
  await page.getByRole("button", { name: "Neu", exact: true }).first().click();
  const entry = page.getByRole("dialog", { name: "Eintrag", exact: true });
  const title = entry.getByRole("textbox", { name: "Titel des Eintrags" });
  await expect(title).toBeFocused({ timeout: 15000 });
  await page.keyboard.type("Einkauf");
  await page.keyboard.press("Escape");
  await expect(entry).toBeHidden();
  await expect.poll(async () => (await rows()).map((r) => r.cells.title), { timeout: 10000 }).toEqual(["Einkauf"]);

  // An existing record: the title changed, then Escape.
  await page.getByRole("button", { name: "Eintrag öffnen: Einkauf" }).first().click();
  await expect(title).toHaveValue("Einkauf");
  await title.click();
  await title.press("End");
  await page.keyboard.type(" morgen");
  await page.keyboard.press("Escape");
  await expect(entry).toBeHidden();
  await expect.poll(async () => (await rows()).map((r) => r.cells.title), { timeout: 10000 }).toEqual(["Einkauf morgen"]);

  // A property typed into, then Escape.
  await page.getByRole("button", { name: "Eintrag öffnen: Einkauf morgen" }).first().click();
  await entry.getByRole("spinbutton", { name: "Menge" }).click();
  await page.keyboard.type("3");
  await page.keyboard.press("Escape");
  await expect(entry).toBeHidden();
  await expect.poll(async () => (await rows())[0].cells.amount, { timeout: 10000 }).toBe(3);
  await page.reload();
  await expect(page.getByRole("button", { name: "Eintrag öffnen: Einkauf morgen" }).first()).toBeVisible();
});

test("Enter saves a number cell of the table", async ({ page }, info) => {
  const { db, command, rows } = await setup(page, `Zahl ${info.project.name}`);
  await command({ action: "row.create", pageId: db.id, cells: { title: "Äpfel" } });
  await page.goto(`/#page=${db.id}`);
  const row = page.locator(".data-table tbody tr[data-row-id]").first();
  await expect(row).toBeVisible();

  await row.locator("td").nth(2).click();
  const amount = row.getByRole("spinbutton", { name: "Menge" });
  await amount.click();
  await page.keyboard.type("7");
  await page.keyboard.press("Enter");
  await expect(amount).toBeHidden();
  await expect.poll(async () => (await rows())[0].cells.amount, { timeout: 10000 }).toBe(7);
  await expect(row.locator("td").nth(2)).toHaveText("7");
});
