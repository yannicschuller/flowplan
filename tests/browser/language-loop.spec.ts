import { test, expect } from "@playwright/test";

// A language fixed in the profile wins over a stale or doubled cookie
// (flowplan.org shares one with the website): the page shows the profile's
// language right away and does not reload in a loop.
test("the profile language wins over an old cookie without reloading", async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "One run covers it.");
  test.setTimeout(120_000);
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = (data: Record<string, unknown>) =>
    page.request.post("/api/command", { headers: { origin }, data: { workspaceId: boot.workspace.id, ...data } });
  expect((await command({ action: "profile.language", language: "de" })).ok()).toBe(true);
  try {
    await context.addCookies([{ name: "flowplan-lang", value: "en", url: origin }]);
    let loads = 0;
    page.on("load", () => loads++);
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("lang", "de");
    await expect(page.getByRole("button", { name: "Suchen" }).first()).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(3000);
    expect(loads).toBe(1);
    // The cookie follows the profile.
    expect((await context.cookies()).find((c) => c.name === "flowplan-lang")?.value).toBe("de");
  } finally {
    await command({ action: "profile.language", language: null });
  }
});
