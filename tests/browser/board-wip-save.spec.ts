import { test, expect } from "@playwright/test";

// Issue #131: a WIP limit is saved on Enter, and when the "Configure view"
// panel closes while the field still has focus.
test("board WIP limits save on Enter and when the panel closes", async ({ page }, info) => {
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
  const db = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `WIP ${info.project.name}`, kind: "database" });
  const first = await (await page.request.get(`/api/pages/${db.id}`)).json();
  await command({
    action: "database.update",
    pageId: db.id,
    version: first.database.version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "status", name: "Status", type: "select", options: ["Offen", "In Arbeit"] },
    ],
    views: [{ id: "board", name: "Board", type: "board", groupBy: "status", filters: [], sorts: [] }],
  });
  await command({ action: "row.create", pageId: db.id, cells: { title: "A", status: "In Arbeit" } });
  const wip = async () => (await (await page.request.get(`/api/pages/${db.id}`)).json()).database.views[0].wip;
  await page.goto(`/#page=${db.id}`);
  const settings = page.getByRole("dialog", { name: "Ansicht konfigurieren", exact: true });
  await page.getByTitle("Ansicht und Eigenschaften", { exact: true }).click();
  // Enter saves.
  const open = settings.getByLabel("Limit für Offen", { exact: true });
  await open.fill("3");
  await open.press("Enter");
  await expect.poll(wip, { timeout: 15_000 }).toEqual({ [JSON.stringify("Offen")]: { max: 3 } });
  // Closing the panel with Escape while the field has focus saves too.
  const busy = settings.getByLabel("Limit für In Arbeit", { exact: true });
  await busy.fill("2");
  await expect(busy).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();
  await expect.poll(wip, { timeout: 15_000 }).toEqual({ [JSON.stringify("Offen")]: { max: 3 }, [JSON.stringify("In Arbeit")]: { max: 2 } });
  await expect(page.getByRole("region", { name: "Gruppe In Arbeit" }).locator(".wip-count")).toHaveText("1/2");
  expect(errors).toEqual([]);
});
