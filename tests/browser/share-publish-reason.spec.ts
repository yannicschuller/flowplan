import { test, expect } from "@playwright/test";

// #524: "Im Web veröffentlichen" works in reading mode, and a greyed-out
// switch says why (here: the page is locked).
test("publish switch: usable in reading mode, a reason when the page is locked", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "One run covers the dialog.");
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.onboarded" } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const r = await page.request.post("/api/command", { headers: { origin }, data });
    expect(r.ok(), await r.text()).toBe(true);
    return r.json();
  };
  const created = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Veröffentlichen ${Date.now()}`, kind: "document" });
  await page.goto(`/#page=${created.id}`);
  await expect(page.getByLabel("Dokumentinhalt", { exact: true })).toBeVisible();
  // Reading mode is only a view: the switch stays usable.
  await page.getByRole("button", { name: /^Lesemodus/ }).first().click();
  await page.getByRole("button", { name: "Teilen" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Seite teilen" });
  await dialog.getByRole("tab", { name: /Web/ }).click();
  const toggle = dialog.getByRole("switch", { name: "Im Web veröffentlichen" });
  await expect(toggle).toBeEnabled();
  await expect(dialog.locator(".sh-publish-reason")).toHaveCount(0);
  await page.keyboard.press("Escape");
  // Locked: greyed out, with the reason and the way out.
  await command({ action: "page.update", pageId: created.id, patch: { locked: true } });
  await page.reload();
  await page.getByRole("button", { name: "Teilen" }).first().click();
  await dialog.getByRole("tab", { name: /Web/ }).click();
  await expect(toggle).toBeDisabled();
  await expect(dialog.locator(".sh-publish-reason")).toContainText("Die Seite ist gesperrt");
});
