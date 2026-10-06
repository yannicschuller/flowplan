import { test, expect } from "@playwright/test";

// Start/stop and adding time in the record; the report lists it.
test("time tracking in the record and the report", async ({ page }, info) => {
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
  const db = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Zeit ${info.project.name}`, kind: "database" });
  const first = await (await page.request.get(`/api/pages/${db.id}`)).json();
  await command({
    action: "database.update",
    pageId: db.id,
    version: first.database.version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "est", name: "Schätzung", type: "number" },
      { id: "spent", name: "Aufwand", type: "time", estimateField: "est" },
    ],
    views: first.database.views,
  });
  const row = await command({ action: "row.create", pageId: db.id, cells: { title: "Angebot", est: 1 } });
  await page.goto(`/#page=${db.id}&row=${row.id}`);
  const time = page.getByRole("region", { name: "Aufwand" });
  await time.getByRole("button", { name: "Start" }).click();
  await expect(time.getByRole("button", { name: /Stopp/ })).toBeVisible();
  await time.getByRole("button", { name: /Stopp/ }).click();
  await time.getByLabel(/Dauer/).fill("1:30");
  await time.getByRole("button", { name: "Nachtragen" }).click();
  await expect(time.locator(".record-time-head strong")).toHaveText(/1 h 30 min/);
  await expect(time.locator(".record-time-head strong")).toHaveClass(/over/);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Weitere Werkzeuge" }).click();
  await page.getByRole("menuitem", { name: "Zeiten auswerten" }).click();
  await expect(page.getByRole("dialog").getByText("1,5", { exact: true }).first()).toBeVisible();
  expect(errors).toEqual([]);
});
