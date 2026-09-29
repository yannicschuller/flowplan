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
  // Nothing sits in the task line until a date is set.
  await expect(editor.locator(".task-due")).toHaveCount(0);
  // The toolbar offers a date while the cursor is in a task.
  const add = page.getByRole("button", { name: "Fälligkeit setzen" });
  await expect(add).toBeVisible();
  await add.click();
  const picker = page.locator(".task-due-picker");
  await picker.fill("2020-01-01");
  const chip = editor.locator(".task-due-overdue");
  await expect(chip).toBeVisible();
  // The chip is outside the text: typing goes on at the end of the task.
  await editor.getByText(taskText, { exact: true }).click();
  await page.keyboard.press("End");
  await page.keyboard.type("!");
  await expect(editor.locator("li p", { hasText: `${taskText}!` })).toHaveCount(1);
  await page.keyboard.press("Backspace");
  // Enter makes a new task without the date.
  await page.keyboard.press("Enter");
  await expect(editor.locator("li[data-checked]")).toHaveCount(2);
  await expect(editor.locator(".task-due")).toHaveCount(1);
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await expect(editor.locator("li[data-checked]")).toHaveCount(1);
  // The text menu changes the date too (right click on desktop).
  if (info.project.name === "desktop") {
    await editor.getByText(taskText, { exact: true }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Fälligkeit ändern" }).click();
    await expect(picker).toHaveValue("2020-01-01");
    await page.mouse.click(5, 500);
    await expect(picker).toHaveCount(0);
  }
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

test("tasks of other workspaces follow in their own section", async ({ page }, info) => {
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const name = `Privat ${info.project.name} ${Date.now()}`;
  const other = await command({ action: "workspace.create", name });
  const otherBoot = await (await page.request.get(`/api/bootstrap?workspace=${other.id}`)).json();
  const text = `Kartons kaufen ${Date.now()}`;
  await command({
    action: "page.import",
    workspaceId: other.id,
    spaceId: otherBoot.spaces[0].id,
    title: "Umzug",
    content: `<ul data-type="taskList"><li data-type="taskItem" data-checked="false" data-due="2020-01-01"><p>${text}</p></li></ul>`,
    format: "html",
  });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  test.skip(boot.workspace.id === other.id, "The new workspace became the current one.");
  await page.goto("/#tasks");
  const others = page.locator(".my-tasks-others");
  await expect(others.getByRole("heading", { name: "Aus anderen Arbeitsbereichen" })).toBeVisible();
  const group = others.getByRole("region", { name });
  await expect(group).toContainText(text);
  // Not among the tasks of the current workspace.
  await expect(page.locator(".my-tasks > .my-tasks-group", { hasText: text })).toHaveCount(0);
  // Opening it switches to that workspace.
  await group.locator("li", { hasText: text }).getByRole("button", { name: "Umzug" }).click();
  await expect(page.getByLabel("Dokumentinhalt", { exact: true })).toContainText(text);
});
