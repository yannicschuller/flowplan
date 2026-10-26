import { test, expect } from "@playwright/test";

// On a phone the selection menu follows a touch selection (no mouseup) and
// stays on screen, its rows wrapping instead of leaving the edge.
test("the selection menu follows a touch selection and stays on screen", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "Touch selection on a phone.");
  test.setTimeout(120_000);
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const created = await page.request.post("/api/command", {
    headers: { origin },
    data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Menü ${Date.now()}`, kind: "document" },
  });
  const pageId = (await created.json()).id;
  await page.goto(`/#page=${pageId}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor).toBeVisible();
  // A new account's welcome tour.
  const welcome = page.getByRole("dialog", { name: "Willkommen bei Flowplan" });
  if (await welcome.isVisible()) {
    await page.keyboard.press("Escape");
    await expect(welcome).toBeHidden();
  }
  await editor.click();
  await page.keyboard.type("Erste Zeile");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Telekom SDSB");
  const select = (index: number, from: number, to: number) =>
    page.evaluate(
      ([index, from, to]) => {
        const p = document.querySelectorAll(".ProseMirror p")[index];
        const text = p.firstChild!;
        const range = document.createRange();
        range.setStart(text, from);
        range.setEnd(text, to);
        const sel = document.getSelection()!;
        sel.removeAllRanges();
        sel.addRange(range);
      },
      [index, from, to] as const,
    );
  const menu = page.locator(".text-menu.selection");
  const inside = async () => {
    await page.waitForTimeout(200); // the opening animation
    const box = (await menu.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(7);
    expect(box.x + box.width).toBeLessThanOrEqual(390 - 7);
    expect(box.y).toBeGreaterThanOrEqual(0);
    return box;
  };
  await select(0, 0, 5);
  await expect(menu).toBeVisible();
  const first = await inside();
  // Dragging the handles to another line: the menu moves with it.
  await select(1, 0, 12);
  await expect.poll(async () => (await menu.boundingBox())!.y).toBeGreaterThan(first.y + 10);
  await inside();
});
