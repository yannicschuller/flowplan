import { test, expect } from "@playwright/test";

test("a new status becomes its own board column; a due date can be removed", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const response = await page.request.post("/api/command", {
    headers: { origin },
    data: {
      action: "page.create",
      workspaceId: boot.workspace.id,
      spaceId: boot.spaces[0].id,
      title: `Board ${info.project.name} ${Date.now()}`,
      kind: "database",
      starterTemplate: "project",
    },
  });
  const pageId = (await response.json()).id;
  await page.goto(`/#page=${pageId}`);
  await page.locator(".database-tabs").getByText("Board", { exact: true }).click();
  await expect(page.locator(".board-column").first()).toBeVisible();
  const before = await page.locator(".board-column").count();
  await page.locator("button.board-add-group").click();
  await page.getByLabel("Name der neuen Gruppe").fill("in arbeit");
  await page.getByRole("button", { name: "Hinzufügen", exact: true }).click();
  await expect(page.locator(".board-add-group [role=alert]")).toContainText("gibt es schon");
  await page.getByLabel("Name der neuen Gruppe").fill("Warten auf Kunde");
  await page.getByLabel("Name der neuen Gruppe").press("Enter");
  const column = page.getByRole("region", { name: "Gruppe Warten auf Kunde" });
  await expect(column).toBeVisible();
  await expect(page.locator(".board-column")).toHaveCount(before + 1);
  // A card created there gets the new status.
  await column.getByRole("button", { name: "Neue Aufgabe" }).click();
  const record = page.getByRole("dialog", { name: "Eintrag" });
  await expect(record.getByLabel("Status", { exact: true })).toContainText("Warten auf Kunde");
  await record.getByRole("button", { name: "Schließen" }).first().click();
  await expect(column.locator(".record-card").first()).toBeVisible();

  // Removing a date in a record.
  await page.locator(".database-tabs").getByText("Alle Aufgaben", { exact: true }).click();
  await page.getByText("Meilensteine planen").first().click();
  const remove = page.getByRole("button", { name: "Fällig am entfernen" }).first();
  await expect(remove).toBeVisible();
  await remove.click();
  await expect(page.getByLabel("Fällig am", { exact: true }).first()).toHaveValue("");
  await expect
    .poll(async () => {
      const data = await (await page.request.get(`/api/pages/${pageId}`)).json();
      return data.rows.find((r: { cells: Record<string, unknown> }) => r.cells.title === "Meilensteine planen").cells.date ?? "";
    })
    .toBe("");
  expect(errors).toEqual([]);
});
