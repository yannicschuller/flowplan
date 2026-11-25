import { test, expect } from "@playwright/test";
import { chooseSource, withTaskFilters } from "./my-tasks-filters";

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
  // One Backspace removes the empty task; the text before stays whole.
  await page.keyboard.press("Backspace");
  await expect(editor.locator("li[data-checked]")).toHaveCount(1);
  await expect(editor.getByText(taskText, { exact: true })).toBeVisible();
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
  await withTaskFilters(page, (filters) => filters.getByLabel("Erledigte zeigen").check());
  await expect(page.locator(".my-tasks-group li.checked", { hasText: taskText })).toBeVisible();
  // The due date can be removed again; an own task without a date then
  // leaves the list (only tasks given to you stay without one).
  const done = page.locator(".my-tasks-group li.checked", { hasText: taskText });
  await done.getByRole("button", { name: /Fälligkeit von .* entfernen/ }).click();
  await expect(done).toHaveCount(0);
  await page.goto(`/#page=${pageId}`);
  const task = page.getByLabel("Dokumentinhalt", { exact: true }).locator('li[data-checked="true"]', { hasText: taskText });
  // The page opened before shows its copy from then first; the server's
  // state (ticked off in Meine Aufgaben) follows with the next sync.
  await expect(task).toBeVisible({ timeout: 15_000 });
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

test("Aufgabe hinzufügen: Enter writes into the own page, the filter narrows to it (#208)", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  // Past the introduction, which would take the focus.
  await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.onboarded" } });
  await page.goto("/#tasks");
  const field = page.getByRole("textbox", { name: "Aufgabe hinzufügen" });
  await expect(field).toBeVisible();
  const text = `Zahnarzt anrufen ${info.project.name} ${Date.now()}`;
  await field.fill(`${text} morgen`);
  await field.press("Enter");
  // Added with tomorrow as its date, the shorthand gone from the text.
  const item = page.locator(".my-tasks-group li", { hasText: text });
  await expect(item).toBeVisible();
  await expect(item.locator(".my-task-text")).toHaveText(text);
  await expect(field).toHaveValue("");
  // Person "Eigene" keeps it, Quelle "Datenbanken" does not (#314); the
  // choices stay on this device.
  await withTaskFilters(page, (filters) => filters.locator(".my-tasks-person label", { hasText: "Eigene" }).click());
  await expect(item).toBeVisible();
  // On phones "Filter (1)": one filter of the sheet differs from the default.
  if (info.project.name === "mobile") await expect(page.getByRole("button", { name: "Filter, 1 gesetzt" })).toHaveText("Filter (1)");
  await chooseSource(page, "Datenbanken");
  await expect(item).toHaveCount(0);
  await expect(page.locator(".my-tasks .empty-state")).toBeVisible();
  await chooseSource(page, "Dokumente");
  await expect(item).toBeVisible();
  // The tools for records are gone while only documents are shown.
  await expect(page.getByRole("group", { name: "Nur für Einträge aus Datenbanken" })).toHaveCount(0);
  // "Heute" hides a task due tomorrow, "Nächste 7 Tage" shows it.
  await page.getByRole("button", { name: /^Fälligkeit: / }).click();
  await page.getByRole("dialog", { name: "Fälligkeit" }).getByRole("radio", { name: /^Heute/ }).click();
  await expect(item).toHaveCount(0);
  await page.getByRole("button", { name: "Fälligkeit: Heute" }).click();
  await page.getByRole("dialog", { name: "Fälligkeit" }).getByRole("radio", { name: /^Nächste 7 Tage/ }).click();
  await expect(item).toBeVisible();
  await page.reload();
  await withTaskFilters(page, (filters) => expect(filters.locator('.my-tasks-person label[data-active="true"]')).toHaveText("Eigene"));
  if (info.project.name === "mobile") await expect(page.locator(".my-tasks-bar").getByLabel("Quelle", { exact: true })).toHaveValue("documents");
  else await expect(page.locator('.my-tasks-source label[data-active="true"]')).toHaveText("Dokumente");
  await expect(page.getByRole("button", { name: "Fälligkeit: Nächste 7 Tage" })).toBeVisible();
  await expect(page.locator(".my-tasks-group li", { hasText: text })).toBeVisible();
  // The page is a normal page: it opens from My tasks (on phones from the
  // sheet "Filter").
  if (info.project.name === "mobile") await page.getByRole("button", { name: "Filter, 1 gesetzt" }).click();
  await page.getByRole("button", { name: "Seite „Aufgaben“ öffnen" }).click();
  await expect(page.getByLabel("Dokumentinhalt", { exact: true })).toContainText(text);
  await page.goto("/#tasks");
  await withTaskFilters(page, (filters) => filters.locator(".my-tasks-person label", { hasText: "Mir zugewiesen" }).click());
  await chooseSource(page, "Alle");
  expect(errors).toEqual([]);
});
