import { test, expect, type Locator } from "@playwright/test";

// "/text" on a task (#464): the line leaves the task list without its box,
// the other tasks stay one list with their usual spacing; one undo brings
// the task back.
test("/text turns a task into a plain line; the other tasks stay a list", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "keyboard: desktop");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const created = await (
    await page.request.post("/api/command", {
      headers: { origin },
      data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Text ${Date.now()}`, kind: "document" },
    })
  ).json();
  await page.goto(`/#page=${created.id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  const line = (text: string) => editor.locator("p", { hasText: new RegExp(`^${text}$`) });
  const task = (text: string) => editor.locator("li[data-checked]", { has: page.locator(":scope > div > p", { hasText: new RegExp(`^${text}$`) }) });
  // Distance from the bottom of one line to the top of the next.
  const gap = async (upper: Locator, lower: Locator) => {
    const a = await upper.boundingBox(),
      b = await lower.boundingBox();
    return Math.round(b!.y - (a!.y + a!.height));
  };

  // The issue's steps: Ctrl+L, "text 1", Enter, Ctrl+L, "text 2", Enter,
  // Ctrl+L, "text 3".
  await editor.click();
  await page.keyboard.press("ControlOrMeta+l");
  await page.keyboard.type("text 1");
  await page.keyboard.press("Enter");
  await page.keyboard.press("ControlOrMeta+l");
  await page.keyboard.type("text 2");
  await page.keyboard.press("Enter");
  await page.keyboard.press("ControlOrMeta+l");
  await page.keyboard.type("text 3");
  await expect(editor.locator('ul[data-type="taskList"]')).toHaveCount(1);
  await expect(editor.locator("li[data-checked]")).toHaveCount(3);
  const taskGap = await gap(line("text 2"), line("text 3"));
  const status2 = await task("text 2").getAttribute("data-status");

  // Back to "text 1", "/text", Enter.
  await line("text 1").click();
  await page.keyboard.press("End");
  await page.keyboard.type("/text");
  const menu = page.locator(".slash-menu");
  await expect(menu.locator("button").first()).toContainText("Text");
  await page.keyboard.press("Enter");
  await expect(menu).toHaveCount(0);

  // "text 1" is a plain paragraph: not in a list, no box beside it.
  await expect(line("text 1")).toHaveCount(1);
  await expect(task("text 1")).toHaveCount(0);
  expect(await line("text 1").evaluate((p) => p.parentElement?.getAttribute("contenteditable"))).toBe("true");
  await expect(editor.locator("li[data-checked]")).toHaveCount(2);
  // The other two are still one task list, in their states.
  await expect(editor.locator('ul[data-type="taskList"]')).toHaveCount(1);
  await expect(task("text 2")).toHaveAttribute("data-status", status2 ?? "");
  // Spacing: the tasks keep theirs; above them the gap a paragraph has.
  expect(await gap(line("text 2"), line("text 3"))).toBe(taskGap);
  const paragraphGap = await line("text 1").evaluate((p) => Math.round(parseFloat(getComputedStyle(p).marginBottom)));
  expect(Math.abs((await gap(line("text 1"), line("text 2"))) - paragraphGap)).toBeLessThanOrEqual(1);
  // The caret stays in the line.
  expect(await page.evaluate(() => window.getSelection()?.anchorNode?.textContent)).toBe("text 1");

  // Ctrl+Alt+0 does the same on the last task.
  await line("text 3").click();
  await page.keyboard.press("ControlOrMeta+Alt+0");
  await expect(task("text 3")).toHaveCount(0);
  await expect(line("text 3")).toHaveCount(1);
  await expect(task("text 2")).toHaveCount(1);
  await page.waitForTimeout(700);

  // Undo: each turn comes back in one step (the "/" command with its
  // typed query, as for every command of the menu).
  await page.keyboard.press("ControlOrMeta+z");
  await expect(task("text 3")).toHaveCount(1);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(task("text 1/text")).toHaveCount(1);
  await expect(editor.locator("li[data-checked]")).toHaveCount(3);
  await expect(editor.locator('ul[data-type="taskList"]')).toHaveCount(1);
  expect(errors).toEqual([]);
});
