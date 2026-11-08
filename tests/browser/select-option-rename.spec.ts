import { test, expect } from "@playwright/test";

// Renaming an option in the property editor carries the records (and the
// view's filter) to the new name; writing an existing name merges. Both are
// confirmed first; "Nur Optionen speichern" saves the list alone and the
// records keep the old name.
test("renaming a select option keeps its records and filters", async ({ page }, info) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.onboarded" } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const read = async (id: string) => (await page.request.get(`/api/pages/${id}`)).json();
  const db = await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    title: `Aufnahmen ${info.project.name} ${Date.now()}`,
    kind: "database",
  });
  await command({
    action: "database.update",
    pageId: db.id,
    version: (await read(db.id)).database.version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "status", name: "Status", type: "select", options: ["Offen", "In Arbeit", "Erledigt"] },
      { id: "labels", name: "Labels", type: "multiselect", options: ["Rot", "Blau"] },
    ],
    views: [
      {
        id: "table",
        name: "Tabelle",
        type: "table",
        filters: [{ field: "status", op: "any_of", value: "", values: ["In Arbeit", "Erledigt"] }],
        sorts: [],
      },
    ],
  });
  await command({ action: "database.settings", pageId: db.id, settings: { workflow: { field: "status", transitions: {}, required: {}, ownersOnly: ["Offen"] } } });
  const working = await command({ action: "row.create", pageId: db.id, cells: { title: "Erstgespräch", status: "In Arbeit", labels: ["Rot", "Blau"] } });
  const open = await command({ action: "row.create", pageId: db.id, cells: { title: "Rückruf", status: "Offen", labels: ["Blau"] } });
  await page.goto(`/#page=${db.id}`);
  const table = page.locator(".data-table");
  await expect(table.getByText("Erstgespräch")).toBeVisible();
  await expect(table.getByText("Rückruf")).toHaveCount(0);
  const edit = async (name: string) => {
    await table
      .locator("thead")
      .getByRole("button", { name: new RegExp(`^\\W*${name}$`) })
      .click();
    return page.getByRole("dialog", { name: "Eigenschaft bearbeiten" });
  };
  const confirm = page.getByRole("group", { name: "Vorhandene Einträge anpassen?" });
  const cells = async (rowId: string) => ((await read(db.id)).rows as { id: string; cells: Record<string, unknown> }[]).find((r) => r.id === rowId)?.cells;

  // A rename in place: "In Arbeit" → "In Bearbeitung".
  let dialog = await edit("Status");
  await dialog.getByLabel("Optionen, durch Komma getrennt").fill("Offen, In Bearbeitung, Erledigt");
  await dialog.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(confirm.getByRole("listitem")).toHaveText(["„In Arbeit“ in „In Bearbeitung“ umbenennen (1 Eintrag)."]);
  await confirm.getByRole("button", { name: "Einträge anpassen" }).click();
  await expect(confirm).toBeHidden();
  await expect(dialog).toBeHidden();
  await expect.poll(async () => (await cells(working.id))?.status).toBe("In Bearbeitung");
  const after = await read(db.id);
  expect(after.database.fields[1].options).toEqual(["Offen", "In Bearbeitung", "Erledigt"]);
  expect(after.database.views[0].filters[0].values).toEqual(["In Bearbeitung", "Erledigt"]);
  // The record still passes the view's filter and shows the new name.
  await expect(table.getByText("Erstgespräch")).toBeVisible();
  await expect(table.getByText("In Bearbeitung")).toBeVisible();

  // Multi-select: "Rot" → "Dringend"; the other values stay.
  dialog = await edit("Labels");
  await dialog.getByLabel("Optionen, durch Komma getrennt").fill("Dringend, Blau");
  await dialog.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(confirm.getByRole("listitem")).toHaveText(["„Rot“ in „Dringend“ umbenennen (1 Eintrag)."]);
  await confirm.getByRole("button", { name: "Einträge anpassen" }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(async () => (await cells(working.id))?.labels).toEqual(["Dringend", "Blau"]);
  expect((await cells(open.id))?.labels).toEqual(["Blau"]);

  // An existing name merges: "Offen" written as "Erledigt".
  dialog = await edit("Status");
  await dialog.getByLabel("Optionen, durch Komma getrennt").fill("Erledigt, In Bearbeitung, Erledigt");
  await dialog.getByRole("button", { name: "Speichern", exact: true }).click();
  // "Offen" is owners-only in the workflow: the merge drops that.
  await expect(confirm.getByRole("listitem")).toHaveText([
    "„Offen“ mit „Erledigt“ zusammenführen (1 Eintrag). „Offen“ verliert seine eigenen Einstellungen unter „Statusregeln und Erledigt“.",
  ]);
  await confirm.getByRole("button", { name: "Einträge anpassen" }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(async () => (await cells(open.id))?.status).toBe("Erledigt");
  expect((await read(db.id)).database.fields[1].options).toEqual(["Erledigt", "In Bearbeitung"]);
  await expect(table.getByText("Rückruf")).toBeVisible();

  // Declined: "Blau" → "Grün" saves the options only; both records keep "Blau".
  dialog = await edit("Labels");
  await dialog.getByLabel("Optionen, durch Komma getrennt").fill("Dringend, Grün");
  await dialog.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(confirm.getByRole("listitem")).toHaveText(["„Blau“ in „Grün“ umbenennen (2 Einträge)."]);
  // Cancel goes back to the property with the draft; nothing is saved.
  await confirm.getByRole("button", { name: "Abbrechen" }).click();
  await expect(confirm).toBeHidden();
  await expect(dialog.getByLabel("Optionen, durch Komma getrennt")).toHaveValue("Dringend, Grün");
  expect((await read(db.id)).database.fields[2].options).toEqual(["Dringend", "Blau"]);
  await dialog.getByRole("button", { name: "Speichern", exact: true }).click();
  await confirm.getByRole("button", { name: "Nur Optionen speichern" }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(async () => (await read(db.id)).database.fields[2].options).toEqual(["Dringend", "Grün"]);
  expect((await cells(working.id))?.labels).toEqual(["Dringend", "Blau"]);
  expect((await cells(open.id))?.labels).toEqual(["Blau"]);
  expect((await read(db.id)).database.fields[1].options).toEqual(["Erledigt", "In Bearbeitung"]);
  expect(errors).toEqual([]);
});
