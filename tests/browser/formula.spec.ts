import {
  test,
  expect,
  type Page,
  type APIRequestContext,
} from "@playwright/test";

const pendingAreas = new Map<string, { id: string; name: string }>();
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
async function removeArea(
  request: APIRequestContext,
  area: { id: string; name: string },
) {
  const boot = await (await request.get("/api/bootstrap")).json();
  const space = [...boot.managedSpaces, ...(boot.trashedSpaces || [])].find(
    (s: any) => s.id === area.id,
  );
  if (!space) return;
  expect(space.name).toBe(area.name);
  let version = space.version;
  for (const action of space.deleted_at
    ? ["space.purge"]
    : ["space.delete", "space.purge"]) {
    const r = await request.post("/api/command", {
      headers: { origin },
      data: { action, spaceId: area.id, version, confirmName: area.name },
    });
    expect(r.ok(), await r.text()).toBe(true);
    version++;
  }
}
test.afterEach(async ({ request }, info) => {
  const area = pendingAreas.get(info.testId);
  if (!area) return;
  await request.post("/api/auth/demo", { headers: { origin } });
  await removeArea(request, area);
  pendingAreas.delete(info.testId);
});
async function fixture(page: Page, kind: string) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const r = await page.request.post("/api/command", {
      headers: { origin },
      data,
    });
    expect(r.ok(), await r.text()).toBe(true);
    return r.json();
  };
  const name = `Formula ${kind} ${test.info().project.name} ${Date.now()}`;
  const area = await command({
    action: "space.create",
    workspaceId: boot.workspace.id,
    name,
    private: true,
  });
  pendingAreas.set(test.info().testId, { id: area.id, name });
  const source = await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: area.id,
    title: name,
    kind: "database",
  });
  const read = async () =>
    (await page.request.get(`/api/pages/${source.id}`)).json();
  await command({
    action: "database.update",
    pageId: source.id,
    version: 1,
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "n", name: "Aufwand", type: "number" },
      { id: "rate", name: "Satz", type: "number" },
      { id: "status", name: "Status", type: "text" },
      { id: "date", name: "Termin", type: "date" },
      {
        id: "legacy",
        name: "Doppelt",
        type: "formula",
        formula: 'prop("Aufwand") * 2',
      },
    ],
    views: [
      { id: "table", name: "Tabelle", type: "table", filters: [], sorts: [] },
    ],
  });
  const alpha = await command({
    action: "row.create",
    pageId: source.id,
    cells: {
      title: "Alpha",
      n: 4,
      rate: 25,
      status: "offen",
      date: "2026-09-23",
    },
  });
  const beta = await command({
    action: "row.create",
    pageId: source.id,
    cells: {
      title: "Beta",
      n: 2,
      rate: 30,
      status: "#TODO",
      date: "2026-03-28",
    },
  });
  await page.goto(`/#page=${source.id}`);
  await expect(page.locator(`tr[data-row-id="${alpha.id}"]`)).toBeVisible();
  const open = async (id: string) => {
    await page.locator(`th[data-field-id="${id}"] > button`).first().click();
    return page.getByRole("dialog", {
      name: "Eigenschaft bearbeiten",
      exact: true,
    });
  };
  return { command, read, source, alpha, beta, open, errors };
}

