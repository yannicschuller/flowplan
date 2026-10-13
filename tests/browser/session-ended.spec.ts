import { test, expect } from "@playwright/test";

// When the session ends, the app goes to the sign-in page (keeping the page
// address) instead of showing "Bitte melde dich an.".
test("an ended session leads to the sign-in page", async ({ page, context }, info) => {
  test.setTimeout(90_000);
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const created = await page.request.post("/api/command", {
    headers: { origin },
    data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Sitzung ${Date.now()}`, kind: "document" },
  });
  const pageId = (await created.json()).id;
  await page.goto(`/#page=${pageId}`);
  await expect(page.getByLabel("Dokumentinhalt", { exact: true })).toBeVisible();
  await context.clearCookies();
  // Any request now fails with 401: e.g. adding a favourite.
  if (info.project.name === "desktop") await page.getByRole("button", { name: /Favorit/ }).first().click();
  // Any other request of the app (here: loading the page again) as well.
  else void page.evaluate(() => fetch("/api/bootstrap").catch(() => {}));
  await expect(page.locator("input[type=password], a[href^='/api/auth/login']").first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Bitte melde dich an.")).toHaveCount(0);
  expect(page.url()).toContain(`#page=${pageId}`);
});
