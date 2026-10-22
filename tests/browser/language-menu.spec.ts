import { test, expect } from "@playwright/test";

// The language is chosen from a small menu with flags (sign-in page) or a
// list (settings), which keeps its size however many languages there are.
test("the language menu on the sign-in page switches the language", async ({ page, context }, info) => {
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await context.clearCookies();
  await page.goto("/");
  const trigger = page.getByRole("button", { name: "Sprache: Deutsch" });
  await expect(trigger).toBeVisible({ timeout: 30_000 });
  await expect(trigger).toContainText("DE");
  await trigger.click();
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitemradio")).toHaveCount(3);
  await expect(menu.getByRole("menuitemradio", { name: "Deutsch" })).toHaveAttribute("aria-checked", "true");
  await page.waitForTimeout(400); // the menu fades in
  await page.screenshot({ path: `test-results/language-menu/${info.project.name}-login.png` });
  await page.evaluate(() => (document.documentElement.dataset.theme = "dark"));
  await page.waitForTimeout(300);
  await page.screenshot({ path: `test-results/language-menu/${info.project.name}-login-dark.png` });
  await menu.getByRole("menuitemradio", { name: "Français" }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "fr", { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Langue: Français" })).toBeVisible();
  expect((await context.cookies(origin)).find((c) => c.name === "flowplan-lang")?.value).toBe("fr");

  // Keyboard: open with Enter, move with the arrows, choose with Enter.
  if (info.project.name === "desktop") {
    await page.getByRole("button", { name: "Langue: Français" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menu")).toBeVisible();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(page.locator("html")).toHaveAttribute("lang", /^(de|en)$/, { timeout: 30_000 });
  }
  await context.clearCookies();
});

test("the language list in the settings shows flags and the automatic choice", async ({ page }, info) => {
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  await page.goto("/#settings/appearance");
  const select = page.getByRole("combobox", { name: "Sprache" });
  await expect(select).toBeAttached({ timeout: 60_000 });
  await expect(select.locator("option")).toHaveText(["🌐 Automatisch (folgt dem Browser)", "🇩🇪 Deutsch", "🇬🇧 English", "🇫🇷 Français"]);
  await expect(select).toHaveValue("");
  await select.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `test-results/language-menu/${info.project.name}-settings.png` });
  if (info.project.name === "desktop") {
    await page.locator(".language-select").click();
    await expect(page.locator(".fp-select-list")).toBeVisible();
    await expect(page.locator(".fp-select-list")).toContainText("🇫🇷 Français");
    await page.screenshot({ path: `test-results/language-menu/${info.project.name}-settings-open.png` });
    await page.keyboard.press("Escape");
  }
});
