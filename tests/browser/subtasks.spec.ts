import { test, expect } from "@playwright/test";

// Subtasks: added from the record, shown as a tree with rolled-up progress.
test("subtasks in the record, as a tree and with progress", async ({ page }, info) => {
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
  const db = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Plan ${info.project.name}`, kind: "database" });
  const read = async () => (await page.request.get(`/api/pages/${db.id}`)).json();
  const first = await read();
  const table = first.database.views[0];
  await command({
    action: "database.update",
    pageId: db.id,
    version: first.database.version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "status", name: "Status", type: "select", options: ["Offen", "Erledigt"] },
      { id: "parent", name: "Gehört zu", type: "relation", parent: true },
      { id: "progress", name: "Fortschritt", type: "progress" },
    ],
    views: [{ ...table, tree: true }, ...first.database.views.slice(1)],
  });
  const epic = await command({ action: "row.create", pageId: db.id, cells: { title: "Relaunch", status: "Offen" } });
  await command({ action: "row.create", pageId: db.id, cells: { title: "Texte", status: "Erledigt", parent: [epic.id] } });

  await page.goto(`/#page=${db.id}&row=${epic.id}`);
  const subtasks = page.getByRole("region", { name: "Unteraufgaben" });
  await expect(subtasks.getByText("1/1 erledigt")).toBeVisible({ timeout: 30_000 });
  await subtasks.getByLabel("Neue Unteraufgabe").fill("Bilder");
  await subtasks.getByRole("button", { name: "Hinzufügen" }).click();
  await expect(subtasks.getByText("1/2 erledigt")).toBeVisible();
  await page.keyboard.press("Escape");

  await page.goto(`/#page=${db.id}`);
  const rowOf = (name: string) => page.locator("tr", { has: page.getByText(name, { exact: true }) });
  await expect(rowOf("Relaunch").locator(".progress-cell")).toContainText("50 %", { timeout: 30_000 });
  await rowOf("Relaunch").getByRole("button", { name: "Unteraufgaben ausblenden" }).click();
  await expect(page.getByText("Bilder", { exact: true })).toBeHidden();
  await rowOf("Relaunch").getByRole("button", { name: "2 Unteraufgaben zeigen" }).click();
  await expect(page.getByText("Bilder", { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
