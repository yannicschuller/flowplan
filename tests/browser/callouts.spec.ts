import { test, expect } from "@playwright/test";

// Callouts in the five kinds of GitHub alerts (issue #24): inserted with "/",
// changed from inside, shown with a title in the reader's language and kept
// when the page is stored.
test("callouts come as note, tip, important, warning and caution", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "One run covers it.");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const { id } = await (
    await page.request.post("/api/command", {
      headers: { origin },
      data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Hinweise ${Date.now()}`, kind: "document" },
    })
  ).json();
  await page.goto(`/#page=${id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await editor.click();
  await page.keyboard.type("/Warnung");
  await page.keyboard.press("Enter");
  const callout = editor.locator("aside[data-callout]");
  await expect(callout).toHaveAttribute("data-callout", "warning");
  // The title line comes from the kind, in German here.
  expect(await callout.evaluate((el) => getComputedStyle(el, "::before").content)).toBe('"Warnung"');
  // Inside a callout, the slash command changes its kind.
  await page.keyboard.press("End");
  await page.keyboard.type(" /Tipp");
  await page.keyboard.press("Enter");
  await expect(callout).toHaveAttribute("data-callout", "tip");
  await expect(callout).toHaveCount(1);
  await page.screenshot({ path: "test-results/callouts.png" });
  // Stored with the kind.
  await expect
    .poll(async () => (await (await page.request.get(`/api/pages/${id}`)).json()).html as string, { timeout: 15_000 })
    .toContain('data-callout="tip"');
  expect(errors).toEqual([]);
});
