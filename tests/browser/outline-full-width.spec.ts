import { test, expect } from "@playwright/test";

// "Volle Breite" with the table of contents open beside the text: the text
// makes room for the list instead of running under it.
test("full-width page leaves room for the open table of contents", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "The list sits beside the text on wide screens only.");
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1600, height: 900 });
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const created = await page.request.post("/api/command", {
    headers: { origin },
    data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Breit ${Date.now()}`, kind: "document" },
  });
  const pageId = (await created.json()).id;
  const updated = await page.request.post("/api/command", {
    headers: { origin },
    data: { action: "page.update", pageId, patch: { full_width: true } },
  });
  expect(updated.ok(), await updated.text()).toBe(true);
  await page.goto(`/#page=${pageId}`);
  await expect(page.locator(".page-content.full-width")).toBeVisible();
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await editor.click();
  for (const text of ["Anfang", "Mitte"]) {
    await page.keyboard.type(`# ${text}`);
    await page.keyboard.press("Enter");
    await page.keyboard.type("Ein langer Absatz, der über die ganze Breite läuft. ".repeat(8));
    await page.keyboard.press("Enter");
  }
  const toggle = page.locator(".outline-toggle");
  if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
  const outline = page.getByRole("navigation", { name: "Inhaltsverzeichnis" });
  await expect(outline).toBeVisible();
  const list = (await outline.boundingBox())!;
  const text = (await editor.locator("p").first().boundingBox())!;
  expect(text.x + text.width, "the text ends before the list starts").toBeLessThanOrEqual(list.x + 1);
});
