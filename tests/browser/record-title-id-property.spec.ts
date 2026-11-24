import { test, expect, type Page } from "@playwright/test";

// #463: in an empty database with an ID property (prefix ABC) and a checkbox,
// a new record's title typed in the record dialog went back to "Neuer
// Eintrag" once the focus left it, with "Eigenschaft kann nicht bearbeitet
// werden.". That happens when the ID is the title itself – the type of the
// database's only property, "Name", changed to ID: the title became a
// computed property nobody can type. The title's editor no longer offers the
// computed types; an ID added beside the title leaves the title as typed.
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";

async function setup(page: Page, name: string) {
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
  await page.goto(`/#page=${db.id}`);
  await expect(page.getByRole("button", { name: "Neue Zeile" })).toBeVisible({ timeout: 30_000 });
  return { db, read, errors };
}

async function addProperty(page: Page, name: string, type: string, prefix?: string) {
  await page.getByRole("button", { name: "Eigenschaft hinzufügen", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "Eigenschaft hinzufügen", exact: true });
  await dialog.getByLabel("Eigenschaftsname").fill(name);
  await dialog.getByLabel("Eigenschaftstyp").selectOption(type);
  if (prefix !== undefined) await dialog.getByLabel("Präfix (optional)").fill(prefix);
  await dialog.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("th", { hasText: name })).toBeVisible();
}

for (const [label, title, withCheck] of [
  ["numeric title", "12345", true],
  ["text title", "Mein Eintrag", true],
  ["numeric title without a checkbox", "67890", false],
] as const) {
  test(`#463: a new record keeps its ${label} beside an ID property`, async ({ page }) => {
    test.setTimeout(120_000);
    const { read, errors } = await setup(page, "Titel 463");
    // A prefix is unique in the workspace: ABC and a few letters of its own.
    const prefix = `ABC${Date.now().toString(36).toUpperCase().slice(-4)}${Math.random().toString(36).toUpperCase().slice(2, 4)}`.replace(/[^A-Z0-9]/g, "");
    await addProperty(page, "Nr.", "id", prefix);
    if (withCheck) await addProperty(page, "Erledigt", "checkbox");

    await page.getByRole("button", { name: "Neue Zeile" }).click();
    const record = page.getByRole("dialog").filter({ has: page.getByLabel("Titel des Eintrags") });
    const titleInput = record.getByLabel("Titel des Eintrags");
    await expect(titleInput).toHaveValue("Neuer Eintrag");
    await expect(titleInput).toBeFocused();
    await titleInput.fill(title);
    // The focus moves on to another control of the record dialog.
    await titleInput.press("Tab");
    await expect(titleInput).not.toBeFocused();

    await expect(page.getByText("Eigenschaft kann nicht bearbeitet werden.")).toHaveCount(0);
    await expect(titleInput).toHaveValue(title);
    await expect
      .poll(async () => {
        const data = await read();
        const titleId = data.database.fields[0].id;
        return data.rows.map((r: { cells: Record<string, unknown> }) => r.cells[titleId]);
      })
      .toEqual([title]);
    const data = await read();
    // The title is the first property, the ID one of its own.
    expect(data.database.fields[0].type).toBe("text");
    expect(data.database.fields.find((f: { type: string }) => f.type === "id")?.prefix).toBe(prefix);

    // A reload keeps it.
    await page.reload();
    await expect(page.locator("tbody tr").first()).toContainText(title, { timeout: 30_000 });
    await expect(page.locator("tbody tr").first()).toContainText(`${prefix}-1`);
    await expect(page.getByText("Eigenschaft kann nicht bearbeitet werden.")).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

test("#463: the title property cannot become an ID", async ({ page }) => {
  test.setTimeout(120_000);
  const { read, errors } = await setup(page, "Titel 463 ID");
  const titleId = (await read()).database.fields[0].id;
  await page.locator(`th[data-field-id="${titleId}"] > button`).first().click();
  const edit = page.getByRole("dialog", { name: "Eigenschaft bearbeiten", exact: true });
  const type = edit.getByLabel("Eigenschaftstyp");
  for (const computed of ["id", "formula", "created_at"])
    await expect(type.locator(`option[value="${computed}"]`)).toHaveJSProperty("disabled", true);
  await expect(type.locator('option[value="text"]')).toHaveJSProperty("disabled", false);
  await expect(type.locator('option[value="checkbox"]')).toHaveJSProperty("disabled", false);
  await page.keyboard.press("Escape");
  await expect(edit).toBeHidden();
  // A new property may be an ID.
  await page.getByRole("button", { name: "Eigenschaft hinzufügen", exact: true }).first().click();
  const add = page.getByRole("dialog", { name: "Eigenschaft hinzufügen", exact: true });
  await expect(add.getByLabel("Eigenschaftstyp").locator('option[value="id"]')).toHaveJSProperty("disabled", false);
  expect((await read()).database.fields[0].type).toBe("text");
  expect(errors).toEqual([]);
});
