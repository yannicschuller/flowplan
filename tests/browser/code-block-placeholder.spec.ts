import { test, expect } from "@playwright/test";
// #113: a code block as the page's only block must not get the empty page's
// hint ("Schreibe etwas …"), which was drawn over its language picker. An
// empty page still shows it.
test("the empty page's hint is not drawn over a lone code block", async ({ page }) => {
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const created = await page.request.post("/api/command", {
    headers: { origin },
    data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, kind: "document", title: `Placeholder ${Date.now()}` },
  });
  expect(created.ok()).toBe(true);
  const host = await created.json();
  await page.goto(`/#page=${host.id}`);
  const editor = page.locator(".ProseMirror").first();
  await expect(editor).toBeVisible({ timeout: 60_000 });
  const hint = async (selector: string) =>
    editor.locator(selector).first().evaluate((el) => getComputedStyle(el, "::before").content);
  // Empty page: the hint shows.
  await expect.poll(() => hint(".is-editor-empty")).toContain("Schreibe etwas");
  await editor.click();
  await page.keyboard.type("```yaml ");
  const block = editor.locator(".node-codeBlock");
  await expect(block).toBeVisible();
  await expect(block).toHaveClass(/is-editor-empty/);
  expect(await hint(".node-codeBlock")).toBe("none");
});
