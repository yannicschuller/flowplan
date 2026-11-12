import { test, expect } from "@playwright/test";

// Issue #233: a bullet or numbered list below a task item lays out like any
// list – the item's text first, its sub-list below it, not side by side.
// Only the task items themselves are rows of checkbox and content.
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";

test("a bullet list with a sub-list below a task stays stacked (#233)", async ({ page }, testInfo) => {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const { id } = await (
    await page.request.post("/api/command", {
      headers: { origin },
      data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Aufgaben ${Date.now()}`, kind: "document" },
    })
  ).json();
  await page.goto(`/#page=${id}`);
  const welcome = page.getByRole("dialog", { name: "Willkommen bei Flowplan" });
  await welcome.waitFor({ timeout: 3000 }).then(() => page.keyboard.press("Escape"), () => {});
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await editor.click();
  const html =
    `<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>Angebot vorbereiten</p>` +
    `<ul><li><p>Preise klären</p><ul><li><p>Rabatt</p></li><li><p>Laufzeit</p></li></ul></li></ul>` +
    `<ol><li><p>Entwurf</p><ol><li><p>Gliederung</p></li></ol></li></ol>` +
    `</li></ul><p></p>`;
  await page.evaluate((content) => {
    const dom = document.querySelector(".page-layout .ProseMirror") as HTMLElement & { editor: { commands: { insertContent: (html: string) => boolean } } };
    dom.editor.commands.insertContent(content);
  }, html);
  const task = editor.locator('ul[data-type="taskList"] > li').first();
  await expect(task).toContainText("Rabatt");
  // The task item is still a row: checkbox, then its content.
  expect(await task.evaluate((li) => getComputedStyle(li).display)).toBe("flex");
  for (const [text, child] of [
    ["Preise klären", "Rabatt"],
    ["Entwurf", "Gliederung"],
  ]) {
    const item = editor.locator("li", { has: page.locator(`p:text-is("${text}")`) }).last();
    expect(await item.evaluate((li) => getComputedStyle(li).display), text).not.toBe("flex");
    const own = (await item.locator(`> p`).boundingBox())!;
    const sub = (await item.getByText(child, { exact: true }).boundingBox())!;
    // The sub-list starts below the item's text, indented, not beside it.
    expect(sub.y, `${child} below ${text}`).toBeGreaterThanOrEqual(own.y + own.height - 1);
    expect(sub.x).toBeLessThan(own.x + own.width);
  }
  await editor.locator('ul[data-type="taskList"]').first().screenshot({ path: `test-results/task-nested-lists-${testInfo.project.name}.png` });
});
