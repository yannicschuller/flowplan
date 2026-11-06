import { test, expect } from "@playwright/test";

// A database exported as CSV and imported again keeps its values: the
// apostrophe before formula-like text comes off, and a tag with a comma in
// its name stays one tag.
test("CSV export and import round-trip formula-like text and tags with commas", async ({ page }, info) => {
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
  const database = (await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Dienste ${stamp}`, kind: "database" })).id;
  const schema = async () => (await (await page.request.get(`/api/pages/${database}`)).json()).database;
  const before = await schema();
  const both = `Nacht, Wochenende ${stamp}`;
  const day = `Tag ${stamp}`;
  await command({
    action: "database.update",
    pageId: database,
    version: before.version,
    fields: [...before.fields, { id: "schicht", name: "Schicht", type: "multiselect", options: [both, day], tagOptions: true }],
    views: before.views,
  });
  const title = before.fields[0].id;
  const values = [
    { [title]: "+1 805 555 0100", schicht: [both, day] },
    { [title]: "=Summe gefälscht", schicht: [day] },
    { [title]: "'hallo", schicht: [] },
  ];
  for (const cells of values) await command({ action: "row.create", pageId: database, cells });

  await page.goto(`/#page=${database}`);
  const welcome = page.getByRole("dialog", { name: "Willkommen bei Flowplan" });
  await welcome.waitFor({ timeout: 3000 }).then(() => page.keyboard.press("Escape"), () => {});
  await expect(page.getByText("+1 805 555 0100").first()).toBeVisible();
  await page.getByRole("button", { name: "Exportieren", exact: true }).click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("menuitem", { name: "CSV (aktuelle Ansicht)" }).click(),
  ]);
  const csv = await (await import("node:fs/promises")).readFile((await download.path())!, "utf8");
  // The export still protects spreadsheets.
  expect(csv).toContain(`"'+1 805 555 0100"`);
  expect(csv).toContain(`"${both}, ${day}"`);

  await page.locator('input[type=file][accept*=".csv"]').setInputFiles({ name: "Dienste.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  const rows = async () =>
    ((await (await page.request.get(`/api/pages/${database}`)).json()).rows as { cells: Record<string, unknown> }[]).map((r) => ({
      [title]: r.cells[title],
      schicht: r.cells.schicht ?? [],
    }));
  await expect.poll(async () => (await rows()).length).toBe(6);
  const sorted = (list: Record<string, unknown>[]) => list.map((r) => JSON.stringify(r)).sort();
  expect(sorted(await rows())).toEqual(sorted([...values, ...values]));
  // No tags split off the one with a comma.
  const tags = ((await (await page.request.get("/api/bootstrap")).json()).taxonomy.tags as { name: string }[]).map((t) => t.name);
  expect(tags).toContain(both);
  expect(tags).not.toContain(`Wochenende ${stamp}`);
  await page.screenshot({ path: `test-results/csv-round-trip-${info.project.name}.png` });
  expect(errors).toEqual([]);
});
