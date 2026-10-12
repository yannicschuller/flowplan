import { test, expect } from "@playwright/test";

// "Print / PDF" opens the browser's print dialog once the menu has closed
// (Safari ignores window.print() while a menu still holds the page).
test("print from the page menu after the menu has closed", async ({ page }) => {
  test.setTimeout(90_000);
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const created = await page.request.post("/api/command", {
    headers: { origin },
    data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Druck ${Date.now()}`, kind: "document" },
  });
  const pageId = (await created.json()).id;
  await page.addInitScript(() => {
    (window as unknown as { printed: { menuOpen: boolean }[] }).printed = [];
    window.print = () => {
      (window as unknown as { printed: { menuOpen: boolean }[] }).printed.push({ menuOpen: !!document.querySelector("[role=menu]") });
    };
  });
  await page.goto(`/#page=${pageId}`);
  await page.getByRole("button", { name: "Seitenaktionen" }).click();
  await page.getByRole("menuitem", { name: "Drucken / PDF" }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { printed: unknown[] }).printed)).toEqual([{ menuOpen: false }]);
});
