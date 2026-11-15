import { test, expect } from "@playwright/test";

// #313: an ID property without a prefix numbers records 1, 2, 3 …; a prefix
// set later shows the same numbers as WEB-1 ….
test("ticket numbers without a prefix, then with one", async ({ page }, info) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  await command({ action: "profile.onboarded" });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const db = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Website ${info.project.name}`, kind: "database" });
  const read = async () => (await page.request.get(`/api/pages/${db.id}`)).json();
  const rowIds: string[] = [];
  for (const title of ["Eins", "Zwei", "Drei"]) rowIds.push((await command({ action: "row.create", pageId: db.id, cells: { title } })).id);
  await page.goto(`/#page=${db.id}`);
  await expect(page.locator(`tr[data-row-id="${rowIds[0]}"]`)).toBeVisible({ timeout: 30_000 });

  await page.getByRole("button", { name: "Eigenschaft hinzufügen", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "Eigenschaft hinzufügen", exact: true });
  await dialog.getByLabel("Eigenschaftsname").fill("Nr.");
  await dialog.getByLabel("Eigenschaftstyp").selectOption("id");
  const prefix = dialog.getByLabel("Präfix (optional)");
  // The suggestion from the database name stays; it can be cleared.
  await expect(prefix).toHaveValue(/^[A-Z]/);
  await prefix.fill("");
  await expect(dialog.getByText("Ohne Präfix zählt die ID einfach hoch", { exact: false })).toBeVisible();
  await dialog.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(dialog).toBeHidden();
  const field = (await read()).database.fields.find((f: any) => f.type === "id");
  expect(field.prefix).toBeUndefined();
  const cell = (rowId: string, text: string) => page.locator(`tr[data-row-id="${rowId}"]`).getByRole("gridcell", { name: text, exact: true });
  await expect(cell(rowIds[0], "1")).toBeVisible();
  await expect(cell(rowIds[1], "2")).toBeVisible();
  await expect(cell(rowIds[2], "3")).toBeVisible();

  // A prefix set later: the same numbers with it.
  const unique = `W${Date.now().toString(36).toUpperCase().slice(-5)}`.replace(/[^A-Z0-9]/g, "");
  await page.locator(`th[data-field-id="${field.id}"] > button`).first().click();
  const edit = page.getByRole("dialog", { name: "Eigenschaft bearbeiten", exact: true });
  await edit.getByLabel("Präfix (optional)").fill(unique);
  await expect(edit.getByText(`${unique}-123`, { exact: false })).toBeVisible();
  await edit.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(edit).toBeHidden();
  await expect(cell(rowIds[0], `${unique}-1`)).toBeVisible();
  await expect(cell(rowIds[2], `${unique}-3`)).toBeVisible();
  expect(errors).toEqual([]);
});
