import { test, expect, type Locator } from "@playwright/test";

// The UI chrome shows the arrow, not the text cursor (#543); its fields and
// the editor keep the I-beam, page rows show the pointer (#544).
// tests/hover-cursor.test.ts checks the rules themselves.
const cursor = (locator: Locator) => locator.evaluate((el) => getComputedStyle(el).cursor);

test("chrome, fields, page rows and the editor show the right cursor", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "The sidebar is shown on wide screens.");
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  if (!(await page.request.post("/api/auth/demo", { headers: { origin } })).ok()) {
    const account = { name: "Mara Lindqvist", email: "mara-cursor@example.test", password: "ein-langes-passwort" };
    if (!(await page.request.post("/api/auth/register", { headers: { origin }, data: account })).ok())
      await page.request.post("/api/auth/password", { headers: { origin }, data: account });
  }
  const boot = await (await page.request.get("/api/bootstrap")).json();
  await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.onboarded" } });
  const created = await page.request.post("/api/command", {
    headers: { origin },
    data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Cursor ${Date.now()}` },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const doc = await created.json();

  await page.goto(`/#page=${doc.id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor).toBeVisible({ timeout: 30_000 });
  const sidebar = page.locator(".sidebar");
  expect(await cursor(sidebar)).toBe("default");
  expect(await cursor(page.locator(".topbar").first())).toBe("default");
  expect(await cursor(sidebar.locator(".tree-filter input"))).toBe("text");
  expect(await cursor(sidebar.locator(".page-nav").first())).toBe("pointer");
  expect(await cursor(sidebar.locator(".page-nav-title").first())).toBe("pointer");
  expect(await cursor(editor)).toBe("auto");
});
