import { test, expect } from "@playwright/test";

// "Print / PDF" prints a lean copy of the page content (hidden frame with the
// app's styles), after the menu has closed – Safari lays out the whole app
// before its print dialog, which took long.
test("print from the page menu prints a lean copy of the page", async ({ page }) => {
  test.setTimeout(90_000);
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const title = `Druck ${Date.now()}`;
  const created = await page.request.post("/api/command", {
    headers: { origin },
    data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title, kind: "document" },
  });
  const pageId = (await created.json()).id;
  await page.addInitScript(() => {
    (window as unknown as { printed: number }).printed = 0;
    window.print = () => {
      (window as unknown as { printed: number }).printed++;
    };
  });
  await page.goto(`/#page=${pageId}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await editor.click();
  await page.keyboard.type("Ein Absatz zum Drucken.");
  await page.getByRole("button", { name: "Seitenaktionen" }).click();
  await page.getByRole("menuitem", { name: "Drucken / PDF" }).click();
  const frame = page.frameLocator("iframe.print-frame");
  await expect(frame.locator(".page-content")).toContainText("Ein Absatz zum Drucken.");
  await expect(frame.locator("body")).toContainText(title);
  // The app itself is not printed, and the menu is closed.
  expect(await page.evaluate(() => (window as unknown as { printed: number }).printed)).toBe(0);
  await expect(page.getByRole("menu")).toHaveCount(0);
  // The copy has the app's styles.
  expect(await page.locator("iframe.print-frame").evaluate((f) => (f as HTMLIFrameElement).contentDocument!.styleSheets.length)).toBeGreaterThan(0);
});
