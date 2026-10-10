import { test, expect } from "@playwright/test";

// Records move to another database by right-click or by dragging them
// onto the database in the sidebar.
test("move records between databases by menu and by drag and drop", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Right-click and drag and drop are desktop actions.");
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
  const source = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Eingang ${stamp}`, kind: "database" });
  const target = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Ziel ${stamp}`, kind: "database" });
  await command({ action: "row.create", pageId: source.id, cells: { title: "Per Menü" } });
  const dragged = await command({ action: "row.create", pageId: source.id, cells: { title: "Per Ziehen" } });
  const rowsOf = async (id: string) => ((await (await page.request.get(`/api/pages/${id}`)).json()).rows as { id: string; cells: { title: string } }[]).map((r) => r.cells.title);

  await page.goto(`/#page=${source.id}`);
  await page.locator("tr", { hasText: "Per Menü" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Verschieben nach …" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("radio", { name: `Ziel ${stamp}` }).check();
  await dialog.getByRole("button", { name: "Verschieben", exact: true }).click();
  await expect(page.getByText(`nach „Ziel ${stamp}“ verschoben`)).toBeVisible();
  await expect.poll(() => rowsOf(target.id)).toEqual(["Per Menü"]);

  // Dragging the row handle onto the target database in the sidebar.
  const handle = page.locator(`tr[data-row-id="${dragged.id}"] .row-order-handle`);
  await handle.dragTo(page.locator(`.page-nav[data-page-id="${target.id}"]`));
  await expect.poll(() => rowsOf(target.id)).toEqual(["Per Menü", "Per Ziehen"]);
  await expect.poll(() => rowsOf(source.id)).toEqual([]);
  expect(errors).toEqual([]);
});
