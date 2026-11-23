import { test, expect } from "@playwright/test";

// #452: the navigation at the top of the sidebar (Search, Home, Inbox,
// My tasks …) folds into one row of icons; the buttons keep their names
// and still work, and the fold is stored like the other sidebar folds.

const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";

test("the sidebar navigation folds into a row of icons and stays folded", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "phones use the tab bar and the drawer");
  await page.request.post("/api/auth/demo", { headers: { origin } });
  await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.onboarded" } });
  await page.goto("/#home");
  const nav = page.getByRole("navigation", { name: "Navigation", exact: true });
  const inbox = nav.getByRole("button", { name: /^Posteingang/ });
  await expect(inbox).toBeVisible();
  const tall = (await nav.boundingBox())!.height;

  await nav.hover();
  await nav.getByRole("button", { name: "Navigation einklappen" }).click();
  await expect(nav).toHaveClass(/compact/);
  // One row: much lower than before; the label is no longer shown but stays the name.
  await expect.poll(async () => (await nav.boundingBox())!.height).toBeLessThan(tall / 2);
  await expect(inbox.locator(".main-nav-label")).toHaveCSS("position", "absolute");
  await expect(inbox).toHaveAttribute("title", "Posteingang");
  await inbox.click();
  await expect(page).toHaveURL(/#inbox/);

  // Stored with the account: still folded after a reload.
  await page.reload();
  await expect(nav).toHaveClass(/compact/);
  await nav.getByRole("button", { name: "Navigation ausklappen" }).click();
  await expect(nav).not.toHaveClass(/compact/);
  await expect(inbox.locator(".main-nav-label")).toBeVisible();
});
