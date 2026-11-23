import { test, expect, type Page } from "@playwright/test";

// #445: on a board with swimlanes (here by person, as with the Tasks
// setup's "Assignee"), a card dragged into an empty cell – its lane has no
// card in that column yet – was refused with "Die Gruppenzuordnung wurde
// geändert", shown as "This was just changed elsewhere".
test.skip(({ isMobile }) => isMobile, "Maus-Ziehen");

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
  // The Tasks setup's board, with swimlanes by the assignee.
  const first = await read();
  await command({
    action: "database.update",
    pageId: db.id,
    version: first.database.version,
    fields: first.database.fields,
    views: first.database.views.map((v: { id: string }) => (v.id === "board" ? { ...v, subGroupBy: "assignee" } : v)),
  });
  return { db, boot, command, read };
}
async function drag(page: Page, card: ReturnType<Page["locator"]>, cell: ReturnType<Page["locator"]>) {
  await card.hover();
  await page.mouse.down();
  const box = (await cell.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 12 });
  await page.mouse.move(box.x + box.width / 2 + 2, box.y + box.height / 2 + 2, { steps: 2 });
  await page.mouse.up();
}

test("a card moves into an empty cell of its swimlane", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { db, boot, command, read } = await setup(page, `Swimlanes ${info.project.name} ${Date.now()}`);
  await command({ action: "row.create", pageId: db.id, cells: { title: "Karte", status: "Nicht begonnen", assignee: boot.user.id } });
  await page.goto(`/#page=${db.id}`);
  await page.getByRole("button", { name: "Board", exact: true }).first().click();
  const lane = page.getByRole("region", { name: `Swimlane ${boot.user.name}` });
  const cell = (column: string) => lane.getByRole("group", { name: `${column} · ${boot.user.name}`, exact: true });
  await expect(cell("Nicht begonnen").locator(".record-card")).toHaveCount(1, { timeout: 30_000 });
  await expect(cell("In Arbeit").locator(".record-card")).toHaveCount(0);
  const answer = page.waitForResponse((r) => r.url().endsWith("/api/command") && (r.request().postData() || "").includes('"row.move"'));
  await drag(page, cell("Nicht begonnen").locator(".record-card", { hasText: "Karte" }), cell("In Arbeit"));
  expect((await answer).status()).toBe(200);
  await expect(cell("In Arbeit").locator(".record-card", { hasText: "Karte" })).toBeVisible();
  await expect(cell("Nicht begonnen").locator(".record-card")).toHaveCount(0);
  await expect(page.locator(".toast-error")).toHaveCount(0);
  await expect.poll(async () => (await read()).rows[0].cells.status).toBe("In Arbeit");
  expect((await read()).rows[0].cells.assignee).toBe(boot.user.id);
  expect(errors).toEqual([]);
});

// Someone else moved another card meanwhile and this tab has no live
// updates (a proxy that cuts the event stream): the move still goes
// through, with the current versions, instead of "changed elsewhere".
test("a move after someone else's change goes through without live updates", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/api/live**", (route) => route.abort());
  const { db, boot, command, read } = await setup(page, `Stale ${info.project.name} ${Date.now()}`);
  for (const title of ["Eins", "Zwei"]) await command({ action: "row.create", pageId: db.id, cells: { title, status: "Nicht begonnen", assignee: boot.user.id } });
  await page.goto(`/#page=${db.id}`);
  await page.getByRole("button", { name: "Board", exact: true }).first().click();
  const lane = page.getByRole("region", { name: `Swimlane ${boot.user.name}` });
  const cell = (column: string) => lane.getByRole("group", { name: `${column} · ${boot.user.name}`, exact: true });
  await expect(cell("Nicht begonnen").locator(".record-card")).toHaveCount(2, { timeout: 30_000 });
  // "Another tab": moves Zwei to the top of its cell and edits Eins' priority.
  const now = await read();
  const zwei = now.rows.find((r: { cells: { title: string } }) => r.cells.title === "Zwei");
  const eins = now.rows.find((r: { cells: { title: string } }) => r.cells.title === "Eins");
  const key = (v: string) => JSON.stringify(v);
  await command({ action: "row.move", pageId: db.id, viewId: "board", version: now.database.version, rowId: zwei.id, rowVersion: zwei.version, placement: "start", group: { from: key("Nicht begonnen"), to: key("Nicht begonnen") }, subgroup: { from: key(boot.user.id), to: key(boot.user.id) } });
  await command({ action: "row.update", pageId: db.id, rowId: eins.id, version: eins.version, cells: { priority: "Hoch" } });
  const answers: number[] = [];
  page.on("response", (r) => {
    if (r.url().endsWith("/api/command") && (r.request().postData() || "").includes('"row.move"')) answers.push(r.status());
  });
  await drag(page, cell("Nicht begonnen").locator(".record-card", { hasText: "Eins" }), cell("In Arbeit"));
  await expect.poll(async () => (await read()).rows.find((r: { id: string }) => r.id === eins.id).cells.status).toBe("In Arbeit");
  const after = (await read()).rows.find((r: { id: string }) => r.id === eins.id).cells;
  expect(after.priority).toBe("Hoch");
  expect(answers).toEqual([409, 200]);
  await expect(page.locator(".toast-error")).toHaveCount(0);
  expect(errors).toEqual([]);
});
