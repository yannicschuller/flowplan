import { test, expect, type Page } from "@playwright/test";

// "Aufgaben in Datenbank verschieben" (#420): the tasks of a document
// become records of a task database – status, due date and person mapped –
// each task is replaced by a link to its record; "Rückgängig" brings the
// tasks back and removes the records.
async function fixture(page: Page, suffix: string) {
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  await command({ action: "profile.onboarded" });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const base = { workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id };
  const host = await command({ ...base, action: "page.create", title: `Aufgabenliste ${suffix}`, kind: "document" });
  const database = await command({ ...base, action: "page.create", title: `Aufgaben ${suffix}`, kind: "database", databaseKind: "tasks" });
  const read = async (pid: string) => (await page.request.get(`/api/pages/${pid}`)).json();
  const { htmlState } = await import("../../lib/document-server");
  const me = boot.user as { id: string; name: string };
  const html =
    "<p>Davor.</p>" +
    '<ul data-type="taskList">' +
    `<li data-type="taskItem" data-checked="false" data-due="2026-12-24"><p>Angebot schreiben <span data-mention="${me.id}" class="mention">@${me.name}</span></p></li>` +
    '<li data-type="taskItem" data-checked="true"><p>Rechnung prüfen</p></li>' +
    '<li data-type="taskItem" data-checked="false"><p>Raum buchen</p></li>' +
    "</ul><p>Danach.</p>";
  await command({ action: "document.sync", pageId: host.id, generation: (await read(host.id)).generation, update: Buffer.from(htmlState(html)).toString("base64") });
  return { host, database, read, me, title: `Aufgaben ${suffix}` };
}

test("a document's tasks move into a task database as linked records; undo brings them back", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const f = await fixture(page, `${info.project.name} ${Date.now()}`);
  await page.goto(`/#page=${f.host.id}`);
  const skip = page.getByRole("button", { name: "Überspringen" });
  if (await skip.isVisible().catch(() => false)) await skip.click();
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor.locator('li[data-checked]')).toHaveCount(3);

  await page.getByRole("button", { name: "Seitenaktionen" }).click();
  await page.getByRole("menuitem", { name: "Aufgaben in Datenbank verschieben …" }).click();
  const dialog = page.getByRole("dialog", { name: "Aufgaben in Datenbank verschieben" });
  await expect(dialog).toBeVisible();
  await dialog.locator(".transfer-target", { hasText: f.title }).click();
  // Preset from the task database: its status, due date and person.
  await expect(dialog.getByLabel("Erledigt kommt in")).toHaveValue("status");
  await expect(dialog.getByLabel("Option für erledigte Aufgaben")).toHaveValue("Erledigt");
  await expect(dialog.getByLabel("Option für offene Aufgaben")).toHaveValue("Nicht begonnen");
  await expect(dialog.getByLabel("Fälligkeit kommt in")).toHaveValue("date");
  await expect(dialog.getByLabel("Person kommt in")).toHaveValue("assignee");
  await expect(dialog.getByRole("radio", { name: "Durch Links auf die Einträge ersetzen" })).toBeChecked();
  await expect(dialog.getByRole("status")).toHaveText(`3 Aufgaben (1 erledigt) → „${f.title}“`);
  await dialog.getByRole("button", { name: "Verschieben", exact: true }).click();
  await expect(dialog).toHaveCount(0);

  // The records, with status, due date and person.
  const toast = page.locator(".toast").filter({ hasText: `3 Aufgaben nach „${f.title}“ verschoben` });
  await expect(toast).toBeVisible();
  const data = await f.read(f.database.id);
  const rows = (data.rows as { id: string; cells: Record<string, unknown> }[]).map((r) => ({ ...r.cells, id: r.id }) as Record<string, unknown> & { id: string });
  expect(rows.map((r) => [r.title, r.status, r.date ?? null, r.assignee ?? null])).toEqual([
    ["Angebot schreiben", "Nicht begonnen", "2026-12-24", f.me.id],
    ["Rechnung prüfen", "Erledigt", null, null],
    ["Raum buchen", "Nicht begonnen", null, null],
  ]);
  // The document links each task to its record (live in the open editor).
  await expect(editor.locator('li[data-checked]')).toHaveCount(0);
  const links = editor.locator('a[href*="&row="]');
  await expect(links).toHaveText(["Angebot schreiben", "Rechnung prüfen", "Raum buchen"]);
  for (const [i, row] of rows.entries()) await expect(links.nth(i)).toHaveAttribute("href", new RegExp(`#page=${f.database.id}&row=${row.id}$`));
  await expect(editor.locator("p", { hasText: "Davor." })).toBeVisible();
  await expect(editor.locator("p", { hasText: "Danach." })).toBeVisible();

  // Undo: the tasks are back, the records gone.
  await toast.getByRole("button", { name: "Rückgängig" }).click();
  await expect(editor.locator('li[data-checked]')).toHaveCount(3);
  await expect(editor.locator('li[data-checked="true"]')).toContainText("Rechnung prüfen");
  await expect(editor.locator('li[data-checked="true"]')).toHaveCount(1);
  await expect(links).toHaveCount(0);
  await expect.poll(async () => ((await f.read(f.database.id)).rows as unknown[]).length, { timeout: 10000 }).toBe(0);
  await expect.poll(async () => (await f.read(f.host.id)).html as string, { timeout: 10000 }).toContain('data-due="2026-12-24"');
  expect(errors).toEqual([]);
});
