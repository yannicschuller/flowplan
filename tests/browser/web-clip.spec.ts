import { test, expect } from "@playwright/test";

test("clip a link as a bookmark and import browser bookmarks", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const stamp = `${info.project.name}-${Date.now()}`;
  const url = `https://example.com/${stamp}`;
  await page.goto(`/share-target?title=${encodeURIComponent(`Artikel ${stamp}`)}&url=${encodeURIComponent(url)}&text=${encodeURIComponent("Markierter Satz")}`);
  await page.getByRole("radio", { name: "Als Lesezeichen" }).click();
  await page.getByRole("button", { name: "Als Lesezeichen speichern" }).click();
  // The record opens in the bookmarks database.
  await expect(page.locator(".page-title")).toHaveValue("Lesezeichen");
  await expect(page.getByRole("dialog", { name: "Eintrag" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".data-table")).toContainText(`Artikel ${stamp}`);
  await expect(page.locator(".data-table")).toContainText("example.com");

  await page.goto("/#settings");
  await page.getByRole("button", { name: "Daten", exact: true }).or(page.getByRole("tab", { name: "Daten" })).first().click();
  const section = page.locator(".clipper-settings");
  await expect(section.getByRole("link", { name: "In Flowplan speichern" })).toHaveAttribute("href", /^javascript:/);
  await section.locator('input[type="file"]').setInputFiles({
    name: "bookmarks.html",
    mimeType: "text/html",
    buffer: Buffer.from(
      `<DL><DT><H3>Import ${stamp}</H3><DL><DT><A HREF="https://example.org/${stamp}/1">Eins ${stamp}</A><DT><A HREF="https://example.org/${stamp}/2">Zwei ${stamp}</A></DL></DL>`,
    ),
  });
  await expect(page.getByText("2 Lesezeichen importiert")).toBeVisible();
  expect(errors).toEqual([]);
});
