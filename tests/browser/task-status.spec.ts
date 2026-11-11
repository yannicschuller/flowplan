import { test, expect } from "@playwright/test";

// The five states of a task (#201): Ctrl/Cmd+L and the menu on the box.
test("Ctrl/Cmd+L makes a task and cycles its state; right click opens the states", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "keyboard and right click: desktop");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const item = (text: string, attrs: string, checked = false) => `<li data-type="taskItem" data-checked="${checked}"${attrs}><p>${text}</p></li>`;
  const html =
    '<ul data-type="taskList">' +
    item("Offen", "") +
    item("Läuft", ' data-status="progress"') +
    item("Fertig", "", true) +
    item("Abgesagt", ' data-status="cancelled"', true) +
    item("Später", ' data-status="deferred"') +
    item("Frage", ' data-symbol="?"') +
    "</ul><p>Einkaufen</p>";
  const p = await (
    await page.request.post("/api/command", {
      headers: { origin },
      data: { action: "page.import", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Status ${Date.now()}`, content: html, format: "html" },
    })
  ).json();
  await page.goto(`/#page=${p.id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor).toContainText("Einkaufen");
  const task = (text: string) =>
    editor.locator("li[data-checked]", { has: page.locator(":scope > div > p", { hasText: new RegExp(`^${text}$`) }) });

  // Each state shows on the item and in the box's name.
  await expect(task("Läuft")).toHaveAttribute("data-status", "progress");
  await expect(task("Abgesagt")).toHaveAttribute("data-status", "cancelled");
  await expect(task("Später")).toHaveAttribute("data-status", "deferred");
  await expect(task("Frage")).toHaveAttribute("data-symbol", "?");
  await expect(task("Läuft").locator("> label input")).toHaveAttribute("aria-label", "In Arbeit: Läuft");
  await expect(task("Abgesagt").locator("> label input")).toHaveAttribute("aria-label", "Abgebrochen: Abgesagt");

  // Ctrl/Cmd+L on a task: open → in progress → done → open.
  await editor.locator('p:text-is("Offen")').click();
  await page.keyboard.press("ControlOrMeta+l");
  await expect(task("Offen")).toHaveAttribute("data-status", "progress");
  await page.keyboard.press("ControlOrMeta+l");
  await expect(task("Offen")).toHaveAttribute("data-checked", "true");
  await expect(task("Offen")).not.toHaveAttribute("data-status", /.*/);
  await page.keyboard.press("ControlOrMeta+l");
  await expect(task("Offen")).toHaveAttribute("data-checked", "false");
  // The page stays (the browser's address bar did not take the key).
  await expect(editor).toBeFocused();

  // On a plain line: a task.
  await editor.locator('p:text-is("Einkaufen")').click();
  await page.keyboard.press("ControlOrMeta+l");
  await expect(task("Einkaufen")).toHaveAttribute("data-checked", "false");

  // A click on a box in progress: done.
  await task("Läuft").locator("> label input").click();
  await expect(task("Läuft")).toHaveAttribute("data-checked", "true");
  await expect(task("Läuft")).not.toHaveAttribute("data-status", /.*/);

  // Right click: the menu with the five states.
  await task("Später").locator("> label").click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Status der Aufgabe" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitemradio")).toHaveCount(5);
  await expect(menu.getByRole("menuitemradio", { name: /Verschoben/ })).toHaveAttribute("aria-checked", "true");
  await menu.getByRole("menuitemradio", { name: /Abgebrochen/ }).click();
  await expect(menu).toBeHidden();
  await expect(task("Später")).toHaveAttribute("data-status", "cancelled");
  await expect(task("Später")).toHaveAttribute("data-checked", "true");
  expect(errors).toEqual([]);
});
