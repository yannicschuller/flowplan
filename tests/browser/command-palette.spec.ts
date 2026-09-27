import { test, expect } from "@playwright/test";

test("⌘K runs commands; focus mode counts words towards a goal", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const pageId = (
    await (
      await page.request.post("/api/command", {
        headers: { origin },
        data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Fokus ${info.project.name} ${Date.now()}`, kind: "document" },
      })
    ).json()
  ).id;
  await page.goto("/#home");
  // The shortcut works once the app is running.
  await expect(page.locator(".recent-section")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  const input = page.getByLabel("Suchen oder Befehl");
  await input.fill("> aufgaben");
  await expect(page.locator(".command-actions")).toContainText("Meine Aufgaben");
  await input.press("Enter");
  await expect(page.getByRole("heading", { name: "Meine Aufgaben" })).toBeVisible();

  // Page commands only while a page is open.
  await page.goto(`/#page=${pageId}`);
  await page.getByLabel("Dokumentinhalt", { exact: true }).click();
  await page.keyboard.type("Eins zwei drei vier fünf");
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByLabel("Suchen oder Befehl").fill(">fokus");
  await page.getByLabel("Suchen oder Befehl").press("Enter");
  const bar = page.getByRole("status", { name: "Fokusmodus" });
  await expect(bar).toContainText("5 Wörter");
  await expect(page.locator(".sidebar")).toBeHidden();
  await bar.getByLabel("Wortziel").fill("10");
  await page.getByLabel("Dokumentinhalt", { exact: true }).click();
  await page.keyboard.press("End");
  await page.keyboard.type(" sechs sieben acht neun zehn");
  await expect(bar).toContainText("Ziel erreicht");
  await bar.getByRole("button", { name: "Fokusmodus beenden" }).click();
  await expect(bar).toHaveCount(0);
  if (info.project.name === "desktop") await expect(page.locator(".sidebar")).toBeVisible();
  expect(errors).toEqual([]);
});
