import { test, expect, type Page } from "@playwright/test";

// #529: a database whose title property is a date (or a number). Typing
// "23.11.2026" into the record's title sent that text and the server
// answered "Ungültiges Datum."; a new record was called "Neuer Eintrag",
// which is no date either. The title now reads what is typed into the
// property's value, shows it as the table does, and explains in place what
// it cannot read – without saving it.
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";

async function setup(page: Page, name: string, title: Record<string, unknown>) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  await command({ action: "profile.onboarded" });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const db = (await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    title: `${name} ${Date.now()}`,
    kind: "database",
    databaseKind: "empty",
  })) as { id: string };
  const read = async () => (await page.request.get(`/api/pages/${db.id}`)).json();
  const data = await read();
  await command({
    action: "database.update",
    workspaceId: boot.workspace.id,
    pageId: db.id,
    version: data.database.version,
    fields: [{ ...data.database.fields[0], ...title }, ...data.database.fields.slice(1)],
    views: data.database.views,
  });
  const titleId = data.database.fields[0].id as string;
  const titles = async () => (await read()).rows.map((r: { cells: Record<string, unknown> }) => r.cells[titleId] ?? null);
  await page.goto(`/#page=${db.id}`);
  await expect(page.getByRole("button", { name: "Neue Zeile" })).toBeVisible({ timeout: 30_000 });
  return { titles, errors };
}

test("#529: a date title takes 23.11.2026 and explains what is no date", async ({ page }) => {
  test.setTimeout(120_000);
  const { titles, errors } = await setup(page, "Termine 529", { name: "Tag", type: "date", format: "eu" });
  await page.getByRole("button", { name: "Neue Zeile" }).click();
  const record = page.getByRole("dialog").filter({ has: page.getByLabel("Titel des Eintrags") });
  const titleInput = record.getByLabel("Titel des Eintrags");
  // No "Neuer Eintrag" in a date: the new record starts empty, focused.
  await expect(titleInput).toBeFocused();
  await expect(titleInput).toHaveValue("");
  await expect(titleInput).toHaveAttribute("placeholder", "Datum, z. B. 23.11.2026");
  await expect.poll(titles).toEqual([null]);

  await titleInput.fill("Quatsch");
  await titleInput.press("Tab");
  await expect(record.getByRole("alert")).toHaveText("Das ist kein Datum – z. B. 23.11.2026");
  await expect(titleInput).toHaveValue("Quatsch");
  await expect(titleInput).toHaveAttribute("aria-invalid", "true");
  // Nothing was sent: the record keeps no title, the server said nothing.
  await page.waitForTimeout(500);
  expect(await titles()).toEqual([null]);
  await expect(page.getByText("Ungültiges Datum.")).toHaveCount(0);

  await titleInput.fill("23.11.2026");
  await titleInput.press("Tab");
  await expect(record.getByRole("alert")).toHaveCount(0);
  await expect.poll(titles).toEqual(["2026-11-23"]);
  await expect(titleInput).toHaveValue("23.11.2026");
  await expect(page.getByText("Ungültiges Datum.")).toHaveCount(0);

  // Typed again in another writing, with the record still open.
  await titleInput.fill("2026-11-24");
  await titleInput.press("Enter");
  await expect.poll(titles).toEqual(["2026-11-24"]);

  await page.keyboard.press("Escape");
  await expect(record).toBeHidden();
  await expect(page.locator("tbody tr").first()).toContainText("24.11.2026");
  await page.reload();
  await expect(page.locator("tbody tr").first()).toContainText("24.11.2026", { timeout: 30_000 });
  expect(errors).toEqual([]);
});

test("#529: a number title with a unit takes 1.234,5 kg", async ({ page }) => {
  test.setTimeout(120_000);
  const { titles, errors } = await setup(page, "Gewichte 529", { name: "Gewicht", type: "number", unit: "kg" });
  await page.getByRole("button", { name: "Neue Zeile" }).click();
  const record = page.getByRole("dialog").filter({ has: page.getByLabel("Titel des Eintrags") });
  const titleInput = record.getByLabel("Titel des Eintrags");
  await expect(titleInput).toBeFocused();

  await titleInput.fill("viel");
  await titleInput.press("Tab");
  await expect(record.getByRole("alert")).toHaveText("Das ist keine Zahl – z. B. 12 kg");
  await expect(titleInput).toHaveValue("viel");
  await page.waitForTimeout(500);
  expect(await titles()).toEqual([null]);

  await titleInput.fill("1.234,5 kg");
  await titleInput.press("Tab");
  await expect(record.getByRole("alert")).toHaveCount(0);
  await expect.poll(titles).toEqual([1234.5]);
  // Shown as the table shows it, with the unit.
  await expect(titleInput).toHaveValue("1.234,5 kg");
  // Typed as a plain number on focus.
  await titleInput.focus();
  await expect(titleInput).toHaveValue("1234,5");
  await titleInput.press("Tab");

  await page.keyboard.press("Escape");
  await expect(record).toBeHidden();
  await expect(page.locator("tbody tr").first()).toContainText("1.234,5 kg");
  expect(errors).toEqual([]);
});
