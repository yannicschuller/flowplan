import { test, expect } from "@playwright/test";

test("a task gets a due date in the editor and is ticked off in Meine Aufgaben", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && console.log("console error:", m.text().slice(0, 300)));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const title = `Aufgaben ${info.project.name} ${Date.now()}`;
  const response = await page.request.post("/api/command", {
    headers: { origin },
    data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title, kind: "document" },
  });
  const pageId = (await response.json()).id;
  await page.goto(`/#page=${pageId}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await editor.click();
  const taskText = `Rechnung prüfen ${info.project.name} ${Date.now()}`;
  await page.keyboard.type(`[] ${taskText}`);
  // The task under the cursor offers a date.
  const add = editor.getByRole("button", { name: "Fälligkeit setzen" });
  await expect(add).toBeVisible();
  await add.click();
  const picker = page.locator(".task-due-picker");
  await picker.fill("2020-01-01");
  const chip = editor.locator(".task-due-overdue");
  await expect(chip).toBeVisible();
  // Wait until the document with the task is stored.
  await expect
    .poll(
      async () =>
        JSON.stringify(await (await page.request.get(`/api/tasks?workspace=${boot.workspace.id}`)).json()),
      { timeout: 15_000 },
    )
    .toContain(taskText);

  await page.goto("/#tasks");
  const item = page.locator(".my-tasks-group li", { hasText: taskText });
  await expect(page.locator(".my-tasks-group.overdue")).toContainText(taskText);
  await expect(item.locator(".my-task-page")).toContainText(title);
  // Ticked off, it leaves the list of open tasks.
  await item.getByRole("checkbox").click();
  await expect(page.locator(".my-tasks-group li", { hasText: taskText })).toHaveCount(0);
  await page.getByLabel("Erledigte zeigen").check();
  await expect(page.locator(".my-tasks-group li.checked", { hasText: taskText })).toBeVisible();
  // The due date can be removed again; an own task without a date then
  // leaves the list (only tasks given to you stay without one).
  const done = page.locator(".my-tasks-group li.checked", { hasText: taskText });
  await done.getByRole("button", { name: /Fälligkeit von .* entfernen/ }).click();
  await expect(done).toHaveCount(0);
  await page.goto(`/#page=${pageId}`);
  const task = page.getByLabel("Dokumentinhalt", { exact: true }).locator('li[data-checked="true"]', { hasText: taskText });
  await expect(task).toBeVisible();
  await expect(task.locator(".task-due")).toHaveCount(0);
  expect(errors).toEqual([]);
});
