import { test, expect } from "@playwright/test";

// The view name and column widths in "Configure view" are saved on Enter
// and when the panel closes while the field still has focus (like #131).
test("view name and column width save on Enter and when the panel closes", async ({ page }, info) => {
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
  // Past the introduction a new demo account sees first.
  await command({ action: "profile.onboarded" });
  const db = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `View name ${info.project.name}`, kind: "database" });
  const first = await (await page.request.get(`/api/pages/${db.id}`)).json();
  await command({
    action: "database.update",
    pageId: db.id,
    version: first.database.version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "notes", name: "Notizen", type: "text" },
    ],
    views: [{ id: "table", name: "Tabelle", type: "table", filters: [], sorts: [] }],
  });
  const stored = async () => (await (await page.request.get(`/api/pages/${db.id}`)).json()).database.views[0];
  await page.goto(`/#page=${db.id}`);
  const settings = page.getByRole("dialog", { name: "Ansicht konfigurieren", exact: true });
  const open = async () => {
    await page.getByTitle("Ansicht und Eigenschaften", { exact: true }).click();
    await expect(settings).toBeVisible();
  };
  // Enter saves the name.
  await open();
  const name = settings.getByRole("textbox", { name: "Name", exact: true });
  await name.fill("Offene Punkte");
  await name.press("Enter");
  await expect.poll(async () => (await stored()).name, { timeout: 15_000 }).toBe("Offene Punkte");
  // Closing the panel with Escape while the name has focus keeps it.
  await name.fill("Alle Punkte");
  await expect(name).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();
  await expect.poll(async () => (await stored()).name, { timeout: 15_000 }).toBe("Alle Punkte");
  // The same for a column width.
  await open();
  await expect(settings.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("Alle Punkte");
  const width = settings.getByLabel("Notizen Breite in Pixeln", { exact: true });
  await width.fill("321");
  await expect(width).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();
  await expect.poll(async () => (await stored()).columnWidths?.notes, { timeout: 15_000 }).toBe(321);
  expect(errors).toEqual([]);
});
