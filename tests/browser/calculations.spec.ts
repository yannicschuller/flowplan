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
  const name = `Calculations ${kind} ${test.info().project.name} ${Date.now()}`;
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
    kind: "database",
    title: name,
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
      { id: "constructor", name: "Importierte Zahl", type: "number" },
      { id: "__proto__", name: "Importierte leere Spalte", type: "number" },
      {
        id: "status",
        name: "Status",
        type: "select",
        options: ["Offen", "Fertig"],
      },
      { id: "check", name: "Erledigt", type: "checkbox" },
      { id: "tags", name: "Tags", type: "multiselect", options: ["A", "B"] },
      { id: "date", name: "Termin", type: "date" },
      {
        id: "formula",
        name: "Kehrwert",
        type: "formula",
        formula: '10 / prop("n")',
      },
    ],
    views: [
      { id: "table", name: "Tabelle", type: "table", filters: [], sorts: [] },
      { id: "other", name: "Andere", type: "table", filters: [], sorts: [] },
    ],
  });
  for (const cells of [
    {
      title: "Alpha",
      n: 2,
      constructor: 5,
      status: "Offen",
      check: true,
      tags: ["A", "B"],
      date: "2026-09-23",
    },
    {
      title: "Beta",
      n: 4,
      status: "Offen",
      check: false,
      tags: ["A"],
      date: "2026-09-25",
    },
    { title: "Gamma", n: 0, status: "Fertig", tags: [] },
    { title: "Delta", status: "Fertig" },
  ])
    await command({ action: "row.create", pageId: source.id, cells });
  await page.goto(`/#page=${source.id}`);
  const footer = page.locator(".column-calculations");
  await expect(footer).toBeVisible();
  const open = async (name: string) => {
    await footer
      .getByRole("button", { name: `Berechnung für ${name}`, exact: true })
      .click();
    return page.getByRole("dialog", {
      name: `Berechnung: ${name}`,
      exact: true,
    });
  };
  const configure = async (
    name: string,
    choice: string,
    expected: string | RegExp,
  ) => {
    const dialog = await open(name);
    await dialog.getByLabel("Spaltenberechnung").selectOption(choice);
    await expect(dialog.getByLabel("Berechnungsergebnis")).toHaveText(expected);
    await dialog
      .getByRole("button", { name: "Speichern", exact: true })
      .click();
    await expect(dialog).toBeHidden();
  };
  const updateView = async (patch: Record<string, unknown>) => {
    const db = (await read()).database;
    await command({
      action: "database.update",
      pageId: source.id,
      version: db.version,
      fields: db.fields,
      views: db.views.map((v: any) =>
        v.id === "table" ? { ...v, ...patch } : v,
      ),
    });
    await page.reload();
    await expect(footer).toBeVisible();
  };
  return { source, read, command, footer, open, configure, updateView, errors };
}

test("column calculations persist per view, follow filters and groups and align with visible columns", async ({
  page,
}, info) => {
  const f = await fixture(page, "views");
  await f.configure("Aufwand", "average", "Ø 2");
  await expect(f.footer).toContainText("Aufwand: Ø 2");
  await page.getByPlaceholder("Suchen …", { exact: true }).fill("Alpha");
  await expect(f.footer).toContainText("Aufwand: Ø 2");
  await page.getByPlaceholder("Suchen …", { exact: true }).fill("Beta");
  await expect(f.footer).toContainText("Aufwand: Ø 4");
  await page.getByPlaceholder("Suchen …", { exact: true }).fill("");
  await page
    .locator(".database-tabs")
    .getByRole("button", { name: "Andere", exact: true })
    .click();
  await expect(f.footer).toContainText("Aufwand: Σ 6");
  await page
    .locator(".database-tabs")
    .getByRole("button", { name: "Tabelle", exact: true })
    .click();
  await expect(f.footer).toContainText("Aufwand: Ø 2");
  await f.updateView({
    groupBy: "status",
    filters: [{ field: "n", op: "gt", value: "0" }],
  });
  const group = page.getByRole("rowgroup", {
    name: "Gruppe Offen",
    exact: true,
  });
  await expect(group.locator(".group-summary")).toContainText("Aufwand: Ø 3");
  await group
    .getByRole("button", { name: "Gruppe Offen einklappen", exact: true })
    .click();
  await expect(group.locator(".title-cell")).toHaveCount(0);
  await expect(f.footer).toContainText("Aufwand: Ø 3");
  await f.updateView({
    fieldOrder: ["n", "title", "date", "check", "tags", "status", "formula"],
    hiddenFields: ["date"],
  });
  await expect(f.footer.getByRole("button").first()).toHaveAttribute(
    "aria-label",
    "Berechnung für Aufwand",
  );
  await expect(
    f.footer.getByRole("button", { name: "Berechnung für Termin" }),
  ).toHaveCount(0);
  const dialog = await f.open("Aufwand");
  await expect(dialog.getByLabel("Spaltenberechnung")).toHaveValue("average");
  await page.screenshot({
    path: `test-results/calculations-verification/dialog-${info.project.name}.png`,
    animations: "disabled",
  });
  expect(
    await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
  ).toBe(true);
  await dialog.getByRole("button", { name: "Schließen", exact: true }).click();
  expect((await f.read()).database.views[0].calculations.n).toBe("average");
  expect(f.errors).toEqual([]);
});

