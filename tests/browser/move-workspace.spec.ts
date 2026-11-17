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
  await page.getByRole("menuitem", { name: "Verschieben", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Seite verschieben" });
  // Until the target workspace's spaces are there, "Verschieben" waits: it
  // used to send the page into its old space while the app followed it into
  // the new workspace (and back again), with the dialog left open.
  let release = () => {};
  const held = new Promise<void>((done) => (release = done));
  await page.route(`**/api/bootstrap?workspace=${target.id}`, async (route) => {
    await held;
    await route.fallback();
  });
  await dialog.getByLabel("Arbeitsbereich").selectOption({ label: `Ziel ${tag}` });
  await expect(dialog).toContainText("wechseln den Arbeitsbereich");
  const confirm = dialog.getByRole("button", { name: "Verschieben", exact: true });
  await expect(confirm).toBeDisabled();
  release();
  await confirm.click();
  await expect(dialog).toHaveCount(0);
  // The app follows the page into the target workspace.
  await expect(page.locator(".page-title")).toHaveValue(`Umzug ${tag}`);
  const moved = await (await page.request.get(`/api/pages/${moving.id}`)).json();
  expect(moved.page.workspace_id).toBe(target.id);
  const old = await (await page.request.get(`/api/bootstrap?workspace=${boot.workspace.id}`)).json();
  expect(old.pages.some((p: { id: string }) => p.id === moving.id)).toBe(false);
});
