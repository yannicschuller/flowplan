import { test, expect, type Page } from "@playwright/test";

// "Aufgabe erstellen" (#380): a rule set up in the editor writes a task
// into the record's document (it shows in "Meine Aufgaben") and another
// one creates a record in a task database, linked to the record.
test("rules create tasks in the record and in a task database", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "The editor flow runs on the desktop.");
  test.setTimeout(150_000);
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
  const stamp = Date.now();
  const makeDatabase = async (title: string, fields: unknown[]) => {
    const db = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title, kind: "database" });
    const first = await (await page.request.get(`/api/pages/${db.id}`)).json();
    await command({ action: "database.update", pageId: db.id, version: first.database.version, fields, views: first.database.views });
    return db.id as string;
  };
  const tickets = await makeDatabase(`Tickets ${stamp}`, [
    { id: "title", name: "Name", type: "text" },
    { id: "status", name: "Status", type: "select", options: ["Offen", "In Arbeit", "Erledigt"] },
  ]);
  const todoTitle = `Aufgabenliste ${stamp}`;
  const todos = await makeDatabase(todoTitle, [
    { id: "title", name: "Titel", type: "text" },
    { id: "who", name: "Person", type: "person" },
    { id: "due", name: "Fällig", type: "date" },
    { id: "prio", name: "Priorität", type: "select", options: ["Niedrig", "Hoch"] },
    { id: "ticket", name: "Ticket", type: "relation", relationPage: tickets },
  ]);

  await page.goto(`/#page=${tickets}`);
  const dialog = page.getByRole("dialog");
  const openRules = async () => {
    await page.getByRole("button", { name: "Weitere Werkzeuge" }).click();
    await page.getByRole("menuitem", { name: /Automationen/ }).click();
  };
  await openRules();
  // (a) Status → Erledigt: a task in the record's document.
  await dialog.getByRole("button", { name: "Eigene Regel" }).click();
  await dialog.getByLabel("Name", { exact: true }).fill("Nachfassen");
  await dialog.getByLabel("Auslöser").selectOption("changed");
  await dialog.getByLabel("Eigenschaft des Auslösers").selectOption("status");
  await dialog.getByLabel("auf (leer: beliebig)").selectOption("Erledigt");
  await dialog.getByLabel("Aktion", { exact: true }).selectOption("task");
  await expect(dialog.getByLabel("Wohin kommt die Aufgabe?")).toHaveValue("document");
  // An empty text is refused before saving.
  const text = dialog.getByLabel("Aufgabe: Text");
  await text.fill("");
  await dialog.getByRole("button", { name: "Regel speichern" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Die Aufgabe braucht einen Text.");
  await text.fill("Rückmeldung zu {{Name}} einholen");
  await dialog.getByLabel("Person der Aufgabe").selectOption("@actor");
  await dialog.getByLabel("Fällig in Tagen").fill("2");
  await dialog.getByLabel("Unter der Überschrift").fill("Nächste Schritte");
  await shoot(page, info, "document");
  await dialog.getByRole("button", { name: "Regel speichern" }).click();
  await expect(dialog.getByText("Status → Erledigt → Aufgabe „Rückmeldung zu {{Name}} einholen“ im Eintrag · fällig +2 Tage")).toBeVisible();

  // (b) A new record: a record in the task database, linked back.
  await dialog.getByRole("button", { name: "Eigene Regel" }).click();
  await dialog.getByLabel("Name", { exact: true }).fill("Aufgabe anlegen");
  await dialog.getByLabel("Aktion", { exact: true }).selectOption("task");
  await dialog.getByLabel("Wohin kommt die Aufgabe?").selectOption("database");
  await dialog.getByRole("button", { name: "Regel speichern" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Wähle eine Datenbank für die Aufgabe.");
  await dialog.getByLabel("Aufgabe: Text").fill("Prüfen: {{Name}}");
  await dialog.getByLabel("Person der Aufgabe").selectOption("@actor");
  await dialog.getByLabel("Datenbank der Aufgabe").selectOption(todos);
  // The task database's properties: person, due date, the link back.
  await expect(dialog.getByLabel("Person kommt in")).toHaveValue("who");
  await expect(dialog.getByLabel("Fälligkeit kommt in")).toHaveValue("due");
  await expect(dialog.getByLabel("Verknüpfen über")).toHaveValue("ticket");
  await dialog.getByLabel("Priorität").selectOption("Hoch");
  await shoot(page, info, "database");
  await dialog.getByRole("button", { name: "Regel speichern" }).click();
  await expect(dialog.getByText(`Neuer Eintrag → Aufgabe „Prüfen: {{Name}}“ in „${todoTitle}“ · fällig +3 Tage`)).toBeVisible();
  await page.keyboard.press("Escape");

  // The rules at work.
  const row = await command({ action: "row.create", pageId: tickets, cells: { title: `Drucker ${stamp}`, status: "Offen" } });
  const read = async (pageId: string) => (await page.request.get(`/api/pages/${pageId}`)).json();
  const task = (await read(todos)).rows.find((r: { cells: Record<string, unknown> }) => r.cells.title === `Prüfen: Drucker ${stamp}`);
  expect(task, "the task record").toBeTruthy();
  expect(task.cells.prio).toBe("Hoch");
  expect(task.cells.who).toBe(boot.user.id);
  expect(task.cells.ticket).toEqual([row.id]);
  const version = (await read(tickets)).rows.find((r: { id: string }) => r.id === row.id).version;
  await command({ action: "row.update", pageId: tickets, rowId: row.id, version, cells: { status: "Erledigt" } });
  // In the record's document, below its heading …
  await page.goto(`/#page=${tickets}&row=${row.id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor.getByRole("heading", { name: "Nächste Schritte" })).toBeVisible();
  await expect(editor.locator("li[data-checked]", { hasText: `Rückmeldung zu Drucker ${stamp} einholen` })).toBeVisible();
  // … and in "Meine Aufgaben".
  await page.goto("/#tasks");
  await expect(page.locator(".my-tasks-group li", { hasText: `Rückmeldung zu Drucker ${stamp} einholen` })).toBeVisible();
  expect(errors).toEqual([]);
});

// Pictures of the editor for the review (only with AUTOMATION_SHOTS set):
// 1440 and 390 wide, light and dark.
async function shoot(page: Page, info: { project: { name: string } }, name: string) {
  const dir = process.env.AUTOMATION_SHOTS;
  if (!dir) return;
  const size = page.viewportSize()!;
  for (const width of [1440, 390])
    for (const scheme of ["light", "dark"] as const) {
      await page.setViewportSize({ width, height: width > 800 ? 1000 : 844 });
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(300);
      // The new action's fields whole, and the dialog as it is seen.
      await page.locator(".automation-task").last().screenshot({ path: `${dir}/auto380-${name}-${width}-${scheme}.png` });
      await page.screenshot({ path: `${dir}/auto380-${name}-${width}-${scheme}-dialog.png` });
    }
  await page.setViewportSize(size);
  await page.emulateMedia({ colorScheme: "light" });
  void info;
}