test("column counts, percentages, dates and formula failures show accurate previews and locked results", async ({
  page,
}) => {
  const f = await fixture(page, "types");
  await f.configure("Name", "count", "Einträge zählen 4");
  await f.configure("Importierte Zahl", "sum", "Σ 5");
  await f.configure(
    "Importierte leere Spalte",
    "count_empty",
    "Leere Werte zählen 4",
  );
  expect((await f.read()).database.views[0].calculations["__proto__"]).toBe(
    "count_empty",
  );
  await f.configure("Aufwand", "count_empty", "Leere Werte zählen 1");
  await f.configure("Erledigt", "percent_checked", /Anteil abgehakt 25\s?%/);
  await f.configure("Tags", "count_unique", "Eindeutige Werte zählen 2");
  await f.configure("Termin", "date_range", "Zeitraum in Tagen 2");
  await f.configure("Kehrwert", "average", "Ø 3,75 (2 fehlerhaft)");
  await f.configure("Kehrwert", "none", "Keine Berechnung");
  await expect(
    f.footer.getByRole("button", { name: "Berechnung für Kehrwert" }),
  ).toHaveText("Berechnen");
  await page
    .getByPlaceholder("Suchen …", { exact: true })
    .fill("No matching entry");
  await expect(f.footer).toContainText("Einträge zählen 0");
  await expect(f.footer).toContainText("Zeitraum in Tagen Keine Werte");
  await page.getByPlaceholder("Suchen …", { exact: true }).fill("");
  await f.command({
    action: "page.update",
    pageId: f.source.id,
    patch: { locked: true },
  });
  await page.reload();
  const dialog = await f.open("Erledigt");
  await expect(dialog.getByLabel("Spaltenberechnung")).toBeDisabled();
  await expect(dialog.getByLabel("Berechnungsergebnis")).toHaveText(
    /Anteil abgehakt 25\s?%/,
  );
  await expect(
    dialog.getByRole("button", { name: "Speichern", exact: true }),
  ).toHaveCount(0);
  expect(f.errors).toEqual([]);
});

test("concurrent calculation changes retain local choices and preserve remote configuration", async ({
  page,
}) => {
  const f = await fixture(page, "conflicts");
  let dialog = await f.open("Aufwand");
  await dialog.getByLabel("Spaltenberechnung").selectOption("median");
  const db = (await f.read()).database;
  await f.command({
    action: "database.update",
    pageId: f.source.id,
    version: db.version,
    fields: db.fields,
    views: db.views.map((v: any) =>
      v.id === "table"
        ? { ...v, calculations: { title: "count", n: "max" } }
        : v,
    ),
  });
  const response = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/command") &&
      r.request().postDataJSON()?.action === "database.update",
  );
  await dialog.getByRole("button", { name: "Speichern", exact: true }).click();
  expect((await response).status()).toBe(409);
  await expect(dialog.getByRole("alert")).toContainText(
    "Auswahl bleibt erhalten",
  );
  await expect(dialog.getByLabel("Spaltenberechnung")).toHaveValue("median");
  expect((await f.read()).database.views[0].calculations).toEqual({
    title: "count",
    n: "max",
  });
  await dialog.getByRole("button", { name: "Schließen", exact: true }).click();
  await page.reload();
  dialog = await f.open("Aufwand");
  await expect(dialog.getByLabel("Spaltenberechnung")).toHaveValue("max");
  await dialog.getByLabel("Spaltenberechnung").selectOption("median");
  await dialog.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect((await f.read()).database.views[0].calculations).toEqual({
    title: "count",
    n: "median",
  });
  await f.configure("Aufwand", "auto", "Σ 6");
  expect((await f.read()).database.views[0].calculations).toEqual({
    title: "count",
  });
  const longName = "Eigenschaft" + "x".repeat(150);
  const current = (await f.read()).database;
  await f.command({
    action: "database.update",
    pageId: f.source.id,
    version: current.version,
    fields: current.fields.map((field: any) =>
      field.id === "n" ? { ...field, name: longName } : field,
    ),
    views: current.views,
  });
  await page.reload();
  const longDialog = await f.open(longName);
  await expect(longDialog.getByLabel("Berechnungsergebnis")).toHaveText("Σ 6");
  expect(
    await longDialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
  ).toBe(true);
  await page.screenshot({
    path: `test-results/calculations-verification/long-name-${test.info().project.name}.png`,
    animations: "disabled",
  });
  expect(f.errors).toEqual([]);
});
