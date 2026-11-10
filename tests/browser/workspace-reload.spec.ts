import { test, expect } from "@playwright/test";

// #188: a reload stays in the workspace (and on the page) it was in, and the
// server renders that workspace right away – no flash of the first one.
test("a reload keeps the workspace on the start page and on a page", async ({ page, browser }, info) => {
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  await command({ action: "profile.onboarded" });
  const name = `Zweiter ${info.project.name} ${Date.now()}`;
  const other = await command({ action: "workspace.create", name });
  const otherBoot = await (await page.request.get(`/api/bootstrap?workspace=${other.id}`)).json();
  const inOther = await command({
    action: "page.create",
    workspaceId: other.id,
    spaceId: otherBoot.spaces[0].id,
    title: `Drüben ${info.project.name}`,
    kind: "document",
  });
  await page.goto("/");
  if (info.project.name.includes("mobile"))
    await page.locator(".topbar").getByRole("button", { name: "Navigation öffnen", exact: true }).click();
  await page.locator(".workspace-switch").click();
  await page.getByRole("menuitem").filter({ hasText: name }).click();
  await expect(page.locator(".workspace-switch")).toContainText(name);
  await page.reload();
  await expect(page.locator(".workspace-switch")).toContainText(name);
  // On a page of that workspace, a reload stays on the page.
  await page.locator("#main-content").getByText(`Drüben ${info.project.name}`).first().click();
  await expect(page).toHaveURL(new RegExp(`#page=${inOther.id}`));
  await expect(page.locator(".page-title")).toHaveValue(`Drüben ${info.project.name}`);
  await page.reload();
  await expect(page.locator(".page-title")).toHaveValue(`Drüben ${info.project.name}`);
  await expect(page.locator(".workspace-switch")).toContainText(name);
  // The server renders the remembered workspace (seen without scripts):
  // no flash of the first workspace before the app has loaded.
  const plain = await browser.newContext({ javaScriptEnabled: false, baseURL: page.url() });
  await plain.addCookies(await page.context().cookies());
  const served = await plain.newPage();
  await served.goto("/");
  await expect(served.locator(".workspace-switch")).toContainText(name);
  await plain.close();
});
