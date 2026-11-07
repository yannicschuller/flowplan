import { test, expect } from "@playwright/test";

// "Export → CSV (current view)" writes what the view shows: its visible
// properties in view order, people by name and related records by title
// instead of internal ids. Importing the file again links the same person
// and the same records.
test("CSV of the current view has its columns and readable names, and imports back", async ({ page }, info) => {
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
  const stamp = `${info.project.name} ${Date.now()}`;
  const create = (title: string) =>
    command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title, kind: "database" });
  const clinics = (await create(`Stellen ${stamp}`)).id;
  const db = (await create(`Überweisungen ${stamp}`)).id;
  const schema = async (id: string) => (await (await page.request.get(`/api/pages/${id}`)).json()).database;
  const clinicSchema = await schema(clinics);
  const clinicTitle = clinicSchema.fields[0].id;
  const north = (await command({ action: "row.create", pageId: clinics, cells: { [clinicTitle]: "Klinik Nord" } })).id;
  const south = (await command({ action: "row.create", pageId: clinics, cells: { [clinicTitle]: "Praxis Süd, Haus 2" } })).id;
  await command({
    action: "database.update",
    pageId: db,
    version: (await schema(db)).version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "note", name: "Interne Notiz", type: "text" },
      { id: "to", name: "Überwiesen an", type: "relation", relationPage: clinics },
      { id: "owner", name: "Zuständig", type: "person" },
      { id: "due", name: "Termin", type: "date" },
    ],
    views: [
      {
        id: "table",
        name: "Tabelle",
        type: "table",
        filters: [],
        sorts: [],
        hiddenFields: ["note"],
        fieldOrder: ["title", "owner", "to", "due", "note"],
      },
    ],
  });
  const me = boot.user.id;
  await command({ action: "row.create", pageId: db, cells: { title: "A. Muster", note: "nur intern", to: [north, south], owner: me, due: "2026-11-20" } });
  await command({ action: "row.create", pageId: db, cells: { title: "B. Beispiel", note: "vertraulich" } });

  await page.goto(`/#page=${db}`);
  const welcome = page.getByRole("dialog", { name: "Willkommen bei Flowplan" });
  await welcome.waitFor({ timeout: 3000 }).then(() => page.keyboard.press("Escape"), () => {});
  await expect(page.getByText("A. Muster").first()).toBeVisible();
  await page.getByRole("button", { name: "Exportieren", exact: true }).click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("menuitem", { name: "CSV (aktuelle Ansicht)" }).click(),
  ]);
  const csv = await (await import("node:fs/promises")).readFile((await download.path())!, "utf8");
  // The visible columns in view order; the hidden note stays out.
  expect(csv.split("\r\n")).toEqual([
    "Name,Zuständig,Überwiesen an,Termin",
    `A. Muster,${boot.user.name},"Klinik Nord, Praxis Süd, Haus 2",2026-11-20`,
    "B. Beispiel,,,",
  ]);
  expect(csv).not.toContain("nur intern");
  expect(csv).not.toContain(me);
  expect(csv).not.toContain(north);

  // The same file imported again: the person and the records are linked.
  await page.locator('input[type=file][accept*=".csv"]').setInputFiles({ name: "Überweisungen.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  type Row = { cells: Record<string, unknown> };
  const rows = async () => ((await (await page.request.get(`/api/pages/${db}`)).json()).rows as Row[]);
  await expect.poll(async () => (await rows()).length).toBe(4);
  const copy = (await rows()).filter((r) => r.cells.title === "A. Muster");
  expect(copy).toHaveLength(2);
  for (const r of copy) {
    expect(r.cells.owner).toBe(me);
    expect(r.cells.to).toEqual([north, south]);
    expect(r.cells.due).toBe("2026-11-20");
  }
  await page.screenshot({ path: `test-results/csv-export-view-${info.project.name}.png` });
  expect(errors).toEqual([]);
});
