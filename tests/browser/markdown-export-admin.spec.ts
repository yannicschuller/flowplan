import { test, expect } from "@playwright/test";

// Issue #31: administrators choose pages for the scheduled Markdown export;
// "Back up now" writes them next to the backups.
test("the scheduled Markdown export is set up in the administration", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "One run covers it.");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const title = `Hausakte ${Date.now()}`;
  await page.request.post("/api/command", {
    headers: { origin },
    data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title, kind: "document" },
  });
  await page.goto("/#admin");
  await page.getByRole("tab", { name: "Instanz" }).or(page.getByRole("button", { name: "Instanz" })).first().click();
  const section = page.locator(".markdown-export-settings");
  await section.getByRole("button", { name: /Seiten wählen|Auswahl ändern/ }).click();
  await section.getByLabel("Seite suchen").fill(title);
  await section.getByRole("checkbox", { name: new RegExp(title) }).check();
  await section.getByRole("button", { name: /speichern/ }).click();
  await expect(section.locator(".markdown-export-pages")).toContainText(title);
  await expect(section).toContainText("Nicht eingerichtet. Mit EXPORT_GIT_URL");
  await page.getByRole("button", { name: "Jetzt sichern" }).click();
  await expect(section.locator(".markdown-export-pages li").filter({ hasText: title })).toContainText(/\.zip \(/, { timeout: 30_000 });
  await section.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/markdown-export-admin.png" });
  // Clean up: the shared test instance keeps no export.
  await page.request.post("/api/admin/markdown-export", { headers: { origin }, data: { pageIds: [] } });
  expect(errors).toEqual([]);
});
