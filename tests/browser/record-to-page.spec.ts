import { test, expect } from "@playwright/test";

// The reverse of "Move into database": a record becomes a page (#29).
test("a record turns into a page from its menu", async ({ page }, testInfo) => {
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
  const tag = `${testInfo.project.name}${Date.now()}`;
  const db = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Notizen ${tag}`, kind: "database" });
  const row = await command({ action: "row.create", pageId: db.id, cells: { title: `Idee ${tag}` } });
  await page.goto(`/#page=${db.id}&row=${row.id}`);
  const entry = page.getByRole("dialog", { name: "Eintrag", exact: true });
  await expect(entry).toBeVisible({ timeout: 30_000 });
  await entry.getByRole("button", { name: "Weitere Aktionen" }).click();
  await page.getByRole("menuitem", { name: "In Seite umwandeln …" }).click();
  const dialog = page.getByRole("dialog", { name: "In Seite umwandeln" });
  await expect(dialog.getByText("Die Seite folgt den Rechten ihres Orts.", { exact: false })).toBeVisible();
  await page.screenshot({ path: `test-results/record-to-page/${testInfo.project.name}-dialog.png` });
  await dialog.getByRole("button", { name: "Umwandeln", exact: true }).click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  const after = await (await page.request.get("/api/bootstrap")).json();
  const created = after.pages.find((p: { title: string; kind: string }) => p.title === `Idee ${tag}` && p.kind !== "database");
  expect(created, "the new page exists").toBeTruthy();
  await expect(page).toHaveURL(new RegExp(`page=${created.id}`), { timeout: 30_000 });
  expect(errors).toEqual([]);
});