test("formula suggestions, preview, stable property names and filtered summaries persist", async ({
  page,
}, info) => {
  const f = await fixture(page, "editor");
  await page
    .getByRole("button", { name: "Eigenschaft hinzufügen", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Eigenschaft hinzufügen",
    exact: true,
  });
  await dialog.getByLabel("Eigenschaftsname").fill("Kosten");
  await dialog.getByLabel("Eigenschaftstyp").selectOption("formula");
  const input = dialog.getByLabel("Formel", { exact: true });
  await input.fill("rou");
  await expect(
    dialog.getByRole("listbox", { name: "Formelvorschläge" }),
  ).toContainText("round");
  await input.press("Enter");
  await expect(input).toHaveValue("round()");
  await dialog
    .getByLabel("Funktionen und Eigenschaften suchen")
    .fill("Aufwand");
  await dialog
    .getByRole("button", { name: "Eigenschaft Aufwand einfügen", exact: true })
    .click();
  await expect(input).toHaveValue('round(prop("Aufwand"))');
  await input.fill('round(prop("Aufwand") * prop("Satz"), 2)');
  await expect(dialog.getByLabel("Formelergebnis")).toHaveText("100");
  await dialog.getByLabel("Vorschaueintrag").selectOption(f.beta.id);
  await expect(dialog.getByLabel("Formelergebnis")).toHaveText("60");
  await input.press("Tab");
  await page.screenshot({
    path: `test-results/formula-verification/editor-${info.project.name}.png`,
  });
  expect(
    await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
  ).toBe(true);
  await dialog.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(dialog).toBeHidden();
  const saved = await f.read();
  const cost = saved.database.fields.find(
    (field: any) => field.name === "Kosten",
  );
  expect(cost.formula).toBe('round(prop("n") * prop("rate"), 2)');
  await expect(page.locator(".table-count")).toContainText("Kosten: Σ 160");
  await page.reload();
  let edit = await f.open(cost.id);
  await expect(edit.getByLabel("Formel", { exact: true })).toHaveValue(
    'round(prop("Aufwand") * prop("Satz"), 2)',
  );
  await edit.getByRole("button", { name: "Schließen", exact: true }).click();
  edit = await f.open("n");
  await edit.getByLabel("Eigenschaftsname").fill("Stunden");
  await edit.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(edit).toBeHidden();
  await expect(page.locator(".table-count")).toContainText("Kosten: Σ 160");
  edit = await f.open(cost.id);
  await expect(edit.getByLabel("Formel", { exact: true })).toHaveValue(
    'round(prop("Stunden") * prop("Satz"), 2)',
  );
  await edit.getByRole("button", { name: "Schließen", exact: true }).click();
  const db = (await f.read()).database;
  await f.command({
    action: "database.update",
    pageId: f.source.id,
    version: db.version,
    fields: db.fields,
    views: [
      {
        ...db.views[0],
        filters: [{ field: cost.id, op: "gt", value: "70" }],
        sorts: [{ field: cost.id, direction: "desc" }],
      },
    ],
  });
  await page.reload();
  await expect(page.locator(`tr[data-row-id="${f.alpha.id}"]`)).toBeVisible();
  await expect(page.locator(`tr[data-row-id="${f.beta.id}"]`)).toHaveCount(0);
  await expect(page.locator(".table-count")).toContainText("Kosten: Σ 100");
  expect(f.errors).toEqual([]);
});

