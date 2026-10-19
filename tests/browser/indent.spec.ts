import { test, expect, type Locator } from "@playwright/test";

// Tab / Shift+Tab indent paragraphs and headings visibly; lists and tasks
// nest instead, without an extra indent of their own.
const inset = (el: Locator) => el.evaluate((n) => parseFloat(getComputedStyle(n).paddingInlineStart) + parseFloat(getComputedStyle(n).marginInlineStart));

test("Tab indents blocks visibly, lists nest without a double indent", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Keyboard test on the desktop.");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  if (process.env.TEST_ADMIN_EMAIL)
    await page.request.post("/api/auth/password", { headers: { origin }, data: { email: process.env.TEST_ADMIN_EMAIL, password: process.env.TEST_ADMIN_PASSWORD } });
  else await page.request.post("/api/auth/demo", { headers: { origin } });
  await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.onboarded" } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const created = await (
    await page.request.post("/api/command", {
      headers: { origin },
      data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Einrücken ${Date.now()}`, kind: "document" },
    })
  ).json();
  await page.goto(`/#page=${created.id}`);
  const editor = page.locator(".ProseMirror").first();
  await editor.click();
  await page.keyboard.type("Absatz");
  const paragraph = editor.locator("p").first();
  const before = await inset(paragraph);
  await page.keyboard.press("Tab");
  await expect(paragraph).toHaveAttribute("data-indent", "1");
  expect(await inset(paragraph)).toBeGreaterThan(before + 20);
  await page.keyboard.press("Tab");
  await expect(paragraph).toHaveAttribute("data-indent", "2");
  await page.keyboard.press("Shift+Tab");
  await expect(paragraph).toHaveAttribute("data-indent", "1");

  // A list right after an indented line: the item nests, nothing doubles.
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("- Punkt a");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Punkt b");
  await page.keyboard.press("Tab");
  await expect(editor.locator("ul ul li")).toHaveText("Punkt b");
  await expect(editor.locator("li p[data-indent]")).toHaveCount(0);

  // Headings too; Backspace at the start moves back out.
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("## Titel");
  await page.keyboard.press("Home");
  const heading = editor.locator("h2").first();
  const flat = await inset(heading);
  await page.keyboard.press("Tab");
  await expect(heading).toHaveAttribute("data-indent", "1");
  expect(await inset(heading)).toBeGreaterThan(flat + 20);
  await page.keyboard.press("Backspace");
  await expect(heading).not.toHaveAttribute("data-indent", /.+/);
  await page.screenshot({ path: "test-results/indent.png" });
  expect(errors).toEqual([]);
});
