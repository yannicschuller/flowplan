import { test, expect } from "@playwright/test";

// My tasks: records from databases among the tasks (#314), ticked off
// there, saved as a view; a database without a status holds no tasks.
test("records across databases in My tasks", async ({ page }, info) => {
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
  const database = async (title: string, fields: Record<string, unknown>[]) => {
    const db = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title, kind: "database" });
    const first = await (await page.request.get(`/api/pages/${db.id}`)).json();
    await command({ action: "database.update", pageId: db.id, version: first.database.version, fields, views: first.database.views });
    return db.id as string;
  };
  const stamp = `${info.project.name} ${Date.now()}`;
  const db = await database(`Projekt ${stamp}`, [
    { id: "title", name: "Name", type: "text" },
    { id: "status", name: "Status", type: "select", options: ["Offen", "Erledigt"] },
    { id: "who", name: "Zuständig", type: "person" },
  ]);
  // A reading list: a person, but nothing to tick off.
  const notes = await database(`Leseliste ${stamp}`, [
    { id: "title", name: "Name", type: "text" },
    { id: "who", name: "Zuständig", type: "person" },
  ]);
  const title = `Meins ${Date.now()}`;
  const reading = `Lesen ${Date.now()}`;
  await command({ action: "row.create", pageId: db, cells: { title, status: "Offen", who: boot.user.id } });
  await command({ action: "row.create", pageId: notes, cells: { title: reading, who: boot.user.id } });
  await page.goto("/#tasks");
  // In the one list, with its database and status.
  const row = page.locator(".my-tasks-group li.my-record", { hasText: title });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row).toContainText(`Projekt ${stamp}`);
  await expect(row.locator(".my-record-status")).toHaveText("Offen");
  await expect(page.getByText(reading)).toHaveCount(0);
  // "Dokumente" hides it, "Datenbanken" shows it again.
  await page.locator(".my-tasks-source label", { hasText: "Dokumente" }).click();
  await expect(row).toHaveCount(0);
  await page.locator(".my-tasks-source label", { hasText: "Datenbanken" }).click();
  await expect(row).toBeVisible();
  // The tools for records say what they apply to.
  const tools = page.getByRole("group", { name: "Nur für Einträge aus Datenbanken" });
  await expect(tools).toBeVisible();
  await expect(tools.getByRole("combobox", { name: "Datenbank" }).locator("option", { hasText: `Leseliste ${stamp}` })).toHaveCount(0);
  await tools.getByRole("button", { name: "Als Ansicht speichern" }).click();
  await tools.getByLabel("Name der Ansicht").fill(`Tickets ${info.project.name} ${Date.now() % 100000}`);
  await tools.getByRole("button", { name: "Speichern" }).click();
  await expect(page.getByRole("button", { name: /^Tickets /, pressed: true })).toBeVisible();
  // Ticked off here, the record's status becomes "Erledigt".
  await row.getByRole("checkbox").click();
  await expect(page.locator(".my-tasks-group li.my-record", { hasText: title })).toHaveCount(0);
  await expect
    .poll(async () => (await (await page.request.get(`/api/pages/${db}`)).json()).rows.find((r: { cells: { title: string } }) => r.cells.title === title)?.cells.status)
    .toBe("Erledigt");
  await page.getByLabel("Erledigte zeigen").check();
  const doneRow = page.locator(".my-tasks-group li.my-record.checked", { hasText: title });
  await expect(doneRow).toBeVisible();
  await doneRow.getByRole("button", { name: new RegExp(title) }).click();
  await expect(page).toHaveURL(/row=/);
  expect(errors).toEqual([]);
});
