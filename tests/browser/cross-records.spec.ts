import { test, expect } from "@playwright/test";

// My tasks → records from databases, saved as a view.
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
  const db = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Projekt ${info.project.name}`, kind: "database" });
  const first = await (await page.request.get(`/api/pages/${db.id}`)).json();
  await command({
    action: "database.update",
    pageId: db.id,
    version: first.database.version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "status", name: "Status", type: "select", options: ["Offen", "Erledigt"] },
      { id: "who", name: "Zuständig", type: "person" },
    ],
    views: first.database.views,
  });
  const title = `Meins ${Date.now()}`;
  await command({ action: "row.create", pageId: db.id, cells: { title, status: "Offen", who: boot.user.id } });
  await page.goto("/#tasks");
  await page.getByRole("tab", { name: "Einträge aus Datenbanken" }).click();
  await expect(page.getByRole("button", { name: title })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Als Ansicht speichern" }).click();
  await page.getByLabel("Name der Ansicht").fill(`Tickets ${info.project.name} ${Date.now() % 100000}`);
  await page.getByRole("button", { name: "Speichern" }).click();
  await expect(page.getByRole("tab", { name: /^Tickets / , selected: true })).toBeVisible();
  await page.getByRole("button", { name: title }).click();
  await expect(page).toHaveURL(/row=/);
  expect(errors).toEqual([]);
});
