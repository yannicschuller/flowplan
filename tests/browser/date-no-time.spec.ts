import { test, expect, type Page } from "@playwright/test";

// A date property with "Mit Uhrzeit" switched off (#327): table cells and
// forms offer no "+ Uhrzeit", a record that already has a time keeps it
// and can lose it, and the setting counts the records with a time.
test.use({ timezoneId: "UTC" });

async function databaseSearch(page: Page) {
  const field = page.getByLabel("Datenbank durchsuchen", { exact: true });
  if (!(await field.isVisible()))
    await page.locator("button.toolbar-chip", { hasText: "Suchen" }).first().click();
  return field;
}

test("date property without time: cells and forms offer no time, existing times can be removed", async ({ page, browser }, info) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const post = async (data: Record<string, unknown>) =>
    await page.request.post("/api/command", { headers: { origin }, data });
  const command = async (data: Record<string, unknown>) => {
    const response = await post(data);
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const db = await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    title: `Ohne Uhrzeit ${info.project.name} ${Date.now()}`,
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
    ],
    views: [{ id: "table", name: "Tabelle", type: "table", filters: [], sorts: [] }],
  });
  const timed = await command({ action: "row.create", pageId: db.id, cells: { title: "Mit Zeit", due: "2026-09-04T14:05:00Z" } });
  const allDay = await command({ action: "row.create", pageId: db.id, cells: { title: "Ganztags", due: "2026-09-05" } });
  const cells = async (id: string) => (await read()).rows.find((r: { id: string }) => r.id === id).cells;

  await page.goto(`/#page=${db.id}`);
  const skip = page.getByRole("dialog").getByRole("button", { name: "Überspringen" });
  if (await skip.waitFor({ timeout: 5000 }).then(() => true, () => false)) await skip.click();
  const table = page.locator(".data-table");
  await expect(table).toBeVisible();

  // The property settings: "Mit Uhrzeit" is on by default; off, they say
  // how many records still have a time.
  await table.locator("thead").getByRole("button", { name: /^\W*Fällig$/ }).click();
  const dialog = page.getByRole("dialog", { name: "Eigenschaft bearbeiten" });
  const withTime = dialog.getByRole("checkbox", { name: "Mit Uhrzeit", exact: true });
  await expect(withTime).toBeChecked();
  await withTime.uncheck();
  await expect(dialog.getByText("1 Eintrag hat noch eine Uhrzeit.")).toBeVisible();
  await withTime.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath(`setting-${info.project.name}.png`) });
  await dialog.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(async () => (await read()).database.fields[1].noTime).toBe(true);

  // An all-day record: the date field without "+ Uhrzeit" – in the
  // cell's popover (#607).
  const allDayRow = page.locator(`tr[data-row-id="${allDay.id}"]`);
  const editor = page.getByRole("dialog", { name: "Fällig", exact: true });
  await allDayRow.locator("td").nth(2).click();
  await expect(editor.getByLabel("Fällig", { exact: true })).toHaveAttribute("type", "date");
  await expect(editor.getByRole("button", { name: "Datum entfernen: Fällig", exact: true })).toBeVisible();
  await expect(editor.getByRole("button", { name: "Uhrzeit hinzufügen: Fällig", exact: true })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath(`cell-${info.project.name}.png`) });
  await (await databaseSearch(page)).click();

  // The record with a time: it is still shown and can be removed – then
  // there is no way back to a time.
  const timedRow = page.locator(`tr[data-row-id="${timed.id}"]`);
  await expect(timedRow.locator(".date-cell").first()).toContainText("14:05");
  await timedRow.locator("td").nth(2).click();
  await expect(editor.getByLabel("Fällig: Uhrzeit", { exact: true })).toHaveValue("14:05");
  await editor.getByRole("button", { name: "Uhrzeit entfernen: Fällig", exact: true }).click();
  await expect(editor.getByLabel("Fällig: Uhrzeit", { exact: true })).toHaveCount(0);
  await (await databaseSearch(page)).click();
  await expect.poll(async () => (await cells(timed.id)).due).toBe("2026-09-04");
  await expect(timedRow.locator(".date-cell").first()).not.toContainText("14:05");
  await timedRow.locator("td").nth(2).click();
  await expect(editor.getByLabel("Fällig", { exact: true })).toHaveAttribute("type", "date");
  await expect(editor.getByRole("button", { name: "Uhrzeit hinzufügen: Fällig", exact: true })).toHaveCount(0);
  await (await databaseSearch(page)).click();

  // The server refuses a new time with a readable message.
  const refused = await post({ action: "row.update", pageId: db.id, rowId: allDay.id, version: (await read()).rows.find((r: { id: string }) => r.id === allDay.id).version, cells: { due: "2026-09-05T09:00:00Z" } });
  expect(refused.status()).toBe(400);
  expect((await refused.json()).error).toBe("Diese Eigenschaft hat keine Uhrzeit. Bitte nur ein Datum angeben.");

  // A public form: the date question has only the date picker.
  await command({ action: "form.update", pageId: db.id, enabled: true, internal: false, anonymous: true, config: { requiredFields: ["title"] } });
  const token = (await read()).form.token;
  const context = await browser.newContext({
    timezoneId: "UTC",
    viewport: page.viewportSize()!,
    isMobile: info.project.name === "mobile",
    hasTouch: info.project.name === "mobile",
  });
  try {
    const guest = await context.newPage();
    await guest.goto(`${origin}/forms/${token}`);
    await guest.getByLabel("Name", { exact: true }).fill("Aus dem Formular");
    const date = guest.getByLabel("Fällig", { exact: true });
    await expect(date).toHaveAttribute("type", "date");
    await expect(guest.getByRole("button", { name: "Uhrzeit hinzufügen: Fällig", exact: true })).toHaveCount(0);
    await date.fill("2026-09-07");
    await guest.screenshot({ path: info.outputPath(`form-${info.project.name}.png`) });
    await guest.getByRole("button", { name: "Antwort senden", exact: true }).click();
    await expect(guest.getByRole("heading", { name: "Vielen Dank!", exact: true })).toBeVisible();
    await expect
      .poll(async () => (await read()).rows.find((r: { cells: { title: string } }) => r.cells.title === "Aus dem Formular")?.cells.due)
      .toBe("2026-09-07");
  } finally {
    await context.close();
  }
  expect(errors).toEqual([]);
});
