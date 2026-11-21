import { test, expect } from "@playwright/test";

// The placeholder picker of a rule's "Aufgabe erstellen" (#413): the {}
// button and typing "{{" open the workflow editor's picker with the
// database's properties and the built-ins; a pick goes in at the cursor as
// the rule fills it, in the task text and in the heading.
test("the placeholder picker fills a rule's task text and heading", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "The editor flow runs on the desktop.");
  test.setTimeout(120_000);
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
  const db = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Bestellungen ${stamp}`, kind: "database" });
  const first = await (await page.request.get(`/api/pages/${db.id}`)).json();
  await command({
    action: "database.update",
    pageId: db.id,
    version: first.database.version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "status", name: "Status", type: "select", options: ["Offen", "Erledigt"] },
      { id: "client", name: "Kunde (Firma)", type: "text" },
    ],
    views: first.database.views,
  });

  await page.goto(`/#page=${db.id}`);
  await page.getByRole("button", { name: "Weitere Werkzeuge" }).click();
  await page.getByRole("menuitem", { name: /Automationen/ }).click();
  const dialog = page.getByRole("dialog", { name: /^Automationen ·/ });
  await dialog.getByRole("button", { name: "Eigene Regel" }).click();
  await dialog.getByLabel("Name", { exact: true }).fill("Nachfassen");
  await dialog.getByLabel("Auslöser").selectOption("changed");
  await dialog.getByLabel("Eigenschaft des Auslösers").selectOption("status");
  await dialog.getByLabel("Aktion", { exact: true }).selectOption("task");
  await dialog.getByLabel("Person der Aufgabe").selectOption("");
  await dialog.getByLabel("Fällig in Tagen").fill("");

  // The {} button: properties and built-ins; search, Enter.
  const text = dialog.getByLabel("Aufgabe: Text", { exact: true });
  await text.fill("Bestellung ");
  const button = dialog.getByRole("button", { name: "Platzhalter einfügen in „Aufgabe: Text“" });
  await button.click();
  await expect(button).toHaveAttribute("aria-expanded", "true");
  const picker = page.getByRole("dialog", { name: "Platzhalter wählen" });
  const list = picker.getByRole("listbox", { name: "Platzhalter" });
  for (const name of [/^Name\s*\{\{Name\}\}/, /^Status/, /^Kunde \(Firma\)/, /^Titel des Eintrags/, /^Heutiges Datum/, /^Auslösende Person/, /^Name der Datenbank/])
    await expect(list.getByRole("option", { name })).toBeVisible();
  const search = picker.getByRole("combobox", { name: "Platzhalter suchen" });
  await expect(search).toBeFocused();
  await search.fill("kunde");
  await expect(list.getByRole("option")).toHaveCount(1);
  await search.press("Enter");
  await expect(picker).toBeHidden();
  await expect(text).toHaveValue("Bestellung {{Kunde (Firma)}}");
  await expect(text).toBeFocused();

  // Typing "{{" opens it; arrows and Enter put the pick in place of "{{".
  await text.press("End");
  await text.pressSequentially(" für {{");
  await expect(picker).toBeVisible();
  await search.press("ArrowDown");
  await expect(list.getByRole("option", { name: /^Status/ })).toHaveAttribute("aria-selected", "true");
  await search.press("Enter");
  await expect(text).toHaveValue("Bestellung {{Kunde (Firma)}} für {{Status}}");

  // Escape closes the picker, not the rules dialog.
  await button.click();
  await expect(picker).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(picker).toBeHidden();
  await expect(dialog).toBeVisible();
  await expect(text).toBeFocused();

  // The heading takes placeholders too.
  const heading = dialog.getByLabel("Unter der Überschrift", { exact: true });
  await heading.fill("Stand: ");
  await dialog.getByRole("button", { name: "Platzhalter einfügen in „Unter der Überschrift“" }).click();
  await list.getByRole("option", { name: /^Status/ }).click();
  await expect(heading).toHaveValue("Stand: {{Status}}");
  await dialog.getByRole("button", { name: "Regel speichern" }).click();
  await expect(dialog.getByText("Aufgabe „Bestellung {{Kunde (Firma)}} für {{Status}}“ im Eintrag")).toBeVisible();
  await page.keyboard.press("Escape");

  // The rule at work: both filled with the record's values.
  const row = await command({ action: "row.create", pageId: db.id, cells: { title: `Drucker ${stamp}`, status: "Offen", client: "Muster & Co" } });
  const version = (await (await page.request.get(`/api/pages/${db.id}`)).json()).rows.find((r: { id: string }) => r.id === row.id).version;
  await command({ action: "row.update", pageId: db.id, rowId: row.id, version, cells: { status: "Erledigt" } });
  await page.goto(`/#page=${db.id}&row=${row.id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor.getByRole("heading", { name: "Stand: Erledigt" })).toBeVisible();
  await expect(editor.locator("li[data-checked]", { hasText: "Bestellung Muster & Co für Erledigt" })).toBeVisible();
  expect(errors).toEqual([]);
});