test("formula diagnostics, lazy evaluation, date examples and locked previews work", async ({
  page,
}) => {
  const f = await fixture(page, "validation");
  let edit = await f.open("legacy");
  let input = edit.getByLabel("Formel", { exact: true });
  const save = edit.getByRole("button", { name: "Speichern", exact: true });
  await input.fill('prop("Aufwand") @ 2');
  await expect(save).toBeDisabled();
  await expect(edit.getByRole("alert")).toContainText("Ungültiges Zeichen");
  await edit.getByRole("button", { name: "Fehler markieren" }).click();
  expect(
    await input.evaluate((el: HTMLTextAreaElement) =>
      el.value.slice(el.selectionStart, el.selectionEnd),
    ),
  ).toBe("@");
  await input.fill('prop("Fehlt")');
  await expect(edit.getByRole("alert")).toContainText("nicht gefunden");
  await input.fill("1 / 0");
  await expect(save).toBeEnabled();
  await expect(
    edit.getByRole("region", { name: "Formelvorschau" }).getByRole("alert"),
  ).toContainText("#DIV/0");
  await input.fill('if(false, 1 / 0, upper(prop("Status")))');
  await expect(edit.getByLabel("Formelergebnis")).toHaveText("OFFEN");
  await edit.getByLabel("Vorschaueintrag").selectOption(f.beta.id);
  await expect(edit.getByLabel("Formelergebnis")).toHaveText("#TODO");
  await input.fill("");
  await edit
    .getByLabel("Funktionen und Eigenschaften suchen")
    .fill("dateBetween");
  await edit
    .getByRole("button", {
      name: "Beispiel für dateBetween einfügen",
      exact: true,
    })
    .click();
  await expect(input).toHaveValue(/dateBetween\(/);
  await expect(save).toBeEnabled();
  await input.fill(
    'formatDate(dateAdd(prop("Termin"), 1, "days"), "DD.MM.YYYY")',
  );
  await edit.getByLabel("Vorschaueintrag").selectOption(f.alpha.id);
  await expect(edit.getByLabel("Formelergebnis")).toHaveText("24.09.2026");
  await save.click();
  await expect(edit).toBeHidden();
  await f.command({
    action: "page.update",
    pageId: f.source.id,
    patch: { locked: true },
  });
  await page.reload();
  edit = await f.open("legacy");
  input = edit.getByLabel("Formel", { exact: true });
  await expect(input).toBeDisabled();
  await expect(
    edit.getByRole("button", { name: "Speichern", exact: true }),
  ).toHaveCount(0);
  await expect(edit.getByLabel("Formelergebnis")).toHaveText("24.09.2026");
  expect(f.errors).toEqual([]);
});

test("formula conflicts preserve the draft and never overwrite a concurrent property", async ({
  page,
}) => {
  const f = await fixture(page, "conflict");
  let edit = await f.open("legacy");
  await edit.getByLabel("Formel", { exact: true }).fill('prop("Aufwand") * 3');
  const db = (await f.read()).database;
  await f.command({
    action: "database.update",
    pageId: f.source.id,
    version: db.version,
    views: db.views,
    fields: [...db.fields, { id: "remote", name: "Remote", type: "text" }],
  });
  const response = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/command") &&
      r.request().postDataJSON()?.action === "database.update",
  );
  await edit.getByRole("button", { name: "Speichern", exact: true }).click();
  expect((await response).status()).toBe(409);
  await expect(edit.getByRole("alert")).toContainText(
    "Entwurf bleibt erhalten",
  );
  await expect(edit.getByLabel("Formel", { exact: true })).toHaveValue(
    'prop("Aufwand") * 3',
  );
  expect(
    (await f.read()).database.fields.find((field: any) => field.id === "legacy")
      .formula,
  ).toBe('prop("Aufwand") * 2');
  await edit.getByRole("button", { name: "Schließen", exact: true }).click();
  // Reload makes the new database version explicit before retrying the retained expression.
  await page.reload();
  edit = await f.open("legacy");
  await edit.getByLabel("Formel", { exact: true }).fill('prop("Aufwand") * 3');
  await edit.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(edit).toBeHidden();
  const final = (await f.read()).database;
  expect(final.fields.some((field: any) => field.id === "remote")).toBe(true);
  expect(final.fields.find((field: any) => field.id === "legacy").formula).toBe(
    'prop("n") * 3',
  );
  await expect(page.locator(".table-count")).toContainText("Doppelt: Σ 18");
  expect(f.errors).toEqual([]);
});

test("time-dependent formula cells and open previews advance without data changes", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-09-23T23:59:30Z") });
  const f = await fixture(page, "clock");
  const db = (await f.read()).database;
  await f.command({
    action: "database.update",
    pageId: f.source.id,
    version: db.version,
    views: db.views,
    fields: db.fields.map((field: any) =>
      field.id === "legacy" ? { ...field, formula: 'today("UTC")' } : field,
    ),
  });
  await page.reload();
  const cell = page.locator(`tr[data-row-id="${f.alpha.id}"] td`).nth(6);
  await expect(cell).toContainText("2026-09-23");
  const edit = await f.open("legacy");
  await expect(edit.getByLabel("Formelergebnis")).toHaveText("2026-09-23");
  await page.clock.fastForward(61000);
  await expect(edit.getByLabel("Formelergebnis")).toHaveText("2026-09-24");
  await edit.getByRole("button", { name: "Schließen", exact: true }).click();
  await expect(cell).toContainText("2026-09-24");
  expect(f.errors).toEqual([]);
});
