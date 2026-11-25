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

test("tasks: recurrence and repeating task only once set, added from the date's panel", async ({ page }, info) => {
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
  // No "Keine" / "Nein" rows while nothing is set.
  await expect(properties.locator(".recurrence-property")).toHaveCount(0);
  await expect(properties.locator(".record-repeat")).toHaveCount(0);
  // One date with a reminder row: plain "Erinnerung".
  await expect(properties.locator(".reminder-property .row-property-label")).toHaveText(["Erinnerung"]);
  // The date's own panel offers both.
  const date = properties.getByRole("button", { name: /^Fällig: .+, ändern$/ });
  await date.click();
  await expect(page.getByRole("button", { name: "Wiederholung", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Wiederkehrende Aufgabe", exact: true }).click();
  // The row appears with its controls open.
  await page.getByLabel("Wiederkehrende Aufgabe", { exact: true }).selectOption("weekly");
  await page.keyboard.press("Escape");
  const repeat = properties.getByRole("button", { name: "Wiederkehrende Aufgabe: Wöchentlich, ändern" });
  await expect(repeat).toBeVisible();
  await expect(repeat).toBeFocused();
  // Set: the date's panel offers only the recurrence now.
  await date.click();
  await expect(page.getByRole("button", { name: "Wiederholung", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Wiederkehrende Aufgabe", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(date).toBeFocused();
  expect(errors).toEqual([]);
});

test("reminders of several dates say which date they belong to", async ({ page }, info) => {
  const { db, command } = await database(
    page,
    `Termine ${info.project.name}`,
    [
      { id: "title", name: "Termin", type: "text" },
      { id: "due", name: "Fällig", type: "date" },
      { id: "start", name: "Start", type: "date" },
    ],
    false,
  );
  const row = await command({ action: "row.create", pageId: db.id, cells: { title: "Bericht", due: "2026-05-08", start: "2026-05-01" } });
  await page.goto(`/#page=${db.id}&row=${row.id}`);
  const properties = page.getByRole("dialog", { name: "Eintrag", exact: true }).locator(".row-properties");
  await expect(properties.locator(".reminder-property .row-property-label")).toHaveText(["Erinnerung (Fällig)", "Erinnerung (Start)"], { timeout: 30_000 });
});
