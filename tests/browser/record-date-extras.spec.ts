import { test, expect, type Page } from "@playwright/test";

// The recurrence and the repeating task below a record's first date (#521):
// a documents database (empty properties hidden, no done rule) shows
// neither until the empty properties are shown, and never the repeating
// task; a task database (a status with a done option) offers it.
async function database(page: Page, title: string, fields: Record<string, unknown>[], hideEmpty: boolean) {
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.onboarded" } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const db = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `${title} ${Date.now()}`, kind: "database" });
  const read = async () => (await page.request.get(`/api/pages/${db.id}`)).json();
  await command({
    action: "database.update",
    pageId: db.id,
    version: (await read()).database.version,
    fields,
    views: [{ id: "table", name: "Tabelle", type: "table", filters: [], sorts: [] }],
  });
  await command({ action: "database.recordLayout", pageId: db.id, layout: { ...(await read()).database.recordLayout, hideEmpty } });
  return { db, command };
}

test("documents: no recurrence or repeating task until the empty properties are shown", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { db, command } = await database(
    page,
    `Dokumente ${info.project.name}`,
    [
      { id: "title", name: "Titel", type: "text" },
      { id: "date", name: "Datum", type: "date" },
      { id: "tags", name: "Tags", type: "multiselect", options: ["Vertrag"] },
    ],
    true,
  );
  const row = await command({ action: "row.create", pageId: db.id, cells: { title: "Mietvertrag", date: "2026-05-01" } });
  await page.goto(`/#page=${db.id}&row=${row.id}`);
  const entry = page.getByRole("dialog", { name: "Eintrag", exact: true });
  const properties = entry.locator(".row-properties");
  await expect(properties).toContainText("Datum", { timeout: 30_000 });
  await expect(properties.locator(".recurrence-property")).toHaveCount(0);
  await expect(properties.locator(".record-repeat")).toHaveCount(0);
  // The empty tags and the recurrence: two empty ones.
  await properties.getByRole("button", { name: "2 leere Eigenschaften anzeigen" }).click();
  await expect(properties.getByRole("button", { name: "Wiederholung: Keine, ändern" })).toBeVisible();
  await expect(properties.locator(".record-repeat")).toHaveCount(0);
  await properties.getByRole("button", { name: "Leere Eigenschaften ausblenden" }).click();
  await expect(properties.locator(".recurrence-property")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("tasks: the repeating task is offered where a status can be done", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { db, command } = await database(
    page,
    `Aufgaben ${info.project.name}`,
    [
      { id: "title", name: "Aufgabe", type: "text" },
      { id: "status", name: "Status", type: "select", options: ["Offen", "Erledigt"] },
      { id: "due", name: "Fällig", type: "date" },
    ],
    false,
  );
  const row = await command({ action: "row.create", pageId: db.id, cells: { title: "Abrechnung", status: "Offen", due: "2026-05-01" } });
  await page.goto(`/#page=${db.id}&row=${row.id}`);
  const entry = page.getByRole("dialog", { name: "Eintrag", exact: true });
  const properties = entry.locator(".row-properties");
  await expect(properties).toContainText("Fällig", { timeout: 30_000 });
  await expect(properties.getByRole("button", { name: "Wiederholung: Keine, ändern" })).toBeVisible();
  const repeat = properties.getByRole("button", { name: "Wiederkehrende Aufgabe: Nein, ändern" });
  await expect(repeat).toBeVisible();
  // Its controls in the editor, opened on the value.
  await repeat.click();
  await page.getByLabel("Wiederkehrende Aufgabe", { exact: true }).selectOption("weekly");
  await page.keyboard.press("Escape");
  await expect(properties.getByRole("button", { name: "Wiederkehrende Aufgabe: Wöchentlich, ändern" })).toBeVisible();
  expect(errors).toEqual([]);
});
