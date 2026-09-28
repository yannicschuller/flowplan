import { test, expect } from "@playwright/test";

test("react to a comment and to a paragraph", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const pageId = (
    await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Reaktionen ${info.project.name} ${Date.now()}`, kind: "document" })
  ).id;
  await command({ action: "comment.create", pageId, body: "Sieht gut aus" });
  await page.goto(`/#page=${pageId}`);

  // A paragraph: write, then react via the text menu.
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await editor.click();
  await page.keyboard.type("Wir starten im Oktober");
  // No smiley at the end of the line any more.
  await expect(editor.locator(".block-reaction-add")).toHaveCount(0);
  // Selecting text opens the text menu with reactions and formatting.
  const select = async () => {
    const text = editor.getByText("Wir starten im Oktober");
    if (info.project.name !== "desktop") return text.dblclick();
    const box = (await text.boundingBox())!;
    await page.mouse.move(box.x + 4, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 120, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();
  };
  await select();
  const menu = page.getByRole("menu", { name: "Textmenü" });
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitemcheckbox", { name: "Mit 🎉 reagieren" }).click();
  await expect(menu).toHaveCount(0);
  const pill = editor.locator(".block-reaction", { hasText: "🎉 1" });
  await expect(pill).toBeVisible();
  await expect(pill).toHaveClass(/mine/);
  await expect
    .poll(async () => (await (await page.request.get(`/api/pages/${pageId}`)).json()).html, { timeout: 10_000 })
    .toContain("data-reactions");
  // Clicking the own reaction takes it back.
  await pill.click();
  await expect(editor.locator(".block-reaction")).toHaveCount(0);
  // Right click opens the same menu at the pointer; formatting works from there.
  if (info.project.name === "desktop") {
    await select();
    await menu.getByRole("menuitemcheckbox", { name: "Fett" }).click();
    await expect(editor.locator("strong")).toHaveCount(1);
    await page.keyboard.press("End");
    await editor.getByText("Wir starten im").click({ button: "right" });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Kommentieren" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
  }

  // The comment.
  await page.getByRole("button", { name: "Kommentare" }).first().click();
  const comment = page.locator(".comment", { hasText: "Sieht gut aus" });
  await comment.getByRole("button", { name: "Reaktion hinzufügen" }).click();
  await comment.getByRole("button", { name: "Mit 👍 reagieren" }).click();
  await expect(comment.getByRole("button", { name: "👍 1 Reaktion" })).toHaveAttribute("aria-pressed", "true");
  await comment.getByRole("button", { name: "👍 1 Reaktion" }).click();
  await expect(comment.locator(".reaction-button")).toHaveCount(0);
  expect(errors).toEqual([]);
});
