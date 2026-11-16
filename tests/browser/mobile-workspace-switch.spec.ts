import { test, expect, type Page } from "@playwright/test";

// On phones, a workspace switched in the drawer's workspace menu leaves the
// drawer open: it shows the new workspace's pages to pick one from. Picking
// one closes it as before.

const drawer = (page: Page) => page.locator(".app-shell > .sidebar");
const shell = (page: Page) => page.locator(".app-shell");

test("switching the workspace in the drawer keeps the drawer open", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "The drawer is the phone's navigation.");
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  await command({ action: "profile.onboarded" });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const stamp = Date.now();
  const here = await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    title: `Hier ${stamp}`,
    kind: "document",
  });
  const name = `Zweiter mobil ${stamp}`;
  const other = await command({ action: "workspace.create", name });
  const otherBoot = await (await page.request.get(`/api/bootstrap?workspace=${other.id}`)).json();
  const there = await command({
    action: "page.create",
    workspaceId: other.id,
    spaceId: otherBoot.spaces[0].id,
    title: `Drüben ${stamp}`,
    kind: "document",
  });
  await page.addInitScript(() => {
    try {
      localStorage.setItem("flowplan-app-promo", "1");
    } catch {}
  });

  // Opened on one of this workspace's pages.
  await page.goto(`/#page=${here.id}`);
  await expect(page.locator(".page-title")).toHaveValue(`Hier ${stamp}`, { timeout: 30_000 });
  await page.locator(".topbar").getByRole("button", { name: "Navigation öffnen", exact: true }).click();
  await expect(shell(page)).toHaveClass(/nav-open/);

  await page.locator(".workspace-switch").click();
  await page.getByRole("menuitem").filter({ hasText: name }).click();
  await expect(page.locator(".workspace-switch")).toContainText(name);
  // The drawer stays open, with the other workspace's pages in it.
  await expect(drawer(page).getByText(`Drüben ${stamp}`, { exact: true })).toBeVisible();
  await expect(drawer(page).getByText(`Hier ${stamp}`, { exact: true })).toHaveCount(0);
  // Settled: nothing closes it a moment later.
  await page.waitForTimeout(800);
  await expect(shell(page)).toHaveClass(/nav-open/);
  await expect(drawer(page)).toBeInViewport();

  // Picking a page there closes the drawer and opens the page.
  await drawer(page).getByText(`Drüben ${stamp}`, { exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#page=${there.id}`));
  await expect(page.locator(".page-title")).toHaveValue(`Drüben ${stamp}`);
  await expect(shell(page)).not.toHaveClass(/nav-open/);

  // Back to the first workspace (its state is kept in this tab, so it shows
  // at once and lands on the page it was on): the drawer stays open too.
  await page.locator(".topbar").getByRole("button", { name: "Navigation öffnen", exact: true }).click();
  await page.locator(".workspace-switch").click();
  await page.getByRole("menuitem").filter({ hasText: boot.workspace.name }).click();
  await expect(page.locator(".workspace-switch")).toContainText(boot.workspace.name);
  await expect(drawer(page).getByText(`Hier ${stamp}`, { exact: true })).toBeVisible();
  await page.waitForTimeout(800);
  await expect(shell(page)).toHaveClass(/nav-open/);
});
