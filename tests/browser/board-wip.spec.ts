import { test, expect } from "@playwright/test";

// A board column over its WIP limit is marked.
test("board columns show their WIP limit", async ({ page }, info) => {
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
  const db = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Board ${info.project.name}`, kind: "database" });
  const first = await (await page.request.get(`/api/pages/${db.id}`)).json();
  await command({
    action: "database.update",
    pageId: db.id,
    version: first.database.version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "status", name: "Status", type: "select", options: ["Offen", "In Arbeit"] },
    ],
    views: [{ id: "board", name: "Board", type: "board", groupBy: "status", filters: [], sorts: [], wip: { [JSON.stringify("In Arbeit")]: { max: 1 } } }],
  });
  for (const title of ["A", "B"]) await command({ action: "row.create", pageId: db.id, cells: { title, status: "In Arbeit" } });
  await page.goto(`/#page=${db.id}`);
  const column = page.getByRole("region", { name: "Gruppe In Arbeit" });
  await expect(column.locator(".wip-count.over")).toHaveText("2/1", { timeout: 30_000 });
  expect(errors).toEqual([]);
});
