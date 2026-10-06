import { test, expect } from "@playwright/test";

// A suggested rule sets the completion date; a workflow blocks a skipped step.
test("automations and workflow from the database menu", async ({ page }, info) => {
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
  const db = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Rules ${info.project.name}`, kind: "database" });
  const read = async () => (await page.request.get(`/api/pages/${db.id}`)).json();
  const first = await read();
  await command({
    action: "database.update",
    pageId: db.id,
    version: first.database.version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "status", name: "Status", type: "select", options: ["Offen", "In Arbeit", "Erledigt"] },
      { id: "closed", name: "Erledigt am", type: "date" },
    ],
    views: first.database.views,
  });
  const row = await command({ action: "row.create", pageId: db.id, cells: { title: "A", status: "Offen" } });
  await page.goto(`/#page=${db.id}`);
  await page.getByRole("button", { name: "Weitere Werkzeuge" }).click();
  await page.getByRole("menuitem", { name: /Automationen/ }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: /Wenn Status → Erledigt, Datum setzen/ }).click();
  await dialog.getByRole("button", { name: "Regel speichern" }).click();
  await expect(dialog.getByText("Status → Erledigt → Erledigt am = heute")).toBeVisible();
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Weitere Werkzeuge" }).click();
  await page.getByRole("menuitem", { name: /Workflow/ }).click();
  await dialog.getByLabel("Erlaubte Wechsel und Pflichtfelder festlegen").check();
  await dialog.getByLabel("Von Offen nach Erledigt").uncheck();
  await dialog.getByRole("button", { name: "Speichern" }).click();
  await expect(dialog).toBeHidden();

  const version = async () => (await read()).rows.find((r: { id: string }) => r.id === row.id).version;
  const blocked = await page.request.post("/api/command", {
    headers: { origin },
    data: { action: "row.update", pageId: db.id, rowId: row.id, version: await version(), cells: { status: "Erledigt" } },
  });
  expect(blocked.status()).toBe(400);
  expect((await blocked.json()).error).toMatch(/nicht vorgesehen/);
  await command({ action: "row.update", pageId: db.id, rowId: row.id, version: await version(), cells: { status: "In Arbeit" } });
  await command({ action: "row.update", pageId: db.id, rowId: row.id, version: await version(), cells: { status: "Erledigt" } });
  const after = (await read()).rows.find((r: { id: string }) => r.id === row.id);
  expect(after.cells.closed).toBe(new Date().toISOString().slice(0, 10));
  expect(errors).toEqual([]);
});
