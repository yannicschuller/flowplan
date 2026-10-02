import { test, expect } from "@playwright/test";

test("ticking a task ticks its subtasks; new tasks after a carried one get no ↻", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const html =
    '<ul data-type="taskList">' +
    '<li data-type="taskItem" data-checked="false" data-journal-since="2026-09-01"><p>Übernommen</p></li>' +
    '<li data-type="taskItem" data-checked="false"><p>Umzug</p><ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>Kartons</p></li></ul></li>' +
    "</ul>";
  const p = await (
    await page.request.post("/api/command", {
      headers: { origin },
      data: { action: "page.import", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Unteraufgaben ${info.project.name} ${Date.now()}`, content: html, format: "html" },
    })
  ).json();
  await page.goto(`/#page=${p.id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor).toContainText("Kartons");
  // The task whose own line is `text` (not a parent that contains it).
  const task = (text: string) =>
    editor.locator("li[data-checked]", { has: page.locator(":scope > div > p", { hasText: new RegExp(`^${text}$`) }) });

  // Ticking "Umzug" ticks "Kartons" too; only done tasks are struck through.
  await task("Umzug").locator("> label input").check();
  await expect(task("Kartons")).toHaveAttribute("data-checked", "true");
  await task("Kartons").locator("> label input").uncheck();
  await expect(task("Kartons")).toHaveAttribute("data-checked", "false");
  await expect(task("Umzug")).toHaveAttribute("data-checked", "true");
  // Caret at the start or end of a line.
  const caret = async (text: string, atEnd: boolean) => {
    const line = editor.locator(`p:text-is("${text}")`);
    await line.click();
    await line.evaluate((el, end) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(!end);
      const selection = getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    }, atEnd);
    await page.waitForTimeout(100);
  };
  const decoration = (text: string) =>
    editor.locator(`p:text-is("${text}")`).evaluate((el) => getComputedStyle(el).textDecorationLine);
  expect(await decoration("Umzug")).toContain("line-through");
  expect(await decoration("Kartons")).not.toContain("line-through");

  // Enter after the carried task: the new task has no ↻ badge.
  await caret("Übernommen", true);
  await page.keyboard.press("Enter");
  await page.keyboard.type("Neu geschrieben");
  await expect(task("Übernommen")).toHaveAttribute("data-journal-since", "2026-09-01");
  await expect(task("Neu geschrieben")).not.toHaveAttribute("data-journal-since", /.*/);
  // Enter at its start adds an empty task above; the carried one keeps ↻.
  await caret("Übernommen", false);
  await page.keyboard.press("Enter");
  await expect(task("Übernommen")).toHaveAttribute("data-journal-since", "2026-09-01");
  await expect(editor.locator("li[data-journal-since]")).toHaveCount(1);
  expect(errors).toEqual([]);
});
