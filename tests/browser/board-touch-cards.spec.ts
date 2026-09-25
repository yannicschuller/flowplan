import { test, expect } from "@playwright/test";

test("touch devices drag board cards into another column", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "mobile",
    "Touch drag is for touch devices.",
  );
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", {
      headers: { origin },
      data,
    });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const p = await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    title: `Touch Board ${Date.now()}`,
    kind: "database",
  });
  const read = async () =>
    (await page.request.get(`/api/pages/${p.id}`)).json();
  await command({
    action: "database.update",
    pageId: p.id,
    version: (await read()).database.version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      {
        id: "status",
        name: "Status",
        type: "select",
        options: ["Offen", "Fertig"],
      },
    ],
    views: [
      {
        id: "board",
        name: "Board",
        type: "board",
        filters: [],
        sorts: [],
        groupBy: "status",
        groupSettings: { hideEmpty: false, sort: "manual", collapsed: [] },
      },
    ],
  });
  for (const [title, status] of [
    ["Alpha", "Offen"],
    ["Beta", "Fertig"],
    ["Gamma", "Fertig"],
  ])
    await command({
      action: "row.create",
      pageId: p.id,
      cells: { title, status },
    });
  await page.goto(`/#page=${p.id}`);
  const done = page.getByRole("region", { name: "Gruppe Fertig", exact: true });
  await expect(done.locator(".record-card")).toHaveCount(2);
  const cdp = await page.context().newCDPSession(page);
  const touch = (type: "touchStart" | "touchMove" | "touchEnd", x = 0, y = 0) =>
    cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: type === "touchEnd" ? [] : [{ x, y }],
    });
  const handle = page.getByRole("button", {
    name: "Eintrag verschieben: Alpha",
    exact: true,
  });
  await handle.scrollIntoViewIfNeeded();
  const from = (await handle.boundingBox())!;
  const target = done.locator(".record-card-wrap[data-row-id]").first();
  await touch("touchStart", from.x + from.width / 2, from.y + from.height / 2);
  // Move towards the right edge until the target column is on screen.
  const width = page.viewportSize()!.width;
  for (let i = 1; i <= 6; i++)
    await touch(
      "touchMove",
      from.x + ((width - 6 - from.x) * i) / 6,
      from.y + from.height / 2,
    );
  await expect
    .poll(async () => {
      const box = await target.boundingBox();
      return box ? box.x + box.width / 2 : Infinity;
    })
    .toBeLessThan(width - 20);
  await page.waitForTimeout(300);
  const box = (await target.boundingBox())!;
  for (let i = 1; i <= 4; i++)
    await touch(
      "touchMove",
      Math.min(box.x + box.width / 2, width - 60),
      box.y + 5 + i,
    );
  await expect(target).toHaveClass(/order-drop-before/);
  await touch("touchEnd");
  await expect
    .poll(async () => {
      const rows = (await read()).rows;
      return rows.find(
        (r: { cells: { title: string } }) => r.cells.title === "Alpha",
      ).cells.status;
    })
    .toBe("Fertig");
  await expect(done.locator(".record-card")).toHaveCount(3);
  await expect(done.locator(".record-card strong").first()).toHaveText("Alpha");
  // A tap without movement still opens the position dialog.
  await page
    .getByRole("button", { name: "Eintrag verschieben: Beta", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Eintrag verschieben", exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
  await command({ action: "page.delete", pageId: p.id });
});
