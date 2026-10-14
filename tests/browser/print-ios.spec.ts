import { test, expect, devices } from "@playwright/test";

// On iPhone and iPad, Safari prints the page itself (not a frame) and only
// while the tap still counts: "Print / PDF" puts the lean copy into the page
// and prints right away, with only the copy in print.
test.use({ ...devices["iPhone 13"], locale: "de-DE" });

test("print on iPhone prints a lean copy in the page right away", async ({ page }) => {
  test.setTimeout(90_000);
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const title = `Druck iOS ${Date.now()}`;
  const created = await page.request.post("/api/command", {
    headers: { origin },
    data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title, kind: "document" },
  });
  const pageId = (await created.json()).id;
  type Printed = { at: number; copying: boolean; text: string }[];
  await page.addInitScript(() => {
    const w = window as unknown as { printed: Printed };
    w.printed = [];
    window.print = () => {
      w.printed.push({
        at: performance.now(),
        copying: document.documentElement.classList.contains("printing-copy"),
        text: document.querySelector(".print-copy")?.textContent ?? "",
      });
    };
  });
  await page.goto(`/#page=${pageId}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await editor.click();
  await page.keyboard.type("Ein Absatz zum Drucken.");
  await page.getByRole("button", { name: "Seitenaktionen" }).click();
  const item = page.getByRole("menuitem", { name: "Drucken / PDF" });
  await item.waitFor();
  const tapped = await page.evaluate(() => performance.now());
  await item.click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { printed: Printed }).printed.length)).toBe(1);
  const [printed] = await page.evaluate(() => (window as unknown as { printed: Printed }).printed);
  // Printed while the tap still counts (Safari forwards it for about a second).
  expect(printed.at - tapped).toBeLessThan(1000);
  expect(printed.copying).toBe(true);
  expect(printed.text).toContain("Ein Absatz zum Drucken.");
  expect(printed.text).toContain(title);
  await expect(page.locator("iframe.print-frame")).toHaveCount(0);
  await expect(page.getByRole("menu")).toHaveCount(0);
  // On screen the copy is hidden; in print only the copy shows.
  await expect(page.locator(".print-copy")).toBeHidden();
  await page.emulateMedia({ media: "print" });
  await expect(page.locator(".print-copy .page-content")).toBeVisible();
  await expect(page.locator(".app-shell")).toBeHidden();
  await page.emulateMedia({ media: "screen" });
  // After printing, the copy is gone.
  await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
  await expect(page.locator(".print-copy")).toHaveCount(0);
  await expect(page.locator(".app-shell")).toBeVisible();
});
