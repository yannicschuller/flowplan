import { test, expect } from "@playwright/test";

// Light and dark (lib/theme.ts): "Automatic" follows the device, also while
// the page is open; "Light" and "Dark" stay; sign-in pages follow too.
test("the appearance follows the device unless light or dark is chosen", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "One run covers it.");
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  const theme = () => page.evaluate(() => document.documentElement.dataset.theme);
  await page.emulateMedia({ colorScheme: "dark" });

  // Before signing in: already dark, before any script of the app ran.
  await page.goto("/login");
  expect(await theme()).toBe("dark");
  // It follows the device while open, too.
  await page.emulateMedia({ colorScheme: "light" });
  await expect.poll(theme).toBe("light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(theme).toBe("dark");

  await page.request.post("/api/auth/demo", { headers: { origin } });
  await page.goto("/#settings");
  const appearance = page.getByRole("radiogroup", { name: "Erscheinungsbild" });
  await expect(appearance.getByRole("radio", { name: "Automatisch" })).toBeChecked();
  expect(await theme()).toBe("dark");
  // The device switches to light: the open page follows.
  await page.emulateMedia({ colorScheme: "light" });
  await expect.poll(theme).toBe("light");

  // "Dark" stays, whatever the device does, also after a reload.
  await appearance.getByText("Dunkel").click();
  await expect.poll(theme).toBe("dark");
  await page.reload();
  expect(await theme()).toBe("dark");
  await expect(page.getByRole("radiogroup", { name: "Erscheinungsbild" }).getByRole("radio", { name: "Dunkel" })).toBeChecked();

  // Back to automatic: light again, like the device.
  await page.getByRole("radiogroup", { name: "Erscheinungsbild" }).getByText("Automatisch").click();
  await expect.poll(theme).toBe("light");
  expect(await page.evaluate(() => localStorage.getItem("flowplan-theme"))).toBeNull();
});
