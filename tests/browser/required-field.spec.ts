import { test, expect, type Page } from "@playwright/test";

// Required properties (#443): the switch in a property's settings counts
// the records still empty, those are marked in the table, a required
// select's cell offers no way to empty it, clearing a text is refused and
// shows the value again, and a board grouped by a required status has no
// empty column once every record has a value.
async function setup(page: Page, title: string) {
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const db = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title, kind: "database" });
  const read = async () => (await page.request.get(`/api/pages/${db.id}`)).json();
  return { db, command, read };
}
async function open(page: Page, id: string) {
  await page.goto(`/#page=${id}`);
  const skip = page.getByRole("dialog").getByRole("button", { name: "Überspringen" });
  if (await skip.waitFor({ timeout: 5000 }).then(() => true, () => false)) await skip.click();
}

test("required property: settings, missing marks, no empty choice, refused clearing", async ({ page }, info) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { db, command, read } = await setup(page, `Pflicht ${info.project.name} ${Date.now()}`);
  const fields = [
    { id: "title", name: "Name", type: "text" },
    { id: "status", name: "Status", type: "select", options: ["Offen", "Erledigt"] },
    { id: "note", name: "Notiz", type: "text" },
  ];
  await command({
    action: "database.update",
    pageId: db.id,
    version: (await read()).database.version,
    fields,
    views: [{ id: "table", name: "Tabelle", type: "table", filters: [], sorts: [] }],
  });
  const old = await command({ action: "row.create", pageId: db.id, cells: { title: "Alt" } });
  const full = await command({ action: "row.create", pageId: db.id, cells: { title: "Voll", status: "Offen", note: "Text" } });

  await open(page, db.id);
  const table = page.locator(".data-table");
  await expect(table).toBeVisible();

  // The switch: on, the settings say how many records have no value yet.
  await table.locator("thead").getByRole("button", { name: /^\W*Status$/ }).click();
  const dialog = page.getByRole("dialog", { name: "Eigenschaft bearbeiten" });
  const toggle = dialog.getByRole("switch", { name: "Darf nicht leer sein" });
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await expect(dialog.getByText("1 Eintrag hat noch keinen Wert.")).toBeVisible();
  await expect(dialog.getByText("Neue Einträge ohne eigenen Wert bekommen die erste Option", { exact: false })).toBeVisible();
  await toggle.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath(`setting-${info.project.name}.png`) });
  await dialog.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(async () => (await read()).database.fields[1].required).toBe(true);
  // The text property too (through the API: the same switch).
  const now = await read();
  await command({ action: "database.update", pageId: db.id, version: now.database.version, views: now.database.views, fields: now.database.fields.map((f: { id: string }) => (f.id === "note" ? { ...f, required: true } : f)) });

  // The old record: marked as missing – the status and, once the table has
  // the change made through the API, the note too –, nothing changed. The
  // open page is fetched again at most every 5 s on the live signal
  // (PAGE_GAP_MS, components/use-workspace-signals.ts), and the dialog's
  // save has just used that turn.
  const oldRow = page.locator(`tr[data-row-id="${old.id}"]`);
  await expect(oldRow.locator(".required-missing")).toHaveCount(2, { timeout: 15_000 });
  await expect(oldRow.getByText("Wert fehlt (Pflichtfeld)").first()).toBeAttached();
  expect((await read()).rows.find((r: { id: string }) => r.id === old.id).cells.status).toBeUndefined();

  // A new record gets the first option.
  const fresh = await command({ action: "row.create", pageId: db.id, cells: { title: "Neu" } });
  expect((await read()).rows.find((r: { id: string }) => r.id === fresh.id).cells.status).toBe("Offen");

  // The select of a record with a value: no ✕ to empty it.
  const fullRow = page.locator(`tr[data-row-id="${full.id}"]`);
  await fullRow.locator("td").nth(2).click();
  await expect(page.getByRole("combobox", { name: /^Status: Option/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "„Offen“ entfernen" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  // Clearing the text: refused, the value shows again.
  await fullRow.locator("td").nth(3).click();
  const note = fullRow.getByRole("textbox", { name: "Notiz" });
  await expect(note).toBeVisible();
  await note.press("ControlOrMeta+a");
  await note.press("Delete");
  await note.press("Enter");
  await expect(fullRow.getByRole("alert")).toHaveText("„Notiz“ ist ein Pflichtfeld und kann nicht leer sein.");
  await expect(fullRow.getByRole("textbox", { name: "Notiz" })).toHaveText("Text");
  await page.screenshot({ path: info.outputPath(`refused-${info.project.name}.png`) });
  expect((await read()).rows.find((r: { id: string }) => r.id === full.id).cells.note).toBe("Text");
  expect(errors).toEqual([]);
});

test("board grouped by a required status: no empty column once every record has one", async ({ page }, info) => {
  test.setTimeout(90_000);
  const { db, command, read } = await setup(page, `Pflicht-Board ${info.project.name} ${Date.now()}`);
  const status = { id: "status", name: "Status", type: "select", options: ["Offen", "Erledigt"] };
  const views = [{ id: "board", name: "Board", type: "board", filters: [], sorts: [], groupBy: "status" }];
  await command({ action: "database.update", pageId: db.id, version: (await read()).database.version, fields: [{ id: "title", name: "Name", type: "text" }, status], views });
  const old = await command({ action: "row.create", pageId: db.id, cells: { title: "Alt" } });
  await command({ action: "database.update", pageId: db.id, version: (await read()).database.version, fields: [{ id: "title", name: "Name", type: "text" }, { ...status, required: true }], views });
  await command({ action: "row.create", pageId: db.id, cells: { title: "Neu" } });

  await open(page, db.id);
  const empty = page.locator('.board-column[data-group-key="empty"]');
  // The old record still needs a value: its column says so.
  await expect(empty).toBeVisible();
  await expect(empty.getByText("Wert fehlt (Pflichtfeld)")).toBeVisible();
  await page.screenshot({ path: info.outputPath(`board-missing-${info.project.name}.png`) });
  const current = (await read()).rows.find((r: { id: string }) => r.id === old.id);
  await command({ action: "row.update", pageId: db.id, rowId: old.id, version: current.version, cells: { status: "Erledigt" } });
  await page.reload();
  await expect(page.locator('.board-column[data-group-key="\\"Erledigt\\""]')).toBeVisible();
  await expect(empty).toHaveCount(0);
});
