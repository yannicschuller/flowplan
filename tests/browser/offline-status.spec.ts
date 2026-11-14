import { test, expect } from "@playwright/test";

// Offline shows as a small icon at the end of the top bar (#296), not as a
// banner over the page: a tap opens the explanation, Escape closes it, and
// it goes away once the connection is back.
const origin = () => process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const shots = process.env.OFFLINE_SHOTS;

test("offline is a small icon in the top bar with the explanation on a tap", async ({ page, context }, info) => {
  await page.request.post("/api/auth/demo", { headers: { origin: origin() } });
  await page.request.post("/api/command", { headers: { origin: origin() }, data: { action: "profile.onboarded" } });
  await page.goto("/#home");
  const topbar = page.locator(".topbar");
  await expect(topbar).toBeVisible({ timeout: 30_000 });
  const before = (await topbar.boundingBox())!.y;

  await context.setOffline(true);
  const icon = topbar.locator(".offline-status-button");
  await expect(icon).toBeVisible();
  await expect(page.locator(".offline-banner")).toHaveCount(0);
  // The page does not move down.
  expect((await topbar.boundingBox())!.y).toBe(before);
  await expect(icon).toHaveAccessibleName("Offline – Details");
  // On the right side of the bar, not in its middle.
  const bar = (await topbar.boundingBox())!, at = (await icon.boundingBox())!;
  expect(at.x + at.width / 2).toBeGreaterThan(bar.x + bar.width * 0.6);
  await icon.click();
  const note = page.locator(".offline-status-note");
  await expect(note).toContainText("Offline – du siehst den zuletzt gespeicherten Stand. Textänderungen werden später abgeglichen.");
  await expect(icon).toHaveAttribute("aria-expanded", "true");
  // Inside the window, also on a phone.
  const box = (await note.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  if (shots) await page.screenshot({ path: `${shots}/offline-status-${info.project.name}.png` });
  await page.keyboard.press("Escape");
  await expect(note).toHaveCount(0);

  await context.setOffline(false);
  await expect(icon).toHaveCount(0, { timeout: 15_000 });
});
