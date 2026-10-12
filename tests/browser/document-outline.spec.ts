import { test, expect } from "@playwright/test";

// The table of contents follows the headings, jumps to them and stays open
// across documents and reloads.
test("table of contents beside a document", async ({ page }, info) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const created = await page.request.post("/api/command", {
    headers: { origin },
    data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Inhalt ${Date.now()}`, kind: "document" },
  });
  const pageId = (await created.json()).id;
  await page.goto(`/#page=${pageId}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await editor.click();
  for (const [h, text] of [["#", "Anfang"], ["##", "Mitte"], ["#", "Ende"]]) {
    await page.keyboard.type(`${h} ${text}`);
    await page.keyboard.press("Enter");
    await page.keyboard.type("Ein Absatz mit etwas Text. ".repeat(30));
    await page.keyboard.press("Enter");
  }
  const toggle = page.locator(".outline-toggle");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  const outline = page.getByRole("navigation", { name: "Inhaltsverzeichnis" });
  await expect(outline.getByRole("button")).toContainText(["Anfang", "Mitte", "Ende"]);
  // A new heading shows up while writing.
  await editor.locator("p").last().click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("## Anhang");
  await expect(outline.getByRole("button", { name: "Anhang" })).toBeVisible();
  // Jumping to a heading scrolls it into view and marks it.
  await outline.getByRole("button", { name: "Anfang" }).click();
  await expect(editor.locator("h1", { hasText: "Anfang" })).toBeInViewport();
  if (info.project.name === "mobile") {
    // On a phone the list covers the text, so it closes after the jump.
    await expect(outline).toHaveCount(0);
    await toggle.click();
  }
  await expect(outline.getByRole("button", { name: "Anfang" })).toHaveAttribute("aria-current", "location");
  // Open stays open after reloading.
  await page.reload();
  await expect(page.getByRole("navigation", { name: "Inhaltsverzeichnis" })).toBeVisible();
  await page.getByRole("button", { name: "Inhaltsverzeichnis schließen" }).click();
  await expect(page.getByRole("navigation", { name: "Inhaltsverzeichnis" })).toHaveCount(0);
  expect(errors).toEqual([]);
});
