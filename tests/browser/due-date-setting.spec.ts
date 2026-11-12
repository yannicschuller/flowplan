import { test, expect } from "@playwright/test";

// The due date of a database is set next to the done rule (#248): automatic
// (by name), a chosen date property or none.
test("due date setting under status rules and done", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "one viewport is enough for a form");
  test.setTimeout(150_000);
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
  const db = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Bons ${info.project.name}`, kind: "database" });
  const read = async () => (await page.request.get(`/api/pages/${db.id}`)).json();
  const first = await read();
  await command({
    action: "database.update",
    pageId: db.id,
    version: first.database.version,
    fields: [
      { id: "title", name: "Nom", type: "text" },
      { id: "state", name: "Statut", type: "select", options: ["Actif", "Utilisé", "Expiré"] },
      { id: "buy", name: "Date d'achat", type: "date" },
      { id: "end", name: "Fin de validité", type: "date" },
    ],
    views: first.database.views,
  });
  await page.goto(`/#page=${db.id}`);
  // A fresh demo account sees the introduction first.
  const skip = page.getByRole("dialog").getByRole("button", { name: "Überspringen" });
  if (await skip.waitFor({ timeout: 8000 }).then(() => true, () => false)) await skip.click();
  const open = async () => {
    await page.getByRole("button", { name: "Weitere Werkzeuge" }).click();
    await page.getByRole("menuitem", { name: /Statusregeln und Erledigt/ }).click();
    return page.getByRole("dialog");
  };
  let dialog = await open();
  const due = dialog.getByRole("combobox", { name: "Eigenschaft für das Fälligkeitsdatum" });
  // Automatic guesses the end of validity, not the purchase date.
  await expect(due.locator("option:checked")).toHaveText("Automatisch (zurzeit „Fin de validité“)");
  // "Utilisé" counts as done without any setting.
  await expect(dialog.getByRole("checkbox", { name: "Utilisé" })).toBeChecked();
  await expect(dialog.getByRole("checkbox", { name: "Expiré" })).not.toBeChecked();
  if (process.env.SHOT_DIR) {
    await dialog.screenshot({ path: `${process.env.SHOT_DIR}/due-setting-light.png` });
    await page.emulateMedia({ colorScheme: "dark" });
    const theme = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    await dialog.screenshot({ path: `${process.env.SHOT_DIR}/due-setting-dark.png` });
    await page.evaluate((t) => (t ? document.documentElement.setAttribute("data-theme", t) : document.documentElement.removeAttribute("data-theme")), theme);
    await page.emulateMedia({ colorScheme: "light" });
  }
  await due.selectOption({ label: "Kein Fälligkeitsdatum" });
  await expect(dialog.getByText("Einträge erscheinen ohne Datum in „Meine Aufgaben“")).toBeVisible();
  await dialog.getByRole("button", { name: "Speichern" }).click();
  await expect(dialog).toBeHidden();
  expect((await read()).database.settings.due).toEqual({ none: true });

  dialog = await open();
  await expect(due.locator("option:checked")).toHaveText("Kein Fälligkeitsdatum");
  await due.selectOption({ label: "Date d'achat" });
  await dialog.getByRole("button", { name: "Speichern" }).click();
  await expect(dialog).toBeHidden();
  expect((await read()).database.settings.due).toEqual({ field: "buy" });

  dialog = await open();
  await due.selectOption({ index: 0 });
  await dialog.getByRole("button", { name: "Speichern" }).click();
  await expect(dialog).toBeHidden();
  expect((await read()).database.settings.due).toBeUndefined();
  expect(errors).toEqual([]);
});
