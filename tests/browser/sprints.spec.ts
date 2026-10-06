import { test, expect } from "@playwright/test";

// Set up sprints, plan a record from the backlog, start and complete.
test("sprint planning from the backlog to completion", async ({ page }, info) => {
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
  const db = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Scrum ${info.project.name}`, kind: "database" });
  const first = await (await page.request.get(`/api/pages/${db.id}`)).json();
  await command({
    action: "database.update",
    pageId: db.id,
    version: first.database.version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "status", name: "Status", type: "select", options: ["Offen", "Erledigt"] },
    ],
    views: [...first.database.views, { id: "plan", name: "Planung", type: "sprint", filters: [], sorts: [] }],
  });
  await command({ action: "row.create", pageId: db.id, cells: { title: "Login bauen", status: "Offen" } });
  await command({ action: "row.create", pageId: db.id, cells: { title: "Doku", status: "Erledigt" } });
  await page.goto(`/#page=${db.id}`);
  await page.getByRole("tab", { name: /Planung/ }).or(page.getByRole("button", { name: /Planung/ })).first().click();
  await page.getByRole("button", { name: "Sprints einrichten" }).click();
  const sprint = page.getByRole("region", { name: "Sprint 1" });
  await expect(sprint).toBeVisible({ timeout: 30_000 });
  const backlog = page.getByRole("region", { name: "Backlog" });
  for (const name of ["Login bauen", "Doku"]) {
    const item = backlog.locator("li", { hasText: name });
    await item.getByLabel("Verschieben nach").selectOption({ label: "Sprint 1" });
    await expect(sprint.locator("li", { hasText: name })).toBeVisible();
  }
  await expect(sprint.getByText("1/2 Einträge erledigt")).toBeVisible();
  await sprint.getByRole("button", { name: "Starten" }).click();
  await expect(sprint.getByText("läuft")).toBeVisible();
  await expect(sprint.getByRole("img", { name: /Burndown/ })).toBeVisible();
  await sprint.getByRole("button", { name: "Abschließen" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText(/1 Einträge in „Sprint 1“ sind noch nicht erledigt/)).toBeVisible();
  await dialog.getByRole("button", { name: "Sprint abschließen" }).click();
  await expect(backlog.locator("li", { hasText: "Login bauen" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Velocity" })).toBeVisible();
  expect(errors).toEqual([]);
});
