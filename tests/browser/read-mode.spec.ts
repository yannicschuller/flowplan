import { test, expect } from "@playwright/test";

// A document can be opened for reading: no editing until switched back,
// remembered for this page on this device.
test("documents switch between reading and editing", async ({ page }) => {
  test.setTimeout(120_000);
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const created = await page.request.post("/api/command", {
    headers: { origin },
    data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Lesen ${Date.now()}`, kind: "document" },
  });
  const pageId = (await created.json()).id;
  await page.goto(`/#page=${pageId}`);
  const content = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(content).toHaveAttribute("contenteditable", "true");
  await page.getByRole("button", { name: "Lesemodus" }).click();
  await expect(content).toHaveAttribute("contenteditable", "false");
  // Remembered after a reload.
  await page.reload();
  await expect(page.getByLabel("Dokumentinhalt", { exact: true })).toHaveAttribute("contenteditable", "false");
  await page.getByRole("button", { name: "Bearbeiten" }).click();
  await expect(page.getByLabel("Dokumentinhalt", { exact: true })).toHaveAttribute("contenteditable", "true");
  await page.request.post("/api/command", { headers: { origin }, data: { action: "page.delete", pageId } });
});
