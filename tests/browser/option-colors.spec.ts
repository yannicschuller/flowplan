import { test, expect, type Page } from "@playwright/test";

// Colours of select options (#242): set in the property settings, shown in
// the table and on the board; a new option gets one by itself; "Assign
// colours automatically" colours every option (and can be undone); the
// chip's menu changes one colour.
async function database(page: Page, name: string) {
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  // No welcome dialog in front of the database.
  await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.onboarded" } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const response = await page.request.post("/api/command", {
    headers: { origin },
    data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: name, kind: "database", starterTemplate: "project" },
  });
  return (await response.json()).id as string;
}
const statusOf = async (page: Page, pageId: string) =>
  (await (await page.request.get(`/api/pages/${pageId}`)).json()).database.fields.find((f: { id: string }) => f.id === "status") as {
    options: string[];
    optionColors?: Record<string, string>;
  };

test("option colours: settings, table, board, new options, automatic colours, chip menu", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const pageId = await database(page, `Farben ${info.project.name} ${Date.now()}`);
  await page.goto(`/#page=${pageId}`);
  const status = await statusOf(page, pageId);
  // Template databases keep their earlier look: no colours stored.
  expect(status.optionColors).toBeUndefined();
  const [first] = status.options;

  // Settings: the first option purple.
  await page.locator(".data-table th").getByRole("button", { name: "Status" }).click();
  const dialog = page.getByRole("dialog", { name: "Eigenschaft bearbeiten" });
  await dialog.getByRole("button", { name: `Farbe von ${first}: Standard` }).click();
  await page.getByRole("menuitemradio", { name: "Lila" }).click();
  await expect(dialog.getByRole("button", { name: `Farbe von ${first}: Lila` })).toBeVisible();
  await dialog.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(async () => (await statusOf(page, pageId)).optionColors).toEqual({ [first]: "purple" });
  // The table shows it …
  await expect(page.locator(".data-table .tag.opt-purple", { hasText: first }).first()).toBeVisible();
  // … and the board's column.
  await page.locator(".database-tabs").getByText("Board", { exact: true }).click();
  await expect(page.getByRole("region", { name: `Gruppe ${first}` }).locator("header .tag")).toHaveClass(/opt-purple/);

  // A new column is a new option: it gets a colour by itself.
  await page.locator("button.board-add-group").click();
  await page.getByLabel("Name der neuen Gruppe").fill("Warten auf Kunde");
  await page.getByLabel("Name der neuen Gruppe").press("Enter");
  await expect(page.getByRole("region", { name: "Gruppe Warten auf Kunde" }).locator("header .tag")).toHaveClass(/tag-colored opt-/);
  const grown = await statusOf(page, pageId);
  expect(Object.keys(grown.optionColors || {}).sort()).toEqual([first, "Warten auf Kunde"].sort());

  // Every option at once; "Undo" brings the draft back, saving stores it.
  await page.locator(".database-tabs").getByText(/^(Alle|Tabelle|Alle Aufgaben)/).first().click();
  await page.locator(".data-table th").getByRole("button", { name: "Status" }).click();
  await dialog.getByRole("button", { name: "Farben automatisch vergeben" }).click();
  await expect(dialog.getByRole("button", { name: `Farbe von ${first}: Blau` })).toBeVisible();
  await dialog.getByRole("button", { name: "Rückgängig" }).click();
  await expect(dialog.getByRole("button", { name: `Farbe von ${first}: Lila` })).toBeVisible();
  await dialog.getByRole("button", { name: "Farben automatisch vergeben" }).click();
  await dialog.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(dialog).toBeHidden();
  const palette = ["blue", "green", "red", "yellow", "orange", "purple", "pink", "teal"];
  await expect
    .poll(async () => (await statusOf(page, pageId)).optionColors)
    .toEqual(Object.fromEntries(grown.options.map((o, i) => [o, palette[i % palette.length]])));

  // The chip's own menu (right-click, desktop): one colour, at once.
  if (info.project.name === "desktop") {
    await page.locator(`.data-table .tag[data-option="${first}"]`).first().click({ button: "right" });
    await page.getByRole("menu", { name: `Option ${first}` }).getByRole("menuitemradio", { name: "Türkis" }).click();
    await expect(page.locator(`.data-table .tag[data-option="${first}"]`).first()).toHaveClass(/opt-teal/);
    expect((await statusOf(page, pageId)).optionColors?.[first]).toBe("teal");
  }
  expect(errors).toEqual([]);
});
