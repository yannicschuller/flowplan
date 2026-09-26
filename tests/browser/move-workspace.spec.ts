import { test, expect } from "@playwright/test";

test("a page moves into another workspace from the page menu", async ({ page }, info) => {
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const tag = `${info.project.name} ${Date.now()}`;
  const target = await command({ action: "workspace.create", name: `Ziel ${tag}` });
  const moving = await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    title: `Umzug ${tag}`,
    kind: "document",
  });
  await page.goto(`/#page=${moving.id}`);
  await page.getByRole("button", { name: "Seitenaktionen" }).click();
  await page.getByRole("menuitem", { name: "Verschieben" }).click();
  const dialog = page.getByRole("dialog", { name: "Seite verschieben" });
  await dialog.getByLabel("Arbeitsbereich").selectOption({ label: `Ziel ${tag}` });
  await expect(dialog).toContainText("wechseln den Arbeitsbereich");
  await dialog.getByRole("button", { name: "Verschieben", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  // The app follows the page into the target workspace.
  await expect(page.locator(".page-title")).toHaveValue(`Umzug ${tag}`);
  const moved = await (await page.request.get(`/api/pages/${moving.id}`)).json();
  expect(moved.page.workspace_id).toBe(target.id);
  const old = await (await page.request.get(`/api/bootstrap?workspace=${boot.workspace.id}`)).json();
  expect(old.pages.some((p: { id: string }) => p.id === moving.id)).toBe(false);
});
