import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

// Issue #33: a whole space as one Markdown ZIP, from the sidebar – through
// the space's … menu since #674, not an icon of its own in the header.
test("a space is exported as Markdown from the sidebar's … menu", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "One run covers it.");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  if (process.env.TEST_ADMIN_EMAIL)
    await page.request.post("/api/auth/password", { headers: { origin }, data: { email: process.env.TEST_ADMIN_EMAIL, password: process.env.TEST_ADMIN_PASSWORD } });
  else await page.request.post("/api/auth/demo", { headers: { origin } });
  // A new account would see the introduction first.
  await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.onboarded" } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const space = boot.spaces[0];
  await page.goto("/");
  const header = page.locator(`.sidebar .nav-section[data-space-id="${space.id}"] > .nav-section-title`);
  await expect(header).toBeVisible({ timeout: 30_000 });
  // Three tools in the header: …, Seiten auswählen, Seite hinzufügen.
  await expect(header.locator(".nav-section-tools > button")).toHaveCount(3);
  await expect(page.getByRole("button", { name: `${space.name} als Markdown exportieren` })).toHaveCount(0);
  // With the keyboard: the menu opens with Enter, the entry is reached with the arrows.
  const menuButton = page.getByRole("button", { name: `Bereich ${space.name} verwalten`, exact: true });
  await menuButton.focus();
  await page.keyboard.press("Enter");
  const item = page.getByRole("menuitem", { name: "Als Markdown exportieren …" });
  await expect(item).toBeVisible();
  for (let i = 0; i < 10 && !(await item.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("ArrowDown");
  await expect(item).toBeFocused();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Bereich exportieren" });
  await expect(dialog).toContainText(`"spaceId":"${space.id}"`);
  await dialog.getByLabel("Kommentare und frühere Versionen einschließen").check();
  await page.screenshot({ path: "test-results/space-export.png" });
  const download = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Herunterladen" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/\.zip$/);
  const bytes = readFileSync((await file.path())!);
  expect(bytes.subarray(0, 2).toString()).toBe("PK");
  expect(bytes.includes(Buffer.from("index.md"))).toBe(true);
  await expect(dialog).toBeHidden();
  expect(errors).toEqual([]);
});
